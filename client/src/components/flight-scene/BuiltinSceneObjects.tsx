import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { DoubleSide, InstancedMesh, MathUtils, Object3D, PlaneGeometry } from 'three';
import type { SceneObject } from '../../sim/sceneDocument';
import type { SceneEditor } from './useSceneEditor';
import type { SceneSurfaceTextures } from './sceneSurfaceTextures';
import { createHangarGeometry } from '../../sim/sceneHangar';
import { createTreeGeometry, lightTreeFoliage, TREE_FORMS } from './airfieldTrees';

function HangarShell({ maps }: { maps: SceneSurfaceTextures }) {
  const geometry = useMemo(createHangarGeometry, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry}>
    <meshStandardMaterial map={maps.hangar} roughness={.78} metalness={.14} />
  </mesh>;
}

/** Geometry stays local to each object's ground-level editing pivot. */
export function BuiltinGeometry({ object, maps }: { object: SceneObject; maps: SceneSurfaceTextures }) {
  if (object.builtin === 'apron') return <mesh rotation={[-Math.PI / 2, 0, 0]}>
    <planeGeometry args={[40, 44]} /><meshBasicMaterial map={maps.apron} toneMapped={false} />
  </mesh>;
  if (object.builtin === 'runway') return <mesh rotation={[-Math.PI / 2, 0, 0]}>
    <planeGeometry args={[18, 320]} /><meshBasicMaterial map={maps.runway} toneMapped={false} />
  </mesh>;
  if (object.builtin === 'hangar') return <>
    <mesh position={[0, .018, 18]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[30, 22]} /><meshBasicMaterial map={maps.concrete} toneMapped={false} /></mesh>
    <mesh position={[3, .01, -1]} rotation={[-Math.PI / 2, 0, 0]} scale={[36, 27, 1]}><planeGeometry /><meshBasicMaterial map={maps.shadow} color="#18221c" transparent opacity={.45} depthWrite={false} /></mesh>
    <HangarShell maps={maps} />
  </>;
  return null;
}

type TreeBatchProps = {
  trees: SceneObject[]; maps: SceneSurfaceTextures; form: number | 'shadow'; select?: (id: string) => void;
};

function TreeBatch({ trees, maps, form, select }: TreeBatchProps) {
  const batch = useRef<InstancedMesh>(null!);
  const geometry = useMemo(() => form === 'shadow' ? new PlaneGeometry() : createTreeGeometry(form), [form]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useLayoutEffect(() => {
    const parent = new Object3D(), local = new Object3D();
    if (form === 'shadow') {
      local.position.set(1.55, .018, -.95); local.rotation.set(-Math.PI / 2, 0, -.35); local.scale.set(7.4, 5.7, 1);
      local.updateMatrix();
    }
    trees.forEach((tree, slot) => {
      parent.position.fromArray(tree.position); parent.scale.fromArray(tree.scale);
      if (!tree.visible) parent.scale.setScalar(0);
      parent.rotation.set(...tree.rotation.map(MathUtils.degToRad) as [number, number, number]);
      parent.updateMatrix();
      if (form !== 'shadow') local.matrix.makeRotationY(tree.seed! * 2.4);
      batch.current.setMatrixAt(slot, parent.matrix.multiply(local.matrix));
    });
    batch.current.instanceMatrix.needsUpdate = true;
    batch.current.computeBoundingSphere();
  }, [trees, form]);
  const pick = (event: ThreeEvent<MouseEvent>) => {
    const tree = event.instanceId === undefined ? undefined : trees[event.instanceId];
    if (tree?.visible && select) { event.stopPropagation(); select(tree.id); }
  };
  return <instancedMesh ref={batch} name={`scene-trees-${form}`} args={[geometry, undefined, trees.length]} onClick={pick}>
    {form === 'shadow'
      ? <meshBasicMaterial map={maps.shadow} color="#172216" transparent opacity={.42} depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
      : <meshLambertMaterial map={maps.foliage} vertexColors side={DoubleSide} alphaTest={.28} alphaToCoverage onBeforeCompile={lightTreeFoliage} />}
  </instancedMesh>;
}

export function BuiltinTrees({ editor, groundY, maps }: { editor: SceneEditor; groundY: number; maps: SceneSurfaceTextures }) {
  const { trees, groups } = useMemo(() => {
    const trees = editor.document.objects.filter(object => object.builtin === 'tree');
    const groups = TREE_FORMS.map((): SceneObject[] => []);
    for (const tree of trees) groups[tree.seed! % groups.length].push(tree);
    return { trees, groups };
  }, [editor.document.objects]);
  const select = editor.enabled && editor.document.showBase ? editor.setSelectedId : undefined;
  return <group position={[0, groundY, 0]} visible={editor.document.showBase} name="scene-builtin-trees">
    {groups.map((group, form) => group.length > 0 && <TreeBatch key={form} trees={group} form={form} maps={maps} select={select} />)}
    {trees.length > 0 && <TreeBatch trees={trees} form="shadow" maps={maps} select={select} />}
  </group>;
}
