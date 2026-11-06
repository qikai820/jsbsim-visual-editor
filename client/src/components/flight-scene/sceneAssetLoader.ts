import { LoadingManager, type Object3D, type Material, type Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { resolveSceneResource, sceneAssetBytes, sceneAssetJson, type SceneAsset } from '../../sim/sceneDocument';

const ownedScenes = new WeakMap<Object3D, Object3D[]>();
export function disposeSceneAsset(root: Object3D) {
  const geometries = new Set<any>(), materials = new Set<Material>(), textures = new Set<Texture>(), images = new Set<any>();
  for (const scene of ownedScenes.get(root) ?? [root]) scene.traverse((node: any) => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.skeleton?.boneTexture) textures.add(node.skeleton.boneTexture);
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) { if (texture.source?.data) images.add(texture.source.data); texture.dispose(); }
  for (const image of images) if (typeof image.close === 'function') image.close();
  for (const geometry of geometries) geometry.dispose();
  ownedScenes.delete(root);
}

export async function loadSceneAsset(asset: SceneAsset): Promise<Object3D> {
  const json = sceneAssetJson(asset);
  for (const extension of json.extensionsRequired ?? []) {
    if (['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension)) {
      throw new Error(`${asset.entry} 使用 ${extension} 压缩，请先导出为不压缩的 GLB/glTF`);
    }
  }
  const files = new Map(asset.files.map(file => [file.path, file.data]));
  // Preflight images too: GLTFLoader intentionally tolerates missing textures.
  // A portable scene must instead fail atomically when a dependency is absent.
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (!resource.uri || resource.uri.startsWith('data:')) continue;
    const path = resolveSceneResource(asset.entry, resource.uri);
    if (!files.has(path)) throw new Error(`缺少资源：${path}。请使用目录导入，或同时选择配套文件。`);
  }
  const manager = new LoadingManager(), failures: string[] = [];
  manager.onError = url => { failures.push(url.startsWith('data:') || url.startsWith('blob:') ? '模型内嵌资源' : url); };
  manager.setURLModifier(url => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const path = resolveSceneResource(asset.entry, url), data = files.get(path);
    if (!data) throw new Error(`缺少资源：${path}`);
    return data;
  });
  const gltf = await new GLTFLoader(manager).parseAsync(sceneAssetBytes(asset).buffer as ArrayBuffer, '');
  // Only the default scene is displayed. Other scenes may share resources, so
  // include their resources in the owner's disposal without reparenting them.
  const root = gltf.scene;
  if (!root) { gltf.scenes.forEach(disposeSceneAsset); throw new Error(`${asset.entry} 没有可显示的场景`); }
  ownedScenes.set(root, gltf.scenes);
  if (failures.length) { disposeSceneAsset(root); throw new Error(`无法解码模型资源：${failures.join('、')}`); }
  root.userData.sceneSource = asset.entry;
  return root;
}
