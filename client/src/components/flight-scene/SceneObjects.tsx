import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import { Group, MathUtils, MeshStandardMaterial, PMREMGenerator, type Object3D } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { sceneObjectVisible, type SceneObject, type Triple } from '../../sim/sceneDocument';
import type { SceneEditor } from './useSceneEditor';
import { BuiltinGeometry, BuiltinTrees } from './BuiltinSceneObjects';
import type { SceneSurfaceTextures } from './sceneSurfaceTextures';
import type { FlightSceneFeed } from '../../sim/flightSceneState';
import SceneWindsock from './SceneWindsock';
import { F35_MODEL, F35_MODEL_KEY } from '../../sim/sceneF35';

/** Authored metallic PBR surfaces need an environment to reflect. Build one
 * neutral offline light probe once; other aircraft keep their current lighting. */
function F35Environment({ model }: { model?: Object3D }) {
  const { gl } = useThree();
  useEffect(() => {
    if (!model) return;
    const room = new RoomEnvironment(), generator = new PMREMGenerator(gl);
    const environment = generator.fromScene(room, .04);
    room.dispose(); generator.dispose();
    const materials = new Set<MeshStandardMaterial>();
    model.traverse((node: any) => {
      for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
        if (material instanceof MeshStandardMaterial) materials.add(material);
      }
    });
    for (const material of materials) { material.envMap = environment.texture; material.envMapIntensity = .75; material.needsUpdate = true; }
    return () => {
      for (const material of materials) if (material.envMap === environment.texture) { material.envMap = null; material.needsUpdate = true; }
      environment.dispose();
    };
  }, [model, gl]);
  return null;
}

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

type WindSource = { feed: FlightSceneFeed; instance: string };
function EditableObject({ object, editor, groundY, maps, feed, instance }: { object: SceneObject; editor: SceneEditor; groundY: number; maps: SceneSurfaceTextures } & WindSource) {
  const group = useRef<Group>(null!);
  const visible = sceneObjectVisible(object, editor.document.showBase);
  const selected = editor.enabled && editor.selectedId === object.id && visible && !editor.busy;
  const rotation = useMemo(() => object.rotation.map(MathUtils.degToRad) as Triple, [object.rotation]);
  const f35 = object.builtin === 'f35' ? editor.models.get(F35_MODEL_KEY) : undefined;
  const commit = () => {
    if (!group.current) return;
    editor.updateObject(object.id, { position: group.current.position.toArray() as Triple,
      rotation: [group.current.rotation.x, group.current.rotation.y, group.current.rotation.z].map(MathUtils.radToDeg) as Triple,
      scale: group.current.scale.toArray() as Triple });
  };
  return <>
    <group position={[0, groundY, 0]}><group ref={group} name={`scene-object-${object.id}`} position={object.position} rotation={rotation} scale={object.scale} visible={visible} dispose={object.builtin ? undefined : null}
      userData={object.builtin === 'tree' ? { sceneFocusBounds: [[-3, 0, -3], [3, 8, 3]] }
        : object.builtin === 'f35' ? { sceneFocusBounds: [F35_MODEL.bounds.min, F35_MODEL.bounds.max] } : {}}
      onClick={event => { if (editor.enabled && visible) { event.stopPropagation(); editor.setSelectedId(object.id); } }}>
      {object.builtin === 'windsock' ? <SceneWindsock key={`${instance}:${feed.aircraft.get(instance)?.latest.model}:${feed.aircraft.get(instance)?.latest.generation}`} feed={feed} instance={instance} name={`scene-windsock-${object.id}`} />
        : object.builtin === 'f35' ? <>
          <mesh position={[.5, .008, .5]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[11, 17]} /><meshBasicMaterial map={maps.shadow} color="#152026" transparent opacity={.52} depthWrite={false} />
          </mesh>
          {f35 && <ImportedModel model={f35} />}
        </> : object.builtin ? <BuiltinGeometry object={object} maps={maps} /> : <ImportedModel model={editor.models.get(object.assetId!)!} />}
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

export default function SceneObjects({ editor, groundY, maps, feed, instance }: { editor: SceneEditor; groundY: number; maps: SceneSurfaceTextures } & WindSource) {
  return <group name="scene-imported-objects">
    <F35Environment model={editor.models.get(F35_MODEL_KEY)} />
    {editor.document.objects.map(object => <EditableObject key={object.id} object={object} editor={editor} groundY={groundY} maps={maps} feed={feed} instance={instance} />)}
    <BuiltinTrees editor={editor} groundY={groundY} maps={maps} />
  </group>;
}
