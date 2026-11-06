import { useEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import { Group, MathUtils, type Object3D } from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { SceneObject, Triple } from '../../sim/sceneDocument';
import type { SceneEditor } from './useSceneEditor';
import { BuiltinGeometry, BuiltinTrees } from './BuiltinSceneObjects';
import type { SceneSurfaceTextures } from './sceneSurfaceTextures';

function ImportedModel({ model }: { model: Object3D }) {
  const instance = useMemo(() => clone(model), [model]);
  useEffect(() => () => {
    // Geometry/materials belong to the asset owner, cloned skeleton textures
    // belong to this instance and are allocated only once it is rendered.
    const skeletons = new Set<any>();
    instance.traverse((node: any) => { if (node.skeleton) skeletons.add(node.skeleton); });
    for (const skeleton of skeletons) skeleton.dispose();
  }, [instance]);
  return <primitive object={instance} dispose={null} />;
}

function EditableObject({ object, editor, groundY, maps }: { object: SceneObject; editor: SceneEditor; groundY: number; maps: SceneSurfaceTextures }) {
  const group = useRef<Group>(null!);
  const visible = object.visible && (!object.builtin || editor.document.showBase);
  const selected = editor.enabled && editor.selectedId === object.id && visible && !editor.busy;
  const rotation = useMemo(() => object.rotation.map(MathUtils.degToRad) as Triple, [object.rotation]);
  const commit = () => {
    if (!group.current) return;
    editor.updateObject(object.id, { position: group.current.position.toArray() as Triple,
      rotation: [group.current.rotation.x, group.current.rotation.y, group.current.rotation.z].map(MathUtils.radToDeg) as Triple,
      scale: group.current.scale.toArray() as Triple });
  };
  return <>
    <group position={[0, groundY, 0]}><group ref={group} name={`scene-object-${object.id}`} position={object.position} rotation={rotation} scale={object.scale} visible={visible} dispose={object.builtin ? undefined : null}
      userData={object.builtin === 'tree' ? { sceneFocusBounds: [[-3, 0, -3], [3, 8, 3]] } : {}}
      onClick={event => { if (editor.enabled && visible) { event.stopPropagation(); editor.setSelectedId(object.id); } }}>
      {object.builtin ? <BuiltinGeometry object={object} maps={maps} /> : <ImportedModel model={editor.models.get(object.assetId!)!} />}
    </group></group>
    {selected && <TransformControls object={group} mode={editor.transformMode} space="local" size={.85}
      onMouseUp={commit} onObjectChange={() => {
        if (!group.current) return;
        group.current.scale.clampScalar(.001, 1e7);
        group.current.position.clampScalar(-1e7, 1e7);
        if (object.builtin === 'tree') commit();
      }} />}
  </>;
}

export default function SceneObjects({ editor, groundY, maps }: { editor: SceneEditor; groundY: number; maps: SceneSurfaceTextures }) {
  return <group name="scene-imported-objects">
    {editor.document.objects.map(object => <EditableObject key={object.id} object={object} editor={editor} groundY={groundY} maps={maps} />)}
    <BuiltinTrees editor={editor} groundY={groundY} maps={maps} />
  </group>;
}
