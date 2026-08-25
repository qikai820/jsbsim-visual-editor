import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useFlowStore } from '../store/flowStore';
import { getComponentDef } from '../utils/componentDefs';
import type { AircraftNodeData } from '../types';

const SCALE = 0.01; // 英寸 -> 场景单位

// JSBSim 机体坐标 (X前/Y右/Z上) -> Three 世界坐标
function jsbToThree(x: number, y: number, z: number): [number, number, number] {
  return [y * SCALE, z * SCALE, -x * SCALE];
}

// 兼容 {value,unit} 与裸数
function num(v: any, d = 0): number {
  if (typeof v === 'number') return v;
  if (v && typeof v.value === 'number') return v.value;
  return d;
}
function locOf(params: any): { x: number; y: number; z: number } {
  const l = params?.location || params?.cg || { x: 0, y: 0, z: 0 };
  return { x: num(l.x, 0), y: num(l.y, 0), z: num(l.z, 0) };
}

const SPATIAL = ['fuselage', 'wing', 'htail', 'vtail', 'engine', 'propeller', 'landing_gear', 'fuel_tank', 'point_mass'];

interface Props {
  showMarkers?: boolean;
  selectedNodeId?: string | null;
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
  spinProp?: boolean;          // 螺旋桨是否旋转（实时模式）
  rpm?: number;                // 螺旋桨转速（来自遥测）
}

