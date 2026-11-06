import { exportSceneCollision } from '../../sim/sceneCollision';
import { useEffect, useRef, useState } from 'react';
import type { Object3D } from 'three';
import { MAX_SCENE_BYTES, newSceneDocument, packSceneFiles, packSceneSources, validateSceneDocument, type SceneAsset, type SceneDocument, type SceneObject, type SceneSourceFile } from '../../sim/sceneDocument';
import { disposeSceneAsset, loadSceneAsset } from './sceneAssetLoader';

export type TransformMode = 'translate' | 'rotate' | 'scale';
type Content = { document: SceneDocument; models: Map<string, Object3D> };
export function useSceneEditor() {
  const [content, setContent] = useState<Content>(() => ({ document: newSceneDocument(), models: new Map() }));
  const [collisionSnapshot, setCollisionSnapshot] = useState<{ document: SceneDocument; revision: number } | null>(null);
  const [enabled, setEnabled] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [focusRevision, setFocusRevision] = useState(0), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), lock = useRef(false), owned = useRef(content.models);
  useEffect(() => {
    for (const [id, model] of owned.current) if (content.models.get(id) !== model) disposeSceneAsset(model);
    owned.current = content.models;
  }, [content.models]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const model of owned.current.values()) disposeSceneAsset(model); }; }, []);

  const updateDocument = (patch: Partial<SceneDocument>) => setContent(current => ({ ...current, document: { ...current.document, ...patch } }));
  const updateObject = (id: string, patch: Partial<SceneObject>) => setContent(current => ({ ...current,
    document: { ...current.document, objects: current.document.objects.map(object => object.id === id ? { ...object, ...patch } : object) },
  }));
  const removeObject = (id: string) => {
    setContent(current => {
      const objects = current.document.objects.filter(object => object.id !== id);
      const assets = current.document.assets.filter(asset => objects.some(object => object.assetId === asset.id));
      return { document: { ...current.document, objects, assets }, models: new Map([...current.models].filter(([key]) => assets.some(asset => asset.id === key))) };
    }); setSelectedId(null);
  };

  const run = async (operation: (loaded: Map<string, Object3D>) => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice(''); const loaded = new Map<string, Object3D>();
    try { await operation(loaded); }
    catch (e) { for (const model of loaded.values()) disposeSceneAsset(model); if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const importAssets = (prepare: () => Promise<SceneAsset[]>) => run(async loaded => {
    const assets = await prepare();
    if (!assets.length) return;
    // Sequential loading bounds peak memory and allows cleanup on any failure.
    for (const asset of assets) loaded.set(asset.id, await loadSceneAsset(asset));
    if (!alive.current) { for (const model of loaded.values()) disposeSceneAsset(model); return; }
    const objects: SceneObject[] = assets.map(asset => ({ id: crypto.randomUUID(), assetId: asset.id,
      name: asset.entry.split('/').pop()!.replace(/\.(glb|gltf)$/i, ''), visible: true,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }));
    // Validate the resulting size before committing any live state.
    validateSceneDocument({ ...content.document, assets: [...content.document.assets, ...assets], objects: [...content.document.objects, ...objects] });
    setContent(current => ({ document: { ...current.document, assets: [...current.document.assets, ...assets], objects: [...current.document.objects, ...objects] },
      models: new Map([...current.models, ...loaded]) }));
    setSelectedId(objects[0].id); setFocusRevision(v => v + 1); setNotice(`已导入 ${objects.length} 个物体`);
  });
  const importFiles = (files: File[]) => importAssets(() => packSceneFiles(files));
  const importDirectory = () => importAssets(async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const files = await invoke<SceneSourceFile[] | null>('scene_import_directory');
    return files ? packSceneSources(files) : [];
  });
  const loadFile = (file: File, onLoaded: (altitude: number | null) => void) => run(async loaded => {
    if (file.size > MAX_SCENE_BYTES) throw new Error('场景文件超过 140 MB');
    const document = validateSceneDocument(JSON.parse(await file.text()));
    for (const asset of document.assets) loaded.set(asset.id, await loadSceneAsset(asset));
    if (!alive.current) { for (const model of loaded.values()) disposeSceneAsset(model); return; }
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
  const syncCollision = (model: string) => run(async () => {
    if (!model) throw new Error('请先选择仿真模型');
    const text = exportSceneCollision(content.document, content.models);
    setCollisionSnapshot({ document: content.document, revision: Number(text.split(" ")[1]) });
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ revision: number; path: string }>('scene_upload_collision', { model, content: text });
    setNotice(`已上传并读回校验：${result.path}，版本 ${result.revision}。尚未确认生效；重新加载模型后，核对运行端版本与启动日志中的实际路径。`);
  });
  return { ...content, collisionVersion: collisionSnapshot?.document === content.document ? collisionSnapshot.revision : null, exportCollision, syncCollision, enabled, setEnabled, selectedId, setSelectedId, transformMode, setTransformMode,
    focusRevision, focus: () => setFocusRevision(v => v + 1), busy, error, notice,
    updateDocument, updateObject, removeObject, importFiles, importDirectory, loadFile, save };
}
export type SceneEditor = ReturnType<typeof useSceneEditor>;
