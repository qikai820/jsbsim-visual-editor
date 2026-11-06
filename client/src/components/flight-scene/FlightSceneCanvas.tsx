import { memo, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import { ArrowHelper, Color, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three';
import { bodyToSceneBasis, FlightSceneFeed, localPosition, propertyAgeMs, SCENE_COLORS, STALE_MS, type CameraMode } from '../../sim/flightSceneState';
import { rotorReading } from '../../sim/sceneRotors';
import { isMorphQuad, MORPHQUAD_ARMS, MORPHQUAD_ROTOR_RADIUS } from '../../sim/sceneMorphQuad';
import { Field, SCENE_FOG, SceneSky } from './FlightSceneEnvironment';
import { createSceneSurfaceTextures, loadSceneSurfaceTextures, type SceneSurfaceTextures } from './sceneSurfaceTextures';

export type SceneLayers = { grid: boolean; trails: boolean; labels: boolean; thrust: boolean; axes: boolean };
type Props = {
  feed: FlightSceneFeed; revision: number; selected: string; onSelect: (id: string) => void;
  mode: CameraMode; layers: SceneLayers; onFps: (fps: number) => void; groundAltitude: number | null;
  cameraVersion: number;
};

const Rotor = memo(function Rotor({ x, y, z, radius = .28, feed, id, index, blades = 2 }: {
  x: number; y: number; z: number; radius?: number; feed: FlightSceneFeed; id: string; index: number; blades?: number;
}) {
  const spinner = useRef<Group>(null), blur = useRef<Mesh>(null);
  const bladeMesh = useRef<InstancedMesh>(null);
  const bladeMaterial = useRef<MeshStandardMaterial>(null), blurMaterial = useRef<MeshBasicMaterial>(null);
  useEffect(() => {
    if (!bladeMesh.current) return;
    // One draw per propeller, retaining the contrasting lead blade.
    for (let blade = 0; blade < blades; blade++) {
      const angle = blade * Math.PI * 2 / blades;
      const transform = new Matrix4().makeRotationY(angle);
      transform.setPosition(Math.cos(angle) * radius * .48, 0, -Math.sin(angle) * radius * .48);
      bladeMesh.current.setMatrixAt(blade, transform);
      bladeMesh.current.setColorAt(blade, new Color(blade === 0 ? '#dce4ee' : '#a7b7c8'));
    }
    bladeMesh.current.instanceMatrix.needsUpdate = true;
    if (bladeMesh.current.instanceColor) bladeMesh.current.instanceColor.needsUpdate = true;
    bladeMesh.current.computeBoundingSphere();
  }, [radius, blades]);
  useFrame((_, dt) => {
    const pose = feed.aircraft.get(id)?.latest;
    if (!pose || !spinner.current) return;
    const reading = rotorReading(pose, index);
    // Cap the visible step below half a blade interval even at low frame rates.
    // Full RPM is retained in the inspector; this avoids the wagon-wheel illusion.
    const step = Math.sign(reading.visualAngularVelocity) * Math.min(
      Math.abs(reading.visualAngularVelocity) * Math.min(dt, .1), Math.PI / blades * .75);
    spinner.current.rotation.y = (spinner.current.rotation.y + step) % (Math.PI * 2);
    spinner.current.userData.rpm = reading.rpm;
    spinner.current.userData.source = reading.source;
    spinner.current.userData.angularVelocity = reading.angularVelocity;
    spinner.current.userData.visualAngularVelocity = reading.visualAngularVelocity;
    if (blur.current) blur.current.visible = reading.blur > 0;
    if (blurMaterial.current) blurMaterial.current.opacity = reading.blur;
    if (bladeMaterial.current) bladeMaterial.current.opacity = reading.blur ? .45 : 1;
  });
  return <group position={[x, y, z]}>
    <mesh><cylinderGeometry args={[.021, .021, .045, 8]} /><meshStandardMaterial color="#343e49" /></mesh>
    <mesh ref={blur} rotation={[-Math.PI / 2, 0, 0]} position={[0, .027, 0]} visible={false}>
      <circleGeometry args={[radius, 24]} /><meshBasicMaterial ref={blurMaterial} color="#dce8f2" transparent opacity={0} depthWrite={false} side={2} />
    </mesh>
    <group ref={spinner} name={`scene-rotor-${id}-${index}`} position={[0, .029, 0]}>
      <instancedMesh ref={bladeMesh} args={[undefined, undefined, blades]}>
        <boxGeometry args={[radius * .95, .008, .024]} /><meshStandardMaterial ref={bladeMaterial} color="#ffffff" transparent />
      </instancedMesh>
    </group>
  </group>;
});

function ThrustArrow() {
  const arrow = useMemo(() => new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), .8, '#22c8ce', .12, .07), []);
  useEffect(() => () => arrow.dispose(), [arrow]);
  return <primitive object={arrow} />;
}

