import { useEffect, useState } from 'react';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { disposeSceneAsset } from './sceneAssetLoader';
import { waitForSceneTask } from './sceneTask';

// One small, immutable source per WebView. Rendered vessels clone its hierarchy
// and share geometry/materials. Keep it warm across panels, instances and views.
let cachedModel: Object3D | undefined;
let pendingModel: Promise<Object3D> | undefined;
export function preloadMovingPlatformAsset(): Promise<Object3D> {
  if (cachedModel) return Promise.resolve(cachedModel);
  if (pendingModel) return pendingModel;
  const controller = new AbortController();
  pendingModel = waitForSceneTask((async () => {
    const response = await fetch(`${import.meta.env.BASE_URL}scenery/moving-platform/vessel.glb`, { signal: controller.signal });
    if (!response.ok) throw Error(`工作船模型读取失败（${response.status}）`);
    return (await new GLTFLoader().parseAsync(await response.arrayBuffer(), '')).scene;
  })(), controller.signal, '读取移动平台船模', disposeSceneAsset, 15_000).then(model => {
    cachedModel = model; return model;
  }).catch(error => { pendingModel = undefined; throw error; }).finally(() => controller.abort());
  return pendingModel;
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  if (cachedModel) disposeSceneAsset(cachedModel);
  cachedModel = undefined;
});

export function useMovingPlatformAsset(required = true) {
  const [state, setState] = useState<{ model?: Object3D; error?: string }>(() => required && cachedModel ? { model: cachedModel } : {});
  useEffect(() => {
    if (!required) { setState({}); return; }
    let active = true;
    if (cachedModel) setState({ model: cachedModel });
    else {
      setState({});
      void preloadMovingPlatformAsset().then(model => { if (active) setState({ model }); })
        .catch(error => { if (active) setState({ error: String(error) }); });
    }
    return () => { active = false; };
  }, [required]);
  return required ? state : {};
}
