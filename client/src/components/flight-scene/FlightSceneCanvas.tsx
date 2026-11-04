import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Grid, Html, Line, OrbitControls } from '@react-three/drei';
import { ArrowHelper, BackSide, Group, Mesh, Vector3 } from 'three';
import { bodyToSceneBasis, FlightSceneFeed, localPosition, propertyAgeMs, SCENE_COLORS, STALE_MS, type CameraMode } from '../../sim/flightSceneState';

export type SceneLayers = { grid: boolean; trails: boolean; labels: boolean; thrust: boolean; axes: boolean };
type Props = {
  feed: FlightSceneFeed; revision: number; selected: string; onSelect: (id: string) => void;
  mode: CameraMode; layers: SceneLayers; onFps: (fps: number) => void; groundAltitude: number | null;
  cameraVersion: number;
};

function Rotor({ x, y, z, radius = .28 }: { x: number; y: number; z: number; radius?: number }) {
  return <group position={[x, y, z]}>
    <mesh><cylinderGeometry args={[.021, .021, .045, 10]} /><meshStandardMaterial color="#343e49" /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .027, 0]}>
      <circleGeometry args={[radius, 24]} /><meshBasicMaterial color="#dce8f2" transparent opacity={.19} depthWrite={false} side={2} />
    </mesh>
    <mesh position={[0, .029, 0]}><boxGeometry args={[radius * 1.9, .008, .024]} /><meshStandardMaterial color="#c5ced9" /></mesh>
  </group>;
}

function ThrustArrow() {
  const arrow = useMemo(() => new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), .8, '#22c8ce', .12, .07), []);
  useEffect(() => () => arrow.dispose(), [arrow]);
  return <primitive object={arrow} />;
}

function SceneSky() {
  const dome = useRef<Mesh>(null);
  useFrame(({ camera }) => { dome.current?.position.copy(camera.position); });
  return <mesh ref={dome} scale={2200} renderOrder={-1}>
    <sphereGeometry args={[1, 24, 16]} />
    <shaderMaterial side={BackSide} depthWrite={false}
      vertexShader={'varying vec3 direction; void main(){direction=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}'}
      fragmentShader={'varying vec3 direction;void main(){float h=normalize(direction).y;vec3 horizon=vec3(.58,.66,.73);vec3 zenith=vec3(.20,.30,.44);gl_FragColor=vec4(mix(horizon,zenith,smoothstep(0.0,.75,h)),1.0);}'} />
  </mesh>;
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
    {voliro ? <>
      <mesh position={[0, 0, -.03]}><boxGeometry args={[.9, .025, .025]} /><meshStandardMaterial color="#303b48" /></mesh>
      <mesh position={[0, 0, .36]}><boxGeometry args={[.025, .025, .78]} /><meshStandardMaterial color="#303b48" /></mesh>
      {[-.45, .45].map((x, index) => <group key={x} name={`scene-tilt-${id}-${index}`} ref={node => { pivots.current[index] = node; }} position={[x, 0, -.03]}>
        <Rotor x={0} y={.055} z={0} /><Rotor x={0} y={-.055} z={0} />
        {showThrust && latest.tilt !== null && (propertyAgeMs(latest.tiltSampleAt) ?? Infinity) < STALE_MS && <ThrustArrow />}
      </group>)}
      <Rotor x={0} y={0} z={.75} radius={.0762} />
    </> : multirotor ? <>
      {[-Math.PI / 4, Math.PI / 4].map(angle => <mesh key={angle} rotation={[0, angle, 0]}>
        <boxGeometry args={[.64, .024, .025]} /><meshStandardMaterial color="#35414f" />
      </mesh>)}
      {[-1, 1].flatMap(x => [-1, 1].map(z => <Rotor key={`${x}:${z}`} x={x * .225} y={0} z={z * .225} radius={.127} />))}
    </> : <>
      <mesh position={[0, 0, .12]}><boxGeometry args={[.12, .13, 1.15]} /><meshStandardMaterial color="#dbe4ed" /></mesh>
      <mesh position={[0, 0, -.05]}><boxGeometry args={[1.8, .035, .3]} /><meshStandardMaterial color={color} /></mesh>
      <mesh position={[0, .04, .62]}><boxGeometry args={[.65, .025, .18]} /><meshStandardMaterial color="#dbe4ed" /></mesh>
      <mesh position={[0, .16, .62]}><boxGeometry args={[.025, .28, .2]} /><meshStandardMaterial color={color} /></mesh>
    </>}
    {showAxes && <axesHelper args={[1]} quaternion={bodyToSceneBasis()} />}
  </group>;
}