function MorphQuadAirframe({ feed, id, color, showThrust }: {
  feed: FlightSceneFeed; id: string; color: string; showThrust: boolean;
}) {
  const outer = useRef<(Group | null)[]>([]), inner = useRef<(Group | null)[]>([]);
  const arrows = useRef<(Group | null)[]>([]);
  useFrame(() => {
    const pose = feed.aircraft.get(id)?.latest;
    pose?.gimbals.forEach((gimbal, arm) => {
      // Rx(-alpha) Rz(-beta) maps the rotor's +Y axis to the XML thrust vector.
      // Absolute angles retain inverted configurations and the last known pose.
      if (outer.current[arm]) outer.current[arm]!.rotation.x = -(gimbal.outer ?? 0);
      if (inner.current[arm]) inner.current[arm]!.rotation.z = -(gimbal.inner ?? 0);
      if (arrows.current[arm]) arrows.current[arm]!.visible = gimbal.outer !== null && gimbal.inner !== null
        && (propertyAgeMs(gimbal.outerSampleAt) ?? Infinity) < STALE_MS
        && (propertyAgeMs(gimbal.innerSampleAt) ?? Infinity) < STALE_MS;
    });
  });
  return <group name={`scene-morphquad-${id}`}>
    {/* H frame; rotor centres match the four XML thruster locations. */}
    <mesh><boxGeometry args={[.45, .022, .025]} /><meshStandardMaterial color="#303b48" /></mesh>
    {[-.225, .225].map(x => <mesh key={x} position={[x, 0, 0]}>
      <boxGeometry args={[.022, .022, .45]} /><meshStandardMaterial color="#303b48" />
    </mesh>)}
    {MORPHQUAD_ARMS.map((arm, i) => <group key={i} position={[arm.x, .04, arm.z]}>
      <group ref={node => { outer.current[i] = node; }} name={`scene-gimbal-outer-${id}-${i}`}>
        <mesh rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[.105, .004, 4, 24]} /><meshStandardMaterial color={color} /></mesh>
        <group ref={node => { inner.current[i] = node; }} name={`scene-gimbal-inner-${id}-${i}`}>
          <mesh><torusGeometry args={[.093, .004, 4, 24]} /><meshStandardMaterial color="#8293a6" /></mesh>
          <Rotor feed={feed} id={id} index={i * 2} x={0} y={.035 - .029} z={0} radius={MORPHQUAD_ROTOR_RADIUS} blades={3} />
          <Rotor feed={feed} id={id} index={i * 2 + 1} x={0} y={-.035 - .029} z={0} radius={MORPHQUAD_ROTOR_RADIUS} blades={3} />
          {showThrust && <group ref={node => { arrows.current[i] = node; }} visible={false}><ThrustArrow /></group>}
        </group>
      </group>
    </group>)}
    {[-.12, .12].map(x => <mesh key={x} position={[x, -.04, 0]}>
      <boxGeometry args={[.012, .04, .3]} /><meshStandardMaterial color="#536171" />
    </mesh>)}
  </group>;
}

