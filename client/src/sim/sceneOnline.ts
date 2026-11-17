import { sceneAssetJson, type SceneAsset, type SceneSourceFile } from './sceneDocument';

type Options = { signal: AbortSignal; report?: (message: string) => void; fetcher?: typeof fetch;
  maxBytes?: number; timeoutMs?: number };
const MAX_BYTES = 100 * 1024 * 1024;
const cancelled = () => new Error('已取消在线地景加载，保留原场景');

export function sceneModelUrl(value: string, base?: string): URL {
  let url: URL;
  try { url = new URL(value.trim(), base); } catch { throw new Error('请输入完整的 HTTP/HTTPS 模型地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持不含用户名和密码的 HTTP/HTTPS 模型地址');
  }
  if (/^(www\.)?sketchfab\.com$/i.test(url.hostname)) {
    throw new Error('这是 Sketchfab 展示页，不能直接作为飞行地景加载；请使用作者提供的 GLB/glTF 模型文件直链');
  }
  url.hash = '';
  return url;
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return `data:${mime};base64,${btoa(parts.join(''))}`;
}

/** Fetch a real model into the existing portable asset format. No iframe,
 * credentials, remote scripts or runtime dependency on expiring URLs. */
export async function downloadSceneAsset(value: string, options: Options): Promise<SceneAsset> {
  const { signal, report = () => {}, fetcher = fetch, maxBytes = MAX_BYTES, timeoutMs = 60_000 } = options;
  const initial = sceneModelUrl(value);
  let total = 0;
  const download = async (url: URL, label: string) => {
    if (signal.aborted) throw cancelled();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      report(`正在下载${label} · 合计 ${(total / 1048576).toFixed(2)} MB`);
      const response = await fetcher(url.href, { signal: controller.signal, credentials: 'omit',
        mode: 'cors', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`${label}下载失败（HTTP ${response.status}）`);
      const finalUrl = sceneModelUrl(response.url || url.href);
      if (initial.protocol === 'https:' && finalUrl.protocol !== 'https:') throw new Error('HTTPS 模型不能加载未加密的 HTTP 配套资源');
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes - total) throw new Error('在线地景及贴图合计超过 100 MB，请先优化模型');
      const chunks: Uint8Array[] = []; let length = 0;
      const append = (bytes: Uint8Array) => {
        total += bytes.byteLength; length += bytes.byteLength;
        if (total > maxBytes) throw new Error('在线地景及贴图合计超过 100 MB，请先优化模型');
        chunks.push(bytes);
        report(`正在下载${label} · 合计 ${(total / 1048576).toFixed(2)} MB`);
      };
      if (response.body) {
        reader = response.body.getReader();
        while (true) { const chunk = await reader.read(); if (chunk.done) break; append(chunk.value); }
      } else append(new Uint8Array(await response.arrayBuffer()));
      if (signal.aborted) throw cancelled();
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const mime = response.headers.get('content-type')?.split(';')[0].trim();
      return { bytes, url: finalUrl, mime: mime && /^[\w.+/-]+$/.test(mime) ? mime : 'application/octet-stream' };
    } catch (error) {
      controller.abort();
      if (signal.aborted) throw cancelled();
      if (timedOut) throw new Error('在线地景下载超时，请检查网络后重试');
      if (error instanceof TypeError) throw new Error('无法读取在线模型，请检查地址、网络和服务器跨域访问（CORS）设置');
      throw error;
    } finally {
      if (controller.signal.aborted) await reader?.cancel().catch(() => {});
      reader?.releaseLock(); clearTimeout(timer); signal.removeEventListener('abort', abort);
    }
  };

  const root = await download(initial, '模型');
  const glb = root.bytes.length >= 4 && new DataView(root.bytes.buffer).getUint32(0, true) === 0x46546c67;
  const mime = glb ? 'model/gltf-binary' : 'model/gltf+json';
  const asset: SceneAsset = { id: crypto.randomUUID(), entry: `online-scene.${glb ? 'glb' : 'gltf'}`,
    files: [{ path: `online-scene.${glb ? 'glb' : 'gltf'}`, data: dataUrl(root.bytes, mime) }] };
  let json: any;
  try { json = sceneAssetJson(asset); } catch { throw new Error('该地址未返回有效的 GLB/glTF 模型，请使用模型文件直链，不能使用商品页或普通网页'); }
  if (json?.asset?.version !== '2.0' || !Array.isArray(json.buffers ?? []) || !Array.isArray(json.images ?? [])) {
    throw new Error('在线模型必须使用有效的 glTF 2.0 格式');
  }
  for (const extension of json.extensionsRequired ?? []) {
    if (['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension)) {
      throw new Error(`在线模型使用 ${extension} 压缩，请先导出为不压缩的 GLB/glTF`);
    }
  }
  const resources = [...(json.buffers ?? []), ...(json.images ?? [])];
  if (resources.length > 1999) throw new Error('在线模型配套资源超过 1999 项');
  const files: SceneSourceFile[] = [], paths = new Map<string, string>();
  for (const resource of resources) {
    if (!resource || resource.uri === undefined) continue;
    if (typeof resource.uri !== 'string') throw new Error('模型资源地址无效');
    if (resource.uri.startsWith('data:')) continue;
    const url = sceneModelUrl(resource.uri, root.url.href);
    if (initial.protocol === 'https:' && url.protocol !== 'https:') throw new Error('HTTPS 模型不能加载未加密的 HTTP 配套资源');
    let path = paths.get(url.href);
    if (!path) {
      const downloaded = await download(url, `配套资源 ${files.length + 1}/${resources.length}`);
      const extension = /\.([a-z0-9]{1,10})$/i.exec(url.pathname)?.[1] ?? 'bin';
      path = `resources/file-${files.length + 1}.${extension}`;
      paths.set(url.href, path); files.push({ path, data: dataUrl(downloaded.bytes, downloaded.mime) });
    }
    resource.uri = path;
  }
  if (signal.aborted) throw cancelled();
  if (files.length) {
    if (glb) {
      const old = new DataView(root.bytes.buffer), tail = root.bytes.subarray(20 + old.getUint32(12, true));
      const encoded = new TextEncoder().encode(JSON.stringify(json)), padded = Math.ceil(encoded.length / 4) * 4;
      const bytes = new Uint8Array(20 + padded + tail.length), view = new DataView(bytes.buffer);
      view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
      view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true);
      bytes.fill(32, 20, 20 + padded); bytes.set(encoded, 20); bytes.set(tail, 20 + padded);
      asset.files[0].data = dataUrl(bytes, mime);
    } else asset.files[0].data = dataUrl(new TextEncoder().encode(JSON.stringify(json)), mime);
  }
  asset.files.push(...files);
  report(`已下载模型与 ${files.length} 个配套资源，正在解码…`);
  return asset;
}
