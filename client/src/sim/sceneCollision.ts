import { BoxGeometry, CylinderGeometry, Euler, IcosahedronGeometry, Matrix4, Mesh, Object3D, PlaneGeometry, Vector3, type BufferGeometry } from 'three';
import { validateSceneDocument, type SceneDocument } from './sceneDocument';
/** Bake exactly the editable object transforms. Shadows are deliberately absent. */
export function exportSceneCollision(document: SceneDocument, models: Map<string, Object3D>): string {
  const doc = validateSceneDocument(document), geo = doc.georeference;
  if (!geo) throw new Error('请先设置并保存场景经纬度和基准海拔');
  const rows: string[] = [];
  const emit = (geometry: BufferGeometry, matrix: Matrix4) => {
    const position = geometry.getAttribute('position'), index = geometry.index;
    const count = index ? index.count : position.count;
    if (count % 3) throw new Error('模型三角形索引无效');
    for (let i = 0; i < count; i += 3) {
      const points = [0, 1, 2].map(j => new Vector3().fromBufferAttribute(position, index ? index.getX(i + j) : i + j).applyMatrix4(matrix));
      if (points.some(p => !p.toArray().every(n => Number.isFinite(n) && Math.abs(n) <= 1e6))) throw new Error('碰撞网格坐标超出 ±1000 km');
      if (points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).length() < 1e-10) continue;
      rows.push(points.flatMap(p => p.toArray()).map(n => n.toPrecision(12)).join(' '));
      if (rows.length > 1000000) throw new Error('碰撞网格超过 100 万个三角形，请先简化模型');
    }
  };
  if (doc.showBase) {
    const ground = new PlaneGeometry(4000, 4000);
    emit(ground, new Matrix4().makeRotationX(-Math.PI / 2)); ground.dispose();
    const pad = new PlaneGeometry(8, 8), pose = new Object3D();
    pose.position.set(-10, .028, 5); pose.rotation.x = -Math.PI / 2; pose.updateMatrix();
    emit(pad, pose.matrix); pad.dispose();
  }
  for (const object of doc.objects) {
    if (!object.visible || object.collision === false || (object.builtin && !doc.showBase)) continue;
    const parent = new Object3D(); parent.position.fromArray(object.position);
    parent.rotation.copy(new Euler(...object.rotation.map(n => n * Math.PI / 180) as [number, number, number]));
    parent.scale.fromArray(object.scale); parent.updateMatrix();
    const primitive = (geometry: BufferGeometry, position: number[], scale = [1, 1, 1], rotation = [0, 0, 0]) => {
      const pose = new Object3D(); pose.position.fromArray(position); pose.scale.fromArray(scale); pose.rotation.set(rotation[0], rotation[1], rotation[2]); pose.updateMatrix();
      emit(geometry, new Matrix4().multiplyMatrices(parent.matrix, pose.matrix)); geometry.dispose();
    };
    if (object.builtin === 'runway') primitive(new PlaneGeometry(18, 320), [0, 0, 0], [1, 1, 1], [-Math.PI / 2, 0, 0]);
    else if (object.builtin === 'hangar') {
      primitive(new PlaneGeometry(30, 22), [0, .018, 18], [1, 1, 1], [-Math.PI / 2, 0, 0]);
      primitive(new BoxGeometry(22, 8, 16), [0, 4, 0]); primitive(new BoxGeometry(13, 6, .1), [0, 3, 8.05]);
    } else if (object.builtin === 'tree') {
      const i = object.seed!;
      primitive(new CylinderGeometry(.65, 1, 1, 5), [0, 1.5, 0], [.24, 3, .24], [0, i * 2.4, 0]);
      for (let lobe = 0; lobe < 3; lobe++) primitive(new IcosahedronGeometry(1, 0), [(lobe - 1) * .65, lobe === 1 ? 5.2 : 4.1, Math.sin(i + lobe) * .5], [1.9, lobe === 1 ? 2.4 : 1.8, 1.8], [0, i * 2.4, 0]);
    } else {
      const model = models.get(object.assetId!); if (!model) throw new Error(`模型尚未加载：${object.name}`);
      model.updateMatrixWorld(true);
      model.traverseVisible(node => {
        // Animated/skinned geometry cannot be represented by a static sidecar.
        if ((node as any).isSkinnedMesh || (node as any).isInstancedMesh || ((node as Mesh).morphTargetInfluences?.some(n => n !== 0))) throw new Error('碰撞导出暂不支持蒙皮或实例化模型，请转换为静态网格');
        if ((node as Mesh).isMesh) emit((node as Mesh).geometry, new Matrix4().multiplyMatrices(parent.matrix, node.matrixWorld));
      });
    }
  }
  if (!rows.length) throw new Error('没有可导出的碰撞三角形');
  const payload = `${geo.latitude} ${geo.longitude} ${geo.altitude} ${doc.collisionRadius ?? .5} ${rows.length}\n${rows.join('\n')}\n`;
  let hash = 2166136261; for (const byte of new TextEncoder().encode(payload)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return `JSBSCENE1 ${hash} ${payload}`;
}
