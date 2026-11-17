import { exportSceneCollision } from '../../sim/sceneCollision';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box3, Vector3, type Object3D } from 'three';
import { MAX_SCENE_BYTES, MAX_VISUAL_GROUND_OFFSET_M, newSceneDocument, newSceneWindsock, packSceneFiles, packSceneSources, validateSceneDocument, type SceneAsset, type SceneDocument, type SceneObject, type SceneSourceFile } from '../../sim/sceneDocument';
import { disposeSceneAsset, loadSceneAsset } from './sceneAssetLoader';
import { waitForSceneTask } from './sceneTask';
import { useBundledF35 } from './useBundledF35';
import { F35_MODEL_KEY } from '../../sim/sceneF35';
import { downloadSceneAsset } from '../../sim/sceneOnline';

export type TransformMode = 'translate' | 'rotate' | 'scale';
type Content = { document: SceneDocument; models: Map<string, Object3D>; automaticGeoreference?: SceneDocument['georeference'];
  placement?: { id: string; copied?: boolean; error?: string } };
type SceneTask = { loaded: Map<string, Object3D>; signal: AbortSignal; report: (message: string) => void };
const VISUAL_GROUND_OFFSET_KEY = 'jsbsim-scene-visual-ground-offset-m-v1';
function savedVisualGroundOffset(): number {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VISUAL_GROUND_OFFSET_KEY) ?? '0');
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_VISUAL_GROUND_OFFSET_M) return value;
  } catch { /* Unavailable or invalid preferences use the default display height. */ }
  return 0;
}
export function useSceneEditor() {
  const [content, setContent] = useState<Content>(() => ({ document: { ...newSceneDocument(), visualGroundOffsetM: savedVisualGroundOffset() }, models: new Map() }));
  const f35 = useBundledF35(content.document.objects.some(object => object.builtin === 'f35'));
  const models = useMemo(() => {
    const result = new Map(content.models);
    if (f35.model) result.set(F35_MODEL_KEY, f35.model);
    return result;
  }, [content.models, f35.model]);
  const [collisionSnapshot, setCollisionSnapshot] = useState<{ document: SceneDocument; revision: number } | null>(null);
  const [enabled, setEnabled] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [focusRevision, setFocusRevision] = useState(0), [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState(''), [canCancel, setCanCancel] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    const placement = content.placement;
    if (!placement) return;
    if (placement.error) { setError(placement.error); return; }
    setSelectedId(placement.id); setFocusRevision(v => v + 1); setError('');
    setNotice(placement.copied ? '已复制风袋并错开放置，可独立调整位置。' : '已添加风袋并自动错开放置，可继续添加或调整位置。');
  }, [content.placement]);
  const alive = useRef(true), lock = useRef(false), owned = useRef(content.models);
  const latestContent = useRef(content); latestContent.current = content;
  const active = useRef<AbortController | null>(null);
  const visualGroundOffset = content.document.visualGroundOffsetM ?? 0;
  useEffect(() => {
    try { localStorage.setItem(VISUAL_GROUND_OFFSET_KEY, String(visualGroundOffset)); }
    catch { /* Keep editing usable when local preferences cannot be written. */ }
  }, [visualGroundOffset]);
  useEffect(() => {
    for (const [id, model] of owned.current) if (content.models.get(id) !== model) disposeSceneAsset(model);
    owned.current = content.models;
  }, [content.models]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); for (const model of owned.current.values()) disposeSceneAsset(model); }; }, []);

  const updateDocument = (patch: Partial<SceneDocument>) => setContent(current => ({ ...current, document: { ...current.document, ...patch } }));
  // A loaded scene or a manual edit owns its datum. Only automatically filled
  // values follow model changes, unless the user explicitly chooses a reset.
  const applyModelOrigin = useCallback((georeference: SceneDocument['georeference'], force = false) => setContent(current => {
    if (!force && current.document.georeference && current.document.georeference !== current.automaticGeoreference) return current;
    if (current.document.georeference === georeference) return current;
    return { ...current, document: { ...current.document, georeference }, automaticGeoreference: georeference };
  }), []);
  const updateObject = (id: string, patch: Partial<SceneObject>) => setContent(current => ({ ...current,
    document: { ...current.document, objects: current.document.objects.map(object => object.id === id ? { ...object, ...patch } : object) },
  }));
  const removeObject = (id: string) => {
    setContent(current => {
      const objects = current.document.objects.filter(object => object.id !== id);
      const assets = current.document.assets.filter(asset => objects.some(object => object.assetId === asset.id));
      return { ...current, document: { ...current.document, objects, assets }, models: new Map([...current.models].filter(([key]) => assets.some(asset => asset.id === key))) };
    }); setSelectedId(null);
  };
  const appendWindsock = (sourceId?: string) => {
    if (content.document.objects.length >= 1000) { setError('场景最多支持 1000 个物体'); return; }
    const id = crypto.randomUUID();
    // Use the latest queued document for numbering and placement, including
    // several clicks batched into one render.
    setContent(current => {
      try {
        if (current.document.objects.length >= 1000) throw new Error('场景最多支持 1000 个物体');
        const source = current.document.objects.find(object => object.id === sourceId && object.builtin === 'windsock');
        const object = newSceneWindsock(current.document.objects, id, source);
        return { ...current, document: { ...current.document, objects: [...current.document.objects, object] }, placement: { id, copied: !!source } };
      } catch (error) { return { ...current, placement: { id, error: error instanceof Error ? error.message : String(error) } }; }
    });
  };
  const addWindsock = () => appendWindsock();
  const copyWindsock = (id: string) => appendWindsock(id);

  const run = async (message: string, operation: (task: SceneTask) => Promise<void>, cancellable = true) => {
    if (lock.current) return;
    const controller = new AbortController(); active.current = controller;
    lock.current = true; setBusy(true); setBusyMessage(message); setCanCancel(cancellable); setError(''); setNotice('');
    const loaded = new Map<string, Object3D>();
    const report = (message: string) => { if (alive.current && !controller.signal.aborted) setBusyMessage(message); };
    try { await operation({ loaded, signal: controller.signal, report }); }
    catch (e) { for (const model of loaded.values()) disposeSceneAsset(model); if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { active.current = null; lock.current = false; if (alive.current) { setBusy(false); setCanCancel(false); } }
  };
  const loadAssets = async (assets: SceneAsset[], { loaded, signal, report }: SceneTask) => {
    for (const [index, asset] of assets.entries()) {
      report(`正在读取模型与贴图（${index + 1}/${assets.length}）：${asset.entry}`);
      loaded.set(asset.id, await loadSceneAsset(asset, signal));
    }
  };
  const importAssets = (prepare: (signal: AbortSignal) => Promise<SceneAsset[]>, message: string) => run(message, async task => {
    const { loaded, signal } = task;
    const assets = await prepare(signal);
    if (!assets.length) return;
    // Sequential loading bounds peak memory and allows cleanup on any failure.
    await loadAssets(assets, task);
    if (!alive.current || signal.aborted) { for (const model of loaded.values()) disposeSceneAsset(model); return; }
    const objects: SceneObject[] = assets.map(asset => ({ id: crypto.randomUUID(), assetId: asset.id,
      name: asset.entry.split('/').pop()!.replace(/\.(glb|gltf)$/i, ''), visible: true,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }));
    // Validate the resulting size before committing any live state.
    validateSceneDocument({ ...content.document, assets: [...content.document.assets, ...assets], objects: [...content.document.objects, ...objects] });
    setContent(current => ({ ...current, document: { ...current.document, assets: [...current.document.assets, ...assets], objects: [...current.document.objects, ...objects] },
      models: new Map([...current.models, ...loaded]) }));
    setSelectedId(objects[0].id); setFocusRevision(v => v + 1); setNotice(`已导入 ${objects.length} 个物体`);
  });
  const importFiles = (files: File[]) => importAssets(signal => waitForSceneTask(packSceneFiles(files), signal, '读取导入文件'), '正在读取导入文件…');
  const importOnline = (url: string, replaceScenery = true) => run('正在连接在线模型…', async task => {
    const asset = await downloadSceneAsset(url, task);
    await loadAssets([asset], task);
    if (!alive.current || task.signal.aborted) { for (const model of task.loaded.values()) disposeSceneAsset(model); return; }
    const bounds = new Box3().setFromObject(task.loaded.get(asset.id)!);
    if (bounds.isEmpty()) throw new Error('在线模型没有可显示的网格');
    const center = bounds.getCenter(new Vector3());
    const object: SceneObject = { id: crypto.randomUUID(), assetId: asset.id, name: '在线地景', visible: true,
      position: [-center.x, -bounds.min.y, -center.z], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const current = latestContent.current;
    const objects = replaceScenery ? current.document.objects.filter(object => object.builtin === 'windsock') : current.document.objects;
    const assets = replaceScenery ? [] : current.document.assets;
    const document = validateSceneDocument({ ...current.document, showBase: replaceScenery ? false : current.document.showBase,
      objects: [...objects, object], assets: [...assets, asset] });
    setContent(current => ({ ...current, document, models: replaceScenery ? task.loaded : new Map([...current.models, ...task.loaded]) }));
    setSelectedId(object.id); setFocusRevision(v => v + 1);
    setNotice(replaceScenery ? '在线地景已加载，飞机和风袋保留。请核对位置、比例与地面高度；仿真碰撞需重新同步地图。'
      : '在线模型已添加，可编辑位置并保存场景。');
  });
  const importDirectory = () => importAssets(async signal => {
    const { invoke } = await import('@tauri-apps/api/core');
    // The native chooser may remain open while the user selects a directory.
    const files = await waitForSceneTask(invoke<SceneSourceFile[] | null>('scene_import_directory'), signal, '读取目录', undefined, 0);
    return files ? packSceneSources(files) : [];
  }, '请选择场景资源目录，正在等待读取…');
  const loadFile = (file: File, onLoaded: (altitude: number | null) => void) => run(`正在读取场景文件：${file.name}`, async task => {
    const { loaded, signal } = task;
    if (file.size > MAX_SCENE_BYTES) throw new Error('场景文件超过 140 MB');
    const document = validateSceneDocument(JSON.parse(await waitForSceneTask(file.text(), signal, `读取 ${file.name}`)));
    await loadAssets(document.assets, task);
    if (!alive.current || signal.aborted) { for (const model of loaded.values()) disposeSceneAsset(model); return; }
    // Files with an explicit offset own that value, including zero. Older
    // scenes keep the current local display preference instead of resetting it.
    setContent(current => ({ document: { ...document, visualGroundOffsetM: document.visualGroundOffsetM ?? current.document.visualGroundOffsetM ?? 0 }, models: loaded }));
    onLoaded(document.groundAltitude);
    setSelectedId(document.objects[0]?.id ?? null); setFocusRevision(v => v + 1); setNotice('场景已加载');
  });
  const save = (groundAltitude: number | null) => {
    try {
      const document = validateSceneDocument({ ...content.document, groundAltitude });
      const text = JSON.stringify(document);
      if (new Blob([text]).size > MAX_SCENE_BYTES) throw new Error('场景文件超过 140 MB');
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = window.document.createElement('a'); link.href = url;
      link.download = `${document.name.replace(/[\\/:*?"<>|]/g, '_') || '场景'}.scene.json`;
      window.document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError(''); setNotice('已导出场景文件，包含模型、贴图和布局');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const exportCollision = () => {
    try {
      const text = exportSceneCollision(content.document, models);
      setCollisionSnapshot({ document: content.document, revision: Number(text.split(" ")[1]) });
      const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
      const link = document.createElement('a'); link.href = url; link.download = 'scene.collision'; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError(''); setNotice('碰撞文件已导出；尚未同步或生效。放入正在使用的模型目录，重新加载模型并核对运行端 scene/loaded 与启动日志。');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const syncCollision = (model: string) => run('正在生成仿真碰撞地图…', async ({ report }) => {
    if (!model) throw new Error('请先选择仿真模型');
    await new Promise(resolve => setTimeout(resolve, 0));
    const text = exportSceneCollision(content.document, models);
    setCollisionSnapshot({ document: content.document, revision: Number(text.split(" ")[1]) });
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const onProgress = new Channel<{ stage: string; transferred: number; total: number }>();
    const stages: Record<string, string> = { waiting: '等待文件传输通道', upload: '正在上传碰撞地图', verify_temporary: '正在读回校验临时文件', commit: '正在提交碰撞地图', verify: '正在读回校验碰撞地图' };
    onProgress.onmessage = progress => report(`${stages[progress.stage] ?? '正在同步碰撞地图'}：${(progress.transferred / 1024 / 1024).toFixed(2)} / ${(progress.total / 1024 / 1024).toFixed(2)} MB`);
    report(`正在上传并读回校验碰撞地图（${(new Blob([text]).size / 1024 / 1024).toFixed(2)} MB）…`);
    const result = await invoke<{ revision: number; path: string }>('scene_upload_collision', { model, content: text, onProgress });
    if (alive.current) setNotice(`已上传并读回校验：${result.path}，版本 ${result.revision}。尚未确认生效；重新加载模型后，核对运行端版本与启动日志中的实际路径。`);
  }, false);
  // Display-only height edits leave the exported collision map and its runtime
  // acknowledgement valid. Other document edits retain the existing check.
  const collisionMatches = collisionSnapshot && Object.keys({ ...collisionSnapshot.document, ...content.document }).every(key =>
    key === 'visualGroundOffsetM' || collisionSnapshot.document[key as keyof SceneDocument] === content.document[key as keyof SceneDocument]);
  return { ...content, models, collisionVersion: collisionMatches ? collisionSnapshot.revision : null, exportCollision, syncCollision, enabled, setEnabled, selectedId, setSelectedId, transformMode, setTransformMode,
    focusRevision, focus: () => setFocusRevision(v => v + 1), busy, busyMessage, canCancel, cancel: () => active.current?.abort(), error: error || f35.error || '', notice,
    updateDocument, applyModelOrigin, updateObject, removeObject, addWindsock, copyWindsock, importFiles, importOnline, importDirectory, loadFile, save };
}
export type SceneEditor = ReturnType<typeof useSceneEditor>;