function Aircraft({ id, feed, layers, selected, onSelect, revision }: {
  id: string; feed: FlightSceneFeed; layers: SceneLayers; selected: boolean;
  onSelect: (id: string) => void; revision: number;
}) {
  const group = useRef<Group>(null);
  const latest = feed.aircraft.get(id)!.latest;
  const color = SCENE_COLORS[(Number(id) - 1) % SCENE_COLORS.length];
  const stale = performance.now() - latest.receivedAt > 2000;
  const points = useMemo(() => feed.origin ? feed.aircraft.get(id)!.trail.map(point => localPosition(point, feed.origin!)) : [], [feed, id, revision]);
  useFrame(() => {
    const sample = feed.sample(id);
    if (sample && group.current) { group.current.position.copy(sample.position); group.current.quaternion.copy(sample.quaternion); }
  });
  return <>
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

function Field({ grid, groundY }: { grid: boolean; groundY: number }) {
  const trees = useMemo(() => Array.from({ length: 32 }, (_, i) => [90 + Math.sin(i * 17.1) * 90, -150 + Math.cos(i * 13.3) * 110]), []);
  return <group position={[0, groundY, 0]}>
    <mesh rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[4000, 4000]} /><meshStandardMaterial color="#536c5a" roughness={1} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={4} /></mesh>
    {grid && <Grid position={[0, .03, 0]} args={[500, 500]} cellSize={5} sectionSize={25}
      cellColor="#839a8b" sectionColor="#a2b4ad" cellThickness={.5} sectionThickness={.7}
      fadeDistance={250} fadeStrength={1.5} />}
    <mesh position={[50, .025, -100]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[18, 320]} /><meshStandardMaterial color="#52606b" /></mesh>
    {Array.from({ length: 15 }, (_, i) => <mesh key={i} position={[50, .04, 35 - i * 19]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[.28, 8]} /><meshBasicMaterial color="#dce4e7" />
    </mesh>)}
    <mesh position={[-10, .028, 5]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[8, 8]} /><meshStandardMaterial color="#687477" /></mesh>
    <group position={[-10, .04, 5]}>
      <mesh position={[-1.5, 0, 0]}><boxGeometry args={[.3, .02, 3.2]} /><meshBasicMaterial color="#e7dba3" /></mesh>
      <mesh position={[1.5, 0, 0]}><boxGeometry args={[.3, .02, 3.2]} /><meshBasicMaterial color="#e7dba3" /></mesh>
      <mesh><boxGeometry args={[3, .02, .3]} /><meshBasicMaterial color="#e7dba3" /></mesh>
    </group>
    <mesh position={[-35, 4, -50]}><boxGeometry args={[22, 8, 16]} /><meshStandardMaterial color="#7a8a97" /></mesh>
    <mesh position={[-35, 3, -41.95]}><boxGeometry args={[13, 6, .1]} /><meshStandardMaterial color="#364754" /></mesh>
    {trees.map(([x, z], i) => <group key={i} position={[x, 0, z]}>
      <mesh position={[0, 1.4, 0]}><cylinderGeometry args={[.22, .3, 2.8, 5]} /><meshStandardMaterial color="#645e4e" /></mesh>
      <mesh position={[0, 4, 0]}><coneGeometry args={[2, 5, 6]} /><meshStandardMaterial color={i % 2 ? '#425f4f' : '#3e584c'} /></mesh>
    </group>)}
  </group>;
}

function Rig({ feed, selected, mode, onFps, cameraVersion, groundAltitude }: Props) {
  const controls = useRef<any>(null);
  const previous = useRef(new Vector3());
  const reset = useRef(true);
  const fps = useRef({ elapsed: 0, frames: 0 });
  useEffect(() => { reset.current = true; }, [selected, mode, cameraVersion, feed.origin]);
  useFrame(({ camera }, dt) => {
    fps.current.elapsed += dt; fps.current.frames++;
    if (fps.current.elapsed > 1) { onFps(Math.round(fps.current.frames / fps.current.elapsed)); fps.current = { elapsed: 0, frames: 0 }; }
    if (!controls.current) return;
    const sample = feed.sample(selected);
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
          const positions = [...feed.aircraft.keys()].map(id => feed.sample(id)?.position).filter((p): p is Vector3 => !!p);
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
  const groundY = props.groundAltitude !== null && props.feed.origin ? props.groundAltitude - props.feed.origin.altitude : 0;
  return <Canvas className="flight-scene-webgl" dpr={[1, 1.5]} camera={{ position: [10, 8, 18], near: .05, far: 5000, fov: 55 }}
    gl={{ antialias: true, powerPreference: 'low-power' }}>
    <color attach="background" args={['#40546d']} /><fog attach="fog" args={['#627987', 180, 1300]} />
    <SceneSky />
    <hemisphereLight args={['#c3d9f4', '#4a5949', 1.7]} /><directionalLight position={[-30, 60, 20]} intensity={2} color="#ffebcd" />
    <Field grid={props.layers.grid} groundY={groundY} />
    {[...props.feed.aircraft.keys()].map(id => <Aircraft key={id} id={id} {...props} selected={props.selected === id} />)}
    <Rig {...props} />
  </Canvas>;
}
