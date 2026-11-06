import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { Color, Euler, InstancedMesh, Matrix4, Object3D } from 'three';
import type { SceneObject } from '../../sim/sceneDocument';
import type { SceneEditor } from './useSceneEditor';
import type { SceneSurfaceTextures } from './sceneSurfaceTextures';

/** Geometry stays local to each object's ground-level editing pivot. */
export function BuiltinGeometry({ object, maps }: { object: SceneObject; maps: SceneSurfaceTextures }) {
  if (object.builtin === 'runway') return <mesh rotation={[-Math.PI / 2, 0, 0]}>
    <planeGeometry args={[18, 320]} /><meshBasicMaterial map={maps.runway} toneMapped={false} />
  </mesh>;
  if (object.builtin === 'hangar') return <>
    <mesh position={[0, .018, 18]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[30, 22]} /><meshBasicMaterial map={maps.concrete} toneMapped={false} /></mesh>
    <mesh position={[3, .01, -1]} rotation={[-Math.PI / 2, 0, 0]} scale={[36, 27, 1]}><planeGeometry /><meshBasicMaterial map={maps.shadow} color="#18221c" transparent opacity={.45} depthWrite={false} /></mesh>
    <mesh position={[0, 4, 0]}><boxGeometry args={[22, 8, 16]} /><meshStandardMaterial color="#98a5a5" roughness={.85} /></mesh>
    <mesh position={[0, 3, 8.05]}><boxGeometry args={[13, 6, .1]} /><meshStandardMaterial color="#495756" roughness={.8} /></mesh>
  </>;
  return null; // Tree surfaces are batched below; their editing pivots are separate.
}

export function BuiltinTrees({ editor, groundY, maps }: { editor: SceneEditor; groundY: number; maps: SceneSurfaceTextures }) {
  const trees = useMemo(() => editor.document.objects.filter(object => object.builtin === 'tree'), [editor.document.objects]);
  const trunks = useRef<InstancedMesh>(null), crowns = useRef<InstancedMesh>(null), shades = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!trunks.current || !crowns.current || !shades.current) return;
    const pose = new Object3D(), color = new Color(), parent = new Object3D(), matrix = new Matrix4();
    trees.forEach((tree, slot) => {
      const i = tree.seed!;
      parent.position.fromArray(tree.position); parent.rotation.copy(new Euler(...tree.rotation.map(n => n * Math.PI / 180) as [number, number, number]));
      parent.scale.fromArray(tree.scale); parent.updateMatrix();
      // Hidden instances retain their slot for stable picking and are collapsed
      // instead of rebuilding geometry or allocating separate draw calls.
      const write = (mesh: InstancedMesh, index: number) => {
        pose.updateMatrix(); matrix.multiplyMatrices(parent.matrix, pose.matrix);
        if (!tree.visible) matrix.makeScale(0, 0, 0);
        mesh.setMatrixAt(index, matrix);
      };
      pose.position.set(0, 1.5, 0); pose.rotation.set(0, i * 2.4, 0); pose.scale.set(.24, 3, .24);
      write(trunks.current!, slot);
      for (let lobe = 0; lobe < 3; lobe++) {
        pose.position.set((lobe - 1) * .65, lobe === 1 ? 5.2 : 4.1, Math.sin(i + lobe) * .5);
        pose.scale.set(1.9, lobe === 1 ? 2.4 : 1.8, 1.8); write(crowns.current!, slot * 3 + lobe);
        color.setHSL(.23 + Math.sin(i * 3.2) * .025, .22, .25 + Math.sin(i * 5.3 + lobe) * .035);
        crowns.current!.setColorAt(slot * 3 + lobe, color);
      }
      const originalSize = .8 + (Math.sin(i * 7.7) + 1) * .25;
      pose.position.set(1.8, .012 / originalSize, -1); pose.rotation.set(-Math.PI / 2, 0, -.35); pose.scale.set(7, 5, 1);
      write(shades.current!, slot);
    });
    for (const mesh of [trunks.current, crowns.current, shades.current]) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
    if (crowns.current.instanceColor) crowns.current.instanceColor.needsUpdate = true;
  }, [trees]);
  const select = (event: ThreeEvent<MouseEvent>, lobes = 1) => {
    if (!editor.enabled || !editor.document.showBase || event.instanceId === undefined) return;
    const tree = trees[Math.floor(event.instanceId / lobes)];
    if (tree?.visible) { event.stopPropagation(); editor.setSelectedId(tree.id); }
  };
  if (!trees.length) return null;
  return <group position={[0, groundY, 0]} visible={editor.document.showBase} name="scene-builtin-trees">
    <instancedMesh name="scene-tree-trunks" ref={trunks} args={[undefined, undefined, trees.length]} onClick={event => select(event)}>
      <cylinderGeometry args={[.65, 1, 1, 5]} /><meshLambertMaterial color="#625b48" />
    </instancedMesh>
    <instancedMesh name="scene-tree-crowns" ref={crowns} args={[undefined, undefined, trees.length * 3]} onClick={event => select(event, 3)}>
      <icosahedronGeometry args={[1, 0]} /><meshLambertMaterial />
    </instancedMesh>
    <instancedMesh name="scene-tree-shades" ref={shades} args={[undefined, undefined, trees.length]} onClick={event => select(event)}>
      <planeGeometry /><meshBasicMaterial map={maps.shadow} color="#243024" transparent opacity={.32} depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
    </instancedMesh>
  </group>;
}
