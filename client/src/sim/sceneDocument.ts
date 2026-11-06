/** Portable scenery: local metre coordinates (X east, Y up, Z south).
 * Model sources are embedded so a saved scene never depends on temporary URLs. */
export type Triple = [number, number, number];
export type BuiltinSceneKind = 'runway' | 'hangar' | 'tree';
export type SceneObject = {
  id: string; assetId?: string; builtin?: BuiltinSceneKind; seed?: number; name: string; visible: boolean;
  collision?: boolean; position: Triple; rotation: Triple; scale: Triple; // Euler XYZ, degrees
};
export type SceneAsset = { id: string; entry: string; files: { path: string; data: string }[] };
export type SceneSourceFile = SceneAsset['files'][number];
export type SceneDocument = {
  format: 'jsbsim-flight-scene'; version: 2; name: string;
  georeference?: { latitude: number; longitude: number; altitude: number }; collisionRadius?: number;
  groundAltitude: number | null; showBase: boolean; assets: SceneAsset[]; objects: SceneObject[];
};
export const MAX_SCENE_BYTES = 140 * 1024 * 1024;
export function defaultSceneTransform(object: Pick<SceneObject, 'builtin' | 'seed'>): Pick<SceneObject, 'position' | 'rotation' | 'scale'> {
  let position: Triple = [0, 0, 0], scale: Triple = [1, 1, 1];
  if (object.builtin === 'runway') position = [50, .025, -100];
  if (object.builtin === 'hangar') position = [-35, 0, -50];
  if (object.builtin === 'tree') {
    const i = object.seed ?? 0, size = .8 + (Math.sin(i * 7.7) + 1) * .25;
    position = [i % 2 ? 115 + Math.sin(i * 17.1) * 38 : -105 + Math.sin(i * 17.1) * 35,
      0, 15 - (i / 32) * 380 + Math.cos(i * 13.3) * 12];
    scale = [size, size, size];
  }
  return { position, rotation: [0, 0, 0], scale };
}
export function defaultSceneObjects(): SceneObject[] {
  const objects: SceneObject[] = [
    { id: 'builtin-runway', builtin: 'runway', name: '跑道', visible: true, ...defaultSceneTransform({ builtin: 'runway' }) },
    { id: 'builtin-hangar', builtin: 'hangar', name: '机库', visible: true, ...defaultSceneTransform({ builtin: 'hangar' }) },
  ];
  for (let i = 0; i < 32; i++) objects.push({ id: `builtin-tree-${i + 1}`, builtin: 'tree', seed: i,
    name: `树木 ${String(i + 1).padStart(2, '0')}`, visible: true, ...defaultSceneTransform({ builtin: 'tree', seed: i }) });
  return objects;
}
export const newSceneDocument = (): SceneDocument => ({
  format: 'jsbsim-flight-scene', version: 2, name: '我的场景', groundAltitude: null,
  showBase: true, assets: [], objects: defaultSceneObjects(),
});

export function scenePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('资源路径超出导入目录'); parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

export function resolveSceneResource(entry: string, uri: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(uri)) throw new Error(`仅支持随模型导入的本地资源：${uri}`);
  return scenePath(entry.slice(0, entry.lastIndexOf('/') + 1) + decodeURIComponent(uri));
}

