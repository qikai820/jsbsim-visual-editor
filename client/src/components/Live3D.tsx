import { useRef, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import * as THREE from 'three';
import ParametricAircraft from './ParametricAircraft';
import type { Telemetry } from '../sim/useSimSocket';

const POS_SCALE = 0.01; // 米(ENU) -> 场景单位

interface Live3DProps {
  telemetry: Telemetry | null;
}

// 飞行体组：随遥测平移(本地ENU) + 旋转(姿态)
function Aircraft({ telemetry }: Live3DProps) {
  const groupRef = useRef<THREE.Group>(null);
  const telRef = useRef<Telemetry | null>(telemetry);
  const originRef = useRef<{ lat: number; lon: number; alt: number } | null>(null);

  useEffect(() => { telRef.current = telemetry; }, [telemetry]);

  useFrame(() => {
    const g = groupRef.current;
    const t = telRef.current;
    if (!g || !t) return;

    // 首次收到遥测记录起飞原点
    if (!originRef.current && t.pos) {
      originRef.current = { lat: t.pos[0], lon: t.pos[1], alt: t.pos[2] };
    }
    const o = originRef.current!;

    // 本地 ENU (平面近似)
    const dNorth = (t.pos[0] - o.lat) * 111320;
    const dEast = (t.pos[1] - o.lon) * 111320 * Math.cos((o.lat * Math.PI) / 180);
    const dUp = (t.pos[2] - o.alt);
    g.position.set(dEast * POS_SCALE, dUp * POS_SCALE, -dNorth * POS_SCALE);

    // 姿态 (JSBSim 欧拉角 phi/theta/psi -> Three Euler)
    // 注意：朝向符号约定待实机/仿真联调时校准
    const [phi, theta, psi] = t.att;
    g.rotation.set(theta, psi, phi, 'YXZ');
  });

  return (
    <group ref={groupRef}>
      <axesHelper args={[0.6]} />
      <ParametricAircraft showMarkers spinProp rpm={telemetry?.rpm || 0} />
    </group>
  );
}

export default function Live3D({ telemetry }: Live3DProps) {
  return (
    <Canvas
      camera={{ position: [1.2, 1.0, 1.6], fov: 55, near: 0.01, far: 500 }}
      style={{ background: 'linear-gradient(180deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1} />
      <Grid
        args={[40, 40]}
        position={[0, -0.01, 0]}
        cellSize={0.5}
        cellColor="#1e3a5f"
        sectionSize={2.5}
        sectionColor="#2d5a8e"
        fadeDistance={60}
        infiniteGrid
      />
      <Aircraft telemetry={telemetry} />
      <OrbitControls enableDamping dampingFactor={0.1} minDistance={0.3} maxDistance={200} />
    </Canvas>
  );
}