function Airframe({ model, color, feed, id, showThrust, showAxes }: {
  model: string; color: string; feed: FlightSceneFeed; id: string; showThrust: boolean; showAxes: boolean;
}) {
  const voliro = /voliro/i.test(model);
  const multirotor = /f450|quad|multi|h7|morph/i.test(model);
  const latest = feed.aircraft.get(id)!.latest;
  const lastTilt = useRef(latest.tilt ?? 0);
  const pivots = useRef<(Group | null)[]>([]);
  useEffect(() => { lastTilt.current = feed.aircraft.get(id)?.latest.tilt ?? 0; }, [feed, id, latest.generation, model]);
  useFrame(() => {
    const measured = feed.aircraft.get(id)?.latest;
    if (measured?.tilt != null && (propertyAgeMs(measured.tiltSampleAt) ?? Infinity) < STALE_MS) lastTilt.current = measured.tilt;
    for (const pivot of pivots.current) if (pivot) pivot.rotation.x = -lastTilt.current;
  });
  return <group>
    <mesh><boxGeometry args={[.16, .09, .22]} /><meshStandardMaterial color="#d9e1e8" roughness={.65} /></mesh>
    <mesh position={[0, .048, -.065]}><boxGeometry args={[.12, .008, .04]} /><meshBasicMaterial color={color} /></mesh>
    {isMorphQuad(model) ? <MorphQuadAirframe key={`${model}:${latest.generation}`} feed={feed} id={id} color={color} showThrust={showThrust} /> : voliro ? <>
      <mesh position={[0, 0, -.03]}><boxGeometry args={[.9, .025, .025]} /><meshStandardMaterial color="#303b48" /></mesh>
      <mesh position={[0, 0, .36]}><boxGeometry args={[.025, .025, .78]} /><meshStandardMaterial color="#303b48" /></mesh>
      {[-.45, .45].map((x, index) => <group key={x} name={`scene-tilt-${id}-${index}`} ref={node => { pivots.current[index] = node; }} position={[x, 0, -.03]}>
        <Rotor feed={feed} id={id} index={index === 1 ? 0 : 2} x={0} y={.055} z={0} />
        <Rotor feed={feed} id={id} index={index === 1 ? 1 : 3} x={0} y={-.055} z={0} />
        {showThrust && latest.tilt !== null && (propertyAgeMs(latest.tiltSampleAt) ?? Infinity) < STALE_MS && <ThrustArrow />}
      </group>)}
      <Rotor feed={feed} id={id} index={4} x={0} y={0} z={.75} radius={.0762} blades={3} />
    </> : multirotor ? <>
      {[-Math.PI / 4, Math.PI / 4].map(angle => <mesh key={angle} rotation={[0, angle, 0]}>
        <boxGeometry args={[.64, .024, .025]} /><meshStandardMaterial color="#35414f" />
      </mesh>)}
      {[-1, 1].flatMap((x, a) => [-1, 1].map((z, b) => <Rotor key={`${x}:${z}`} feed={feed} id={id} index={a * 2 + b} x={x * .225} y={0} z={z * .225} radius={.127} />))}
    </> : <>
      <mesh position={[0, 0, .12]}><boxGeometry args={[.12, .13, 1.15]} /><meshStandardMaterial color="#dbe4ed" /></mesh>
      <mesh position={[0, 0, -.05]}><boxGeometry args={[1.8, .035, .3]} /><meshStandardMaterial color={color} /></mesh>
      <mesh position={[0, .04, .62]}><boxGeometry args={[.65, .025, .18]} /><meshStandardMaterial color="#dbe4ed" /></mesh>
      <mesh position={[0, .16, .62]}><boxGeometry args={[.025, .28, .2]} /><meshStandardMaterial color={color} /></mesh>
      <group position={[0, 0, -.49]} rotation={[-Math.PI / 2, 0, 0]}><Rotor feed={feed} id={id} index={0} x={0} y={0} z={0} radius={.18} /></group>
    </>}
    {showAxes && <axesHelper args={[1]} quaternion={bodyToSceneBasis()} />}
  </group>;
}