export function validateSceneDocument(value: unknown): SceneDocument {
  const raw = value as Omit<SceneDocument, 'version'> & { version: number };
  const fail = (reason: string): never => { throw new Error(`场景文件无效：${reason}`); };
  if (!raw || raw.format !== 'jsbsim-flight-scene' || ![1, 2].includes(raw.version)) fail('不支持的格式或版本');
  if (!Array.isArray(raw.objects)) fail('物体列表');
  // Version 1 rendered these objects outside the document. Version 2 owns
  // the complete list, including an intentionally empty/deleted default set.
  const doc: SceneDocument = { ...raw, version: 2, objects: raw.version === 1 ? [...defaultSceneObjects(), ...raw.objects] : raw.objects };
  if (typeof doc.name !== 'string' || doc.name.length > 200 || typeof doc.showBase !== 'boolean'
    || !(doc.groundAltitude === null || (typeof doc.groundAltitude === 'number' && Number.isFinite(doc.groundAltitude)))) fail('场景设置');
  if (!Array.isArray(doc.assets) || !Array.isArray(doc.objects) || doc.assets.length > 200 || doc.objects.length > 1000) fail('物体或资源数量');
  if (doc.georeference && (!Number.isFinite(doc.georeference.latitude) || Math.abs(doc.georeference.latitude) > 90
    || !Number.isFinite(doc.georeference.longitude) || Math.abs(doc.georeference.longitude) > 180
    || !Number.isFinite(doc.georeference.altitude) || Math.abs(doc.georeference.altitude) > 100000)) fail('地理基准');
  if (doc.collisionRadius !== undefined && (!Number.isFinite(doc.collisionRadius) || doc.collisionRadius < .01 || doc.collisionRadius > 100)) fail('飞机碰撞半径');
  const ids = new Set<string>(), objectIds = new Set<string>(); let bytes = 0;
  const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
  for (const asset of doc.assets) {
    if (!asset || !validId(asset.id) || ids.has(asset.id) || typeof asset.entry !== 'string'
      || !/\.(glb|gltf)$/i.test(asset.entry) || !Array.isArray(asset.files) || !asset.files.length || asset.files.length > 2000) fail('模型资源');
    ids.add(asset.id); const paths = new Set<string>();
    for (const file of asset.files) {
      if (!file || typeof file.path !== 'string' || !file.path || file.path !== scenePath(file.path) || paths.has(file.path)
        || typeof file.data !== 'string' || !/^data:[\w.+/-]*;base64,/.test(file.data)) fail('内嵌文件');
      const base64 = file.data.slice(file.data.indexOf(',') + 1);
      if (base64.length % 4 || /[^A-Za-z0-9+/=]/.test(base64) || !/^[^=]*={0,2}$/.test(base64)) fail('内嵌文件编码');
      paths.add(file.path); bytes += file.data.length;
      if (bytes > MAX_SCENE_BYTES) fail('场景超过 140 MB');
    }
    if (!paths.has(asset.entry)) fail('缺少模型主文件');
  }
  for (const obj of doc.objects) {
    if (!obj || !validId(obj.id) || objectIds.has(obj.id)
      || typeof obj.name !== 'string' || obj.name.length > 200 || typeof obj.visible !== 'boolean') fail('物体信息或资源引用');
    if (obj.builtin !== undefined) {
      if (!['runway', 'hangar', 'tree'].includes(obj.builtin) || obj.assetId !== undefined
        || (obj.builtin === 'tree' ? !Number.isInteger(obj.seed) || obj.seed! < 0 || obj.seed! >= 32 : obj.seed !== undefined)) fail('默认地物类型或树木编号');
    } else if (typeof obj.assetId !== 'string' || !ids.has(obj.assetId) || obj.seed !== undefined) fail('模型资源引用');
    if (obj.collision !== undefined && typeof obj.collision !== 'boolean') fail('碰撞开关');
    objectIds.add(obj.id);
    for (const key of ['position', 'rotation', 'scale'] as const) {
      if (!Array.isArray(obj[key]) || obj[key].length !== 3 || !obj[key].every(n => typeof n === 'number' && Number.isFinite(n)
        && Math.abs(n) <= 1e7 && (key !== 'scale' || n >= .001))) fail('位置、旋转或缩放');
    }
  }
  return doc;
}

export async function packSceneFiles(files: File[]): Promise<SceneAsset[]> {
  if (files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) throw new Error('一次导入请控制在 100 MB 以内');
  const packed = await Promise.all(files.map(async file => ({
    path: scenePath(file.webkitRelativePath || file.name),
    data: await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error(`无法读取 ${file.name}`)); reader.readAsDataURL(file);
    }),
  })));
  return packSceneSources(packed);
}

export function packSceneSources(packed: SceneSourceFile[]): SceneAsset[] {
  if (new Set(packed.map(file => file.path)).size !== packed.length) throw new Error('文件名重复，请使用目录导入保留路径');
  const entries = packed.filter(file => /\.(glb|gltf)$/i.test(file.path));
  if (!entries.length) throw new Error('请选择 GLB/glTF 文件及其配套资源');
  // Each entry carries only the files it references; sharing unrelated entries
  // would multiply saved scene size when importing a directory of models.
  return entries.map(entry => {
    const asset = { id: crypto.randomUUID(), entry: entry.path, files: packed };
    const json = sceneAssetJson(asset);
    const needed = new Set([entry.path]);
    for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
      if (resource.uri && !resource.uri.startsWith('data:')) needed.add(resolveSceneResource(entry.path, resource.uri));
    }
    for (const path of needed) if (!packed.some(file => file.path === path)) throw new Error(`缺少资源：${path}。请同时选择配套文件，或导入整个目录。`);
    return { ...asset, files: packed.filter(file => needed.has(file.path)) };
  });
}

export function sceneAssetBytes(asset: SceneAsset): Uint8Array {
  const source = asset.files.find(file => file.path === asset.entry);
  if (!source) throw new Error(`缺少模型：${asset.entry}`);
  return Uint8Array.from(atob(source.data.slice(source.data.indexOf(',') + 1)), c => c.charCodeAt(0));
}

export function sceneAssetJson(asset: SceneAsset): any {
  const bytes = sceneAssetBytes(asset);
  if (/\.gltf$/i.test(asset.entry)) return JSON.parse(new TextDecoder().decode(bytes));
  const view = new DataView(bytes.buffer);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.length || view.getUint32(16, true) !== 0x4e4f534a
    || view.getUint32(12, true) > bytes.length - 20) throw new Error('GLB 文件头或长度无效');
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
}