// 自旋螺旋桨（绕本地 Y 轴旋转；fixed-wing 的电机组会把它转到机头方向）
function SpinningProp({
  position, radius, rpm, dir = 1, spinProp = false, blades = 2, color = '#111',
}: {
  position: [number, number, number]; radius: number; rpm?: number;
  dir?: number; spinProp?: boolean; blades?: number; color?: string;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (spinProp && ref.current) {
      const w = rpm && rpm > 1 ? rpm * 0.02 : 3.0;
      ref.current.rotation.y += dir * w * dt;
    }
  });
  return (
    <group position={position}>
      <mesh>
        <cylinderGeometry args={[radius * 0.14, radius * 0.14, radius * 0.18, 12]} />
        <meshStandardMaterial color="#222" metalness={0.4} roughness={0.5} />
      </mesh>
      <group ref={ref}>
        {Array.from({ length: blades }).map((_, b) => (
          <mesh key={b} rotation={[0, (b * Math.PI * 2) / blades, 0]}>
            <boxGeometry args={[radius * 2, radius * 0.04, radius * 0.14]} />
            <meshStandardMaterial color={color} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

// ── 固定翼机体 ────────────────────────────────────────────────────────────
function FixedWingBody({ rpm, spinProp }: { rpm?: number; spinProp?: boolean }) {
  const nodes = useFlowStore((s) => s.nodes);
  const byType = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const n of nodes) (m[n.data.componentType] ||= []).push(n);
    return m;
  }, [nodes]);
  const get = (t: string) => byType[t]?.[0];
  const all = (t: string) => byType[t] || [];
  const wing = get('wing'); const htail = get('htail'); const vtail = get('vtail');
  const fus = get('fuselage'); const engines = all('engine'); const gears = all('landing_gear');

  const spanIn = wing ? num(wing.data.params.wingspan, 36) * 12 : 432;
  const chordIn = wing ? num(wing.data.params.chord, 4.9) * 12 : 59;
  const spanW = spanIn * SCALE; const chordW = chordIn * SCALE;
  const htailSpanW = (htail ? Math.sqrt(num(htail.data.params.htailarea, 22)) * 2 : 9.4) * SCALE;
  const htailChordW = (htail ? Math.sqrt(num(htail.data.params.htailarea, 22)) * 0.5 : 2.2) * SCALE;
  const vtailH = (vtail ? Math.sqrt(num(vtail.data.params.vtailarea, 16)) * 2 : 8.2) * SCALE;
  const vtailChordW = (vtail ? Math.sqrt(num(vtail.data.params.vtailarea, 16)) * 0.5 : 2.0) * SCALE;
  const wingLoc = wing ? locOf(wing.data.params) : { x: 0, y: 0, z: 0 };
  const htailLoc = htail ? locOf(htail.data.params) : { x: 105, y: 0, z: 4 };
  const vtailLoc = vtail ? locOf(vtail.data.params) : { x: 105, y: 0, z: 7 };

  const xs = [locOf(wing?.data.params).x, locOf(htail?.data.params).x, locOf(engines[0]?.data.params).x, locOf(fus?.data.params).x].filter((v) => v !== 0);
  const minX = xs.length ? Math.min(...xs) - 60 : -120;
  const maxX = xs.length ? Math.max(...xs) + 40 : 200;
  const Lbody = (maxX - minX) * SCALE;
  const bodyCenter = jsbToThree((minX + maxX) / 2, 0, locOf(fus?.data.params).z);
  const Rbody = Math.max(0.06, spanW * 0.045);

  // A small swept surface reads much more like an aircraft wing than a box.
  // The mesh is intentionally procedural so it remains usable with arbitrary
  // JSBSim XML files and does not require shipping a binary model asset.
  const wingShape = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(-0.5, 0);
    s.lineTo(0.5, 0);
    s.lineTo(0.42, 0.72);
    s.lineTo(0.1, 1);
    s.lineTo(-0.5, 1);
    s.closePath();
    return s;
  }, []);
  const wingExtrude = useMemo(() => ({ depth: 0.035, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.012, bevelThickness: 0.008 }), []);

  return (
    <group>
      <group position={bodyCenter}>
        {/* tapered nose and tail make the body read as an airframe */}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[Rbody, Rbody, Lbody * 0.7, 24]} />
          <meshStandardMaterial color="#cdd6e0" metalness={0.3} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0, -Lbody * 0.5]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[Rbody, Lbody * 0.22, 24]} />
          <meshStandardMaterial color="#cdd6e0" metalness={0.3} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0, Lbody * 0.5]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[Rbody * 0.5, Lbody * 0.18, 24]} />
          <meshStandardMaterial color="#cdd6e0" metalness={0.3} roughness={0.5} />
        </mesh>
        {/* cockpit canopy */}
        <mesh position={[0, Rbody * 0.72, -Lbody * 0.25]} scale={[0.72, 0.42, 1.25]}>
          <sphereGeometry args={[Rbody, 24, 16]} />
          <meshStandardMaterial color="#173b61" transparent opacity={0.82} metalness={0.35} roughness={0.12} />
        </mesh>
        <mesh position={[0, Rbody * 0.94, -Lbody * 0.02]} scale={[0.35, 0.08, 0.8]}>
          <boxGeometry args={[Rbody, Rbody * 0.08, Lbody * 0.22]} />
          <meshStandardMaterial color="#e8eef5" metalness={0.4} roughness={0.25} />
        </mesh>
      </group>

      {(
        <group position={jsbToThree(wingLoc.x, wingLoc.y, wingLoc.z)} rotation={[0, 0, Math.PI / 2]}>
          <mesh scale={[spanW, chordW, 1]}>
            <extrudeGeometry args={[wingShape, wingExtrude]} />
            <meshStandardMaterial color="#d7e0e8" metalness={0.35} roughness={0.42} />
          </mesh>
          {/* dark control surfaces */}
          <mesh position={[0.02, chordW * 0.34, 0.022]} scale={[spanW * 0.92, chordW * 0.18, 0.5]}>
            <boxGeometry args={[1, 1, 0.02]} />
            <meshStandardMaterial color="#536576" metalness={0.25} roughness={0.55} />
          </mesh>
          <mesh position={[spanW * 0.5, chordW * 0.45, 0.08]} rotation={[0, 0, -0.18]}>
            <boxGeometry args={[0.018, chordW * 0.42, 0.16]} />
            <meshStandardMaterial color="#b7c4cf" metalness={0.25} roughness={0.5} />
          </mesh>
          <mesh position={[-spanW * 0.5, chordW * 0.45, 0.08]} rotation={[0, 0, 0.18]}>
            <boxGeometry args={[0.018, chordW * 0.42, 0.16]} />
            <meshStandardMaterial color="#b7c4cf" metalness={0.25} roughness={0.5} />
          </mesh>
        </group>
      )}
      {(
        <mesh position={jsbToThree(htailLoc.x, htailLoc.y, htailLoc.z)} rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[htailSpanW, Rbody * 0.14, htailChordW]} />
          <meshStandardMaterial color="#5a6b7a" metalness={0.2} roughness={0.6} />
        </mesh>
      )}
      {(
        <mesh position={jsbToThree(vtailLoc.x, vtailLoc.y, vtailLoc.z)} rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[Rbody * 0.14, vtailH, vtailChordW]} />
          <meshStandardMaterial color="#5a6b7a" metalness={0.2} roughness={0.6} />
        </mesh>
      )}

      {engines.map((e, i) => {
        const l = locOf(e.data.params);
        const p = jsbToThree(l.x, l.y, l.z);
        return (
          <group key={e.id} position={p} rotation={[Math.PI / 2, 0, 0]}>
            <mesh>
              <cylinderGeometry args={[Rbody * 0.55, Rbody * 0.55, chordW * 0.9, 16]} />
              <meshStandardMaterial color="#2c3e50" metalness={0.5} roughness={0.4} />
            </mesh>
            <mesh position={[0, -chordW * 0.5, 0]}>
              <coneGeometry args={[Rbody * 0.3, Rbody * 0.5, 16]} />
              <meshStandardMaterial color="#1a2530" />
            </mesh>
            <SpinningProp position={[0, -chordW * 0.55, 0]} radius={Rbody * 1.3} rpm={rpm} spinProp={spinProp} blades={3} dir={i % 2 ? -1 : 1} />
          </group>
        );
      })}

      {gears.map((g) => {
        const l = locOf(g.data.params);
        const p = jsbToThree(l.x, l.y, l.z);
        return (
          <group key={g.id} position={p}>
            <mesh>
              <cylinderGeometry args={[Rbody * 0.05, Rbody * 0.05, Rbody * 1.2, 8]} />
              <meshStandardMaterial color="#444" />
            </mesh>
            <mesh position={[0, -Rbody * 0.6, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[Rbody * 0.35, Rbody * 0.35, Rbody * 0.18, 16]} />
              <meshStandardMaterial color="#111" />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

// ── 多旋翼机体（四/六/八旋翼等）── MicoAir 配置器风格 ─────────────────
function MultirotorBody({ rpm, spinProp }: { rpm?: number; spinProp?: boolean }) {
  const nodes = useFlowStore((s) => s.nodes);
  const motors = useMemo(
    () => nodes.filter((n) => n.data.componentType === 'engine').map((n) => jsbToThree(locOf(n.data.params).x, locOf(n.data.params).y, locOf(n.data.params).z)),
    [nodes],
  );
  const gears = useMemo(() => nodes.filter((n) => n.data.componentType === 'landing_gear').map((n) => jsbToThree(locOf(n.data.params).x, locOf(n.data.params).y, locOf(n.data.params).z)), [nodes]);

  const center: [number, number, number] = motors.length
    ? [motors.reduce((s, m) => s + m[0], 0) / motors.length, motors.reduce((s, m) => s + m[1], 0) / motors.length, motors.reduce((s, m) => s + m[2], 0) / motors.length]
    : [0, 0, 0];

  const armLen = motors.length ? Math.max(...motors.map((m) => Math.hypot(m[0] - center[0], m[1] - center[1]))) : 1;
  const hullR = Math.max(0.12, armLen * 0.22);
  const propR = Math.max(0.12, armLen * 0.55);
  const armR = hullR * 0.18;

  // Materials
  const bodyColor = '#2a2a2e';
  const plateColor = '#1a1a1e';
  const armColor = '#222226';
  const motorColor = '#888890';
  const motorTopColor = '#555560';
  const legColor = '#333338';
  const accentColor = '#e63946';

  return (
    <group>
      {/* ── 中央机身：圆润造型 ── */}
      <group position={center}>
        {/* 主体 */}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[hullR, hullR, hullR * 0.5, 32]} />
          <meshStandardMaterial color={bodyColor} metalness={0.6} roughness={0.25} />
        </mesh>
        {/* 顶板 */}
        <mesh position={[0, 0, hullR * 0.28]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[hullR * 0.92, hullR * 0.95, hullR * 0.08, 32]} />
          <meshStandardMaterial color={plateColor} metalness={0.7} roughness={0.2} />
        </mesh>
        {/* 底板 */}
        <mesh position={[0, 0, -hullR * 0.28]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[hullR * 0.88, hullR * 0.85, hullR * 0.06, 32]} />
          <meshStandardMaterial color={plateColor} metalness={0.7} roughness={0.2} />
        </mesh>
      </group>

      {/* ── 机臂 + 电机 + 螺旋桨 ── */}
      {motors.map((m, i) => {
        const dx = m[0] - center[0];
        const dy = m[1] - center[1];
        const dist = Math.hypot(dx, dy) || 0.001;
        const angle = Math.atan2(dy, dx);
        const mid: [number, number, number] = [(center[0] + m[0]) / 2, (center[1] + m[1]) / 2, (center[2] + m[2]) / 2];
        const motorH = hullR * 0.35;
        const motorR = propR * 0.16;

        return (
          <group key={i}>
            {/* 机臂 - 圆管 */}
            <mesh position={mid} rotation={[0, 0, angle]}>
              <cylinderGeometry args={[armR, armR, dist, 12]} />
              <meshStandardMaterial color={armColor} metalness={0.5} roughness={0.3} />
            </mesh>
            {/* 电机座 - 金属圆柱 */}
            <mesh position={[m[0], m[1], m[2] + motorH * 0.3]}>
              <cylinderGeometry args={[motorR, motorR * 1.15, motorH, 16]} />
              <meshStandardMaterial color={motorColor} metalness={0.85} roughness={0.15} />
            </mesh>
            {/* 电机顶盖 */}
            <mesh position={[m[0], m[1], m[2] + motorH * 0.65]}>
              <cylinderGeometry args={[motorR * 0.7, motorR, motorH * 0.15, 16]} />
              <meshStandardMaterial color={motorTopColor} metalness={0.9} roughness={0.1} />
            </mesh>
            {/* 螺旋桨 - 半透明 */}
            <SpinningProp
              position={[m[0], m[1], m[2] + motorH * 0.75]}
              radius={propR}
              rpm={rpm}
              spinProp={spinProp}
              blades={2}
              dir={i % 2 ? -1 : 1}
              color="#222"
            />
          </group>
        );
      })}

      {/* ── 起落架 ── */}
      {gears.length === 0 && motors.length > 0 && (
        motors.map((m, i) => {
          const dx = m[0] - center[0];
          const dy = m[1] - center[1];
          const angle = Math.atan2(dy, dx);
          const legH = hullR * 1.2;
          return (
            <group key={`leg-${i}`}>
              {/* 支撑杆 */}
              <mesh position={[m[0], m[1], m[2] - legH * 0.5]}>
                <cylinderGeometry args={[armR * 0.6, armR * 0.6, legH, 8]} />
                <meshStandardMaterial color={legColor} metalness={0.3} roughness={0.5} />
              </mesh>
              {/* 脚垫 */}
              <mesh position={[m[0], m[1], m[2] - legH]}>
                <sphereGeometry args={[armR * 1.2, 8, 8]} />
                <meshStandardMaterial color="#222" roughness={0.8} />
              </mesh>
            </group>
          );
        })
      )}
      {gears.map((p, i) => (
        <group key={`g-${i}`} position={p}>
          <mesh>
            <cylinderGeometry args={[hullR * 0.04, hullR * 0.04, hullR * 0.9, 8]} />
            <meshStandardMaterial color={legColor} metalness={0.3} roughness={0.5} />
          </mesh>
          <mesh position={[0, -hullR * 0.45, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <sphereGeometry args={[hullR * 0.12, 8, 8]} />
            <meshStandardMaterial color="#222" roughness={0.8} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export default function ParametricAircraft({
  showMarkers = true, selectedNodeId = null, onSelect, onHover, spinProp = false, rpm = 0,
}: Props) {
  const nodes = useFlowStore((s) => s.nodes);
  const aircraftType = useFlowStore((s) => s.aircraft.type);

  // ── 机型判定：多旋翼 vs 固定翼 ──
  // 优先使用解析出的 aircraft.type；并以节点结构兜底（如手工搭建的图）
  const isMultirotor = useMemo(() => {
    if (aircraftType === 'multirotor') return true;
    if (aircraftType && aircraftType !== 'fixed_wing') return false;
    const engines = nodes.filter((n) => n.data.componentType === 'engine');
    const brushless = engines.filter((n) => {
      const t = (n.data.params?.engine_type || '').toString();
      return t === 'brushless_dc' || t === 'electric';
    });
    const hasWing = nodes.some((n) => n.data.componentType === 'wing');
    const hasTail = nodes.some((n) => n.data.componentType === 'htail' || n.data.componentType === 'vtail');
    return brushless.length >= 2 || (engines.length >= 2 && !hasWing && !hasTail);
  }, [nodes, aircraftType]);

  const markers = nodes
    .filter((n) => SPATIAL.includes(n.data.componentType))
    .map((n) => {
      const def = getComponentDef(n.data.componentType);
      const l = locOf(n.data.params);
      return {
        id: n.id, type: n.data.componentType,
        pos: jsbToThree(l.x, l.y, l.z),
        color: def?.color || '#888', label: def?.icon || '',
        selected: n.id === selectedNodeId,
      };
    });

  return (
    <group>
      {isMultirotor
        ? <MultirotorBody rpm={rpm} spinProp={spinProp} />
        : <FixedWingBody rpm={rpm} spinProp={spinProp} />}

      {showMarkers && markers.map((m) => (
        <group key={m.id} position={m.pos}>
          <mesh
            onClick={(e: any) => { e.stopPropagation(); onSelect?.(m.id); }}
            onPointerOver={(e: any) => { e.stopPropagation(); onHover?.(m.id); }}
            onPointerOut={() => onHover?.(null)}
          >
            <sphereGeometry args={[0.08, 12, 12]} />
            <meshStandardMaterial
              color={m.color}
              emissive={m.selected ? '#fbbf24' : m.color}
              emissiveIntensity={m.selected ? 0.6 : 0.25}
            />
          </mesh>
          <Html position={[0, 0.12, 0]} center style={{ pointerEvents: 'none', userSelect: 'none' }}>
            <div style={{
              background: m.selected ? 'rgba(251,191,36,0.9)' : 'rgba(0,0,0,0.6)',
              color: m.selected ? '#000' : '#fff', padding: '1px 5px', borderRadius: 4,
              fontSize: 10, whiteSpace: 'nowrap', fontFamily: 'sans-serif',
            }}>{m.label}</div>
          </Html>
        </group>
      ))}
    </group>
  );
}