function Aircraft({ id, feed, layers, selected, onSelect, revision, groundY, groundKnown, maps }: {
  id: string; feed: FlightSceneFeed; layers: SceneLayers; selected: boolean;
  onSelect: (id: string) => void; revision: number; groundY: number; groundKnown: boolean; maps: SceneSurfaceTextures;
}) {
  const group = useRef<Group>(null);
  const shadow = useRef<Mesh>(null), shadowMaterial = useRef<MeshBasicMaterial>(null);
  const latest = feed.aircraft.get(id)!.latest;
  const color = SCENE_COLORS[(Number(id) - 1) % SCENE_COLORS.length];
  const stale = performance.now() - latest.receivedAt > 2000;
  const trail = feed.aircraft.get(id)!.trail, lastTrail = trail[trail.length - 1];
  const points = useMemo(() => feed.origin ? trail.map(point => localPosition(point, feed.origin!)) : [], [feed.origin, trail, lastTrail]);
  useFrame(({ clock }) => {
    const sample = feed.sample(id, clock.oldTime);
    if (sample && group.current) { group.current.position.copy(sample.position); group.current.quaternion.copy(sample.quaternion); }
    if (shadow.current && shadowMaterial.current) {
      const height = sample ? sample.position.y - groundY : -1;
      shadow.current.visible = groundKnown && height >= 0 && height < 30;
      if (sample && shadow.current.visible) {
        // Soft reference-plane shade, aligned with the sun. No shadow-map pass.
        // Above the thin runway/pad overlays as well as the reference grass.
        shadow.current.position.set(sample.position.x + height * .5, groundY + .05, sample.position.z - height / 3);
        const size = /voliro/i.test(latest.model) ? 1.6 : 1.1;
        shadow.current.scale.set(size + height * .12, size + height * .09, 1);
        shadowMaterial.current.opacity = .42 * Math.max(0, 1 - height / 30);
      }
    }
  });
  return <>
    <mesh ref={shadow} name={`scene-ground-shade-${id}`} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
      <planeGeometry /><meshBasicMaterial ref={shadowMaterial} map={maps.shadow} color="#1b251d" transparent opacity={0} depthWrite={false} polygonOffset polygonOffsetFactor={-1} />
    </mesh>
    {layers.trails && points.length > 1 && <Line points={points} color={stale ? '#82919e' : color} lineWidth={1.4} transparent opacity={.7} />}
    <group ref={group} name={`scene-aircraft-${id}`} onClick={event => { event.stopPropagation(); onSelect(id); }}>
      <Airframe model={latest.model} color={stale ? '#89949f' : color} feed={feed} id={id} showThrust={layers.thrust && !stale} showAxes={layers.axes} />
      {layers.labels && <Html position={[0, .55, 0]} center zIndexRange={[20, 0]}>
        <button className={`scene-aircraft-label ${stale ? 'stale' : ''}`} style={{ borderColor: color }} onClick={() => onSelect(id)}>
          {id} · {latest.model}{stale ? ' · 数据过期' : ''}
        </button>
      </Html>}
    </group>
  </>;
}

