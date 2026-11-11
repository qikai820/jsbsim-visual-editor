import { exportSceneCollision } from '../../sim/sceneCollision';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Object3D } from 'three';
import { MAX_SCENE_BYTES, newSceneDocument, packSceneFiles, packSceneSources, validateSceneDocument, type SceneAsset, type SceneDocument, type SceneObject, type SceneSourceFile } from '../../sim/sceneDocument';
import { disposeSceneAsset, loadSceneAsset } from './sceneAssetLoader';
import { waitForSceneTask } from './sceneTask';

export type TransformMode = 'translate' | 'rotate' | 'scale';
type Content = { document: SceneDocument; models: Map<string, Object3D>; automaticGeoreference?: SceneDocument['georeference'] };
type SceneTask = { loaded: Map<string, Object3D>; signal: AbortSignal; report: (message: string) => void };
export function useSceneEditor() {
  const [content, setContent] = useState<Content>(() => ({ document: newSceneDocument(), models: new Map() }));
  const [collisionSnapshot, setCollisionSnapshot] = useState<{ document: SceneDocument; revision: number } | null>(null);
  const [enabled, setEnabled] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [focusRevision, setFocusRevision] = useState(0), [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState(''), [canCancel, setCanCancel] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), lock = useRef(false), owned = useRef(content.models);
  const active = useRef<AbortController | null>(null);
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
    setContent({ document, models: loaded }); onLoaded(document.groundAltitude);
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
      const text = exportSceneCollision(content.document, content.models);
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
    const text = exportSceneCollision(content.document, content.models);
    setCollisionSnapshot({ document: content.document, revision: Number(text.split(" ")[1]) });
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const onProgress = new Channel<{ stage: string; transferred: number; total: number }>();
    const stages: Record<string, string> = { waiting: '等待文件传输通道', upload: '正在上传碰撞地图', verify_temporary: '正在读回校验临时文件', commit: '正在提交碰撞地图', verify: '正在读回校验碰撞地图' };
    onProgress.onmessage = progress => report(`${stages[progress.stage] ?? '正在同步碰撞地图'}：${(progress.transferred / 1024 / 1024).toFixed(2)} / ${(progress.total / 1024 / 1024).toFixed(2)} MB`);
    report(`正在上传并读回校验碰撞地图（${(new Blob([text]).size / 1024 / 1024).toFixed(2)} MB）…`);
    const result = await invoke<{ revision: number; path: string }>('scene_upload_collision', { model, content: text, onProgress });
    if (alive.current) setNotice(`已上传并读回校验：${result.path}，版本 ${result.revision}。尚未确认生效；重新加载模型后，核对运行端版本与启动日志中的实际路径。`);
  }, false);
  return { ...content, collisionVersion: collisionSnapshot?.document === content.document ? collisionSnapshot.revision : null, exportCollision, syncCollision, enabled, setEnabled, selectedId, setSelectedId, transformMode, setTransformMode,
    focusRevision, focus: () => setFocusRevision(v => v + 1), busy, busyMessage, canCancel, cancel: () => active.current?.abort(), error, notice,
    updateDocument, applyModelOrigin, updateObject, removeObject, importFiles, importDirectory, loadFile, save };
}
export type SceneEditor = ReturnType<typeof useSceneEditor>;
