import { useEffect, useState } from 'react';
import type { Object3D } from 'three';
import { F35_MODEL_KEY } from '../../sim/sceneF35';
import { loadSceneAsset, disposeSceneAsset } from './sceneAssetLoader';
import { waitForSceneTask } from './sceneTask';

/** The editor owns one decoded bundled model. Rendered copies share its GPU
 * resources; deletion, scene replacement and leaving the view release them. */
export function useBundledF35(required: boolean) {
  const [state, setState] = useState<{ model?: Object3D; error?: string }>({});
  useEffect(() => {
    if (!required) { setState({}); return; }
    const controller = new AbortController();
    let owned: Object3D | undefined;
    setState({});
    const load = async () => {
      const bytes = await waitForSceneTask((async () => {
        const response = await fetch(`${import.meta.env.BASE_URL}aircraft/f35a/f35a.glb`, { signal: controller.signal });
        if (!response.ok) throw new Error(`F-35A 模型读取失败（${response.status}）`);
        return new Uint8Array(await response.arrayBuffer());
      })(), controller.signal, '读取内置 F-35A');
      const chunks: string[] = [];
      for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
      const data = `data:model/gltf-binary;base64,${btoa(chunks.join(''))}`;
      const model = await loadSceneAsset({ id: F35_MODEL_KEY, entry: 'f35a.glb', files: [{ path: 'f35a.glb', data }] }, controller.signal);
      if (controller.signal.aborted) { disposeSceneAsset(model); return; }
      owned = model; setState({ model });
    };
    void load().catch(error => {
      if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : String(error) });
    });
    return () => { controller.abort(); if (owned) disposeSceneAsset(owned); };
  }, [required]);
  return state;
}