function Rig({ feed, selected, mode, onFps, cameraVersion, groundAltitude }: Props) {
  const controls = useRef<any>(null);
  const previous = useRef(new Vector3());
  const reset = useRef(true);
  const fps = useRef({ elapsed: 0, frames: 0 });
  useEffect(() => { reset.current = true; }, [selected, mode, cameraVersion, feed.origin]);
  useFrame(({ camera, clock }, dt) => {
    fps.current.elapsed += dt; fps.current.frames++;
    if (fps.current.elapsed > 1) { onFps(Math.round(fps.current.frames / fps.current.elapsed)); fps.current = { elapsed: 0, frames: 0 }; }
    if (!controls.current) return;
    const sample = feed.sample(selected, clock.oldTime);
    const target = sample?.position ?? new Vector3(0, 1, 0);
    if (mode === 'cockpit' && sample) {
      camera.position.copy(new Vector3(0, .15, -.25).applyQuaternion(sample.quaternion).add(target));
      camera.up.copy(new Vector3(0, 1, 0).applyQuaternion(sample.quaternion));
      camera.lookAt(new Vector3(0, 0, -10).applyQuaternion(sample.quaternion).add(target));
    } else {
      camera.up.set(0, 1, 0);
      if (reset.current) {
        let offset = new Vector3(2.5, 1.8, 3.8);
        if (sample && mode === 'follow') offset.applyAxisAngle(new Vector3(0, 1, 0), -sample.pose.yaw * Math.PI / 180);
        let focus = target;
        if (mode === 'fleet') {
          const positions = [...feed.aircraft.keys()].map(id => feed.sample(id, clock.oldTime)?.position).filter((p): p is Vector3 => !!p);
          const center = positions.reduce((sum, p) => sum.add(p), new Vector3()).divideScalar(Math.max(1, positions.length));
          const extent = Math.max(12, ...positions.map(p => p.distanceTo(center)));
          focus = center; offset = new Vector3(extent * .5, extent * 1.3, extent * 1.7);
        }
        if (mode === 'ground') {
          const groundY = groundAltitude !== null && feed.origin ? groundAltitude - feed.origin.altitude : 0;
          offset = new Vector3(14, groundY + 2 - target.y, 18);
        }
        camera.position.copy(focus).add(offset); controls.current.target.copy(focus);
      } else if (mode === 'follow') {
        const delta = target.clone().sub(previous.current);
        camera.position.add(delta); controls.current.target.add(delta);
      } else if (mode === 'ground') controls.current.target.copy(target);
      controls.current.update();
    }
    previous.current.copy(target); reset.current = false;
  });
  return <OrbitControls ref={controls} makeDefault enabled={mode !== 'cockpit' && mode !== 'ground'} enableDamping dampingFactor={.12}
    minDistance={.4} maxDistance={1500} maxPolarAngle={Math.PI * (mode === 'ground' ? .99 : .495)} />;
}

export default function FlightSceneCanvas(props: Props) {
  const maps = useMemo(createSceneSurfaceTextures, []);
  useEffect(() => {
    const stop = loadSceneSurfaceTextures(maps);
    return () => { stop(); for (const map of Object.values(maps)) map.dispose(); };
  }, [maps]);
  const groundY = props.groundAltitude !== null && props.feed.origin ? props.groundAltitude - props.feed.origin.altitude : 0;
  return <Canvas className="flight-scene-webgl" dpr={[1, 1.5]} camera={{ position: [10, 8, 18], near: .05, far: 5000, fov: 55 }}
    gl={{ antialias: true, powerPreference: 'low-power' }}>
    <color attach="background" args={[SCENE_FOG.color]} /><fog attach="fog" args={[SCENE_FOG.color, SCENE_FOG.near, SCENE_FOG.far]} />
    <SceneSky maps={maps} />
    <hemisphereLight args={['#d6e7f5', '#74795e', 1.7]} /><directionalLight position={[-30, 60, 20]} intensity={2} color="#fff1d6" />
    <Field grid={props.layers.grid} groundY={groundY} maps={maps} />
    {[...props.feed.aircraft.keys()].map(id => <Aircraft key={id} id={id} {...props} selected={props.selected === id}
      groundY={groundY} groundKnown={props.groundAltitude !== null} maps={maps} />)}
    <Rig {...props} />
  </Canvas>;
}
