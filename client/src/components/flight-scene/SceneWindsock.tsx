import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Float32BufferAttribute, Group, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { FlightSceneFeed } from '../../sim/flightSceneState';
import { windReading, windsockCenter } from '../../sim/sceneWind';

const bands = 5, segments = 4, sides = 16;
function clothGeometry() {
  const geometry = new BufferGeometry(), colors: number[] = [], index: number[] = [];
  for (let band = 0; band < bands; band++) {
    const color = new Color(band % 2 ? '#f5f1df' : '#ec4b27');
    for (let row = 0; row <= segments; row++) for (let side = 0; side <= sides; side++) {
      colors.push(color.r, color.g, color.b);
      if (row < segments && side < sides) {
        const a = (band * (segments + 1) + row) * (sides + 1) + side, b = a + sides + 1;
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(colors.length), 3).setUsage(DynamicDrawUsage));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  return geometry;
}
function shapeCloth(geometry: BufferGeometry, inflation: number, elevation: number, phase: number) {
  const position = geometry.getAttribute('position');
  for (let band = 0; band < bands; band++) for (let row = 0; row <= segments; row++) {
    const t = (band + row / segments) / bands, [x, y] = windsockCenter(t, inflation, elevation);
    const radius = (.30 - .19 * t) * (1 - .8 * (1 - inflation) * t);
    const flutter = inflation * t * t * .045;
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * Math.PI * 2;
      const ripple = 1 + .045 * inflation * t * Math.sin(phase * 7 - t * 12 + angle * 3);
      const i = (band * (segments + 1) + row) * (sides + 1) + side;
      position.setXYZ(i, .38 + x, y + Math.cos(angle) * radius * ripple + flutter * Math.sin(phase * 6 - t * 8),
        Math.sin(angle) * radius * ripple + flutter * Math.sin(phase * 8 - t * 10));
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

/** World wind drives the bearing, independently of the editable pole yaw. */
export default function SceneWindsock({ feed, instance, name }: { feed: FlightSceneFeed; instance: string; name: string }) {
  const bearing = useRef<Group>(null), material = useRef<MeshStandardMaterial>(null);
  const cloth = useMemo(() => { const geometry = clothGeometry(); shapeCloth(geometry, 0, 0, 0); return geometry; }, []);
  const motion = useRef({ yaw: 0, inflation: 0, elevation: 0, phase: 0, initialized: false });
  const scratch = useMemo(() => ({ parent: new Matrix4(), worldMatrix: new Matrix4(), world: new Quaternion(),
    scale: new Vector3(), mount: new Vector3(), up: new Vector3(0, 1, 0) }), []);
  useEffect(() => () => cloth.dispose(), [cloth]);
  useFrame((_, dt) => {
    const group = bearing.current;
    if (!group) return;
    const pose = feed.aircraft.get(instance)?.latest, wind = windReading(pose), state = motion.current;
    const blend = 1 - Math.exp(-Math.min(dt, .1) / .35);
    if (wind.fresh && (!state.initialized || wind.moving)) {
      const target = wind.yaw ?? state.yaw;
      const delta = Math.atan2(Math.sin(target - state.yaw), Math.cos(target - state.yaw));
      state.yaw += state.initialized ? delta * blend : delta;
      state.inflation += (wind.inflation - state.inflation) * (state.initialized ? blend : 1);
      state.elevation += (wind.elevation - state.elevation) * (state.initialized ? blend : 1);
      state.initialized = true;
      if (wind.moving) state.phase += Math.min(dt, .1);
      shapeCloth(cloth, state.inflation, state.elevation, state.phase);
    }
    group.parent!.updateWorldMatrix(true, false);
    group.parent!.getWorldScale(scratch.scale);
    scratch.mount.set(0, 3.14, 0).applyMatrix4(group.parent!.matrixWorld);
    scratch.world.setFromAxisAngle(scratch.up, state.yaw);
    // Compose the bearing in world space. Cancelling only the pole quaternion
    // would still skew the wind direction when its X/Z scales differ.
    scratch.worldMatrix.compose(scratch.mount, scratch.world, scratch.scale);
    group.matrix.multiplyMatrices(scratch.parent.copy(group.parent!.matrixWorld).invert(), scratch.worldMatrix);
    Object.assign(group.userData, { instance, speed: wind.speed, horizontal: wind.horizontal, fromDegrees: wind.fromDegrees,
      fresh: wind.fresh, moving: wind.moving, inflation: state.inflation, yaw: state.yaw });
    material.current?.color.set(wind.fresh ? '#ffffff' : '#959da4');
  });
  return <group name={name}>
    <mesh position={[0, .07, 0]}><cylinderGeometry args={[.24, .28, .14, 12]} /><meshStandardMaterial color="#a6aaa2" roughness={.9} /></mesh>
    <mesh position={[0, 1.75, 0]}><cylinderGeometry args={[.032, .055, 3.4, 10]} /><meshStandardMaterial color="#d7dfdf" metalness={.6} roughness={.4} /></mesh>
    <mesh position={[0, 3.49, 0]}><sphereGeometry args={[.055, 8, 6]} /><meshStandardMaterial color="#d7dfdf" metalness={.6} roughness={.4} /></mesh>
    <group ref={bearing} matrixAutoUpdate={false} name={`${name}-bearing`}>
      <mesh position={[.19, .32, 0]}><boxGeometry args={[.46, .025, .025]} /><meshStandardMaterial color="#919b9e" metalness={.65} roughness={.4} /></mesh>
      <mesh position={[.38, 0, 0]} rotation={[0, Math.PI / 2, 0]}><torusGeometry args={[.3, .012, 6, 24]} /><meshStandardMaterial color="#d4dbd9" metalness={.6} roughness={.4} /></mesh>
      <mesh geometry={cloth} name={`${name}-cloth`}><meshStandardMaterial ref={material} vertexColors side={DoubleSide} roughness={.95} metalness={0} /></mesh>
    </group>
  </group>;
}
