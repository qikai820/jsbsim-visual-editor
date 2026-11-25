import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Group, type Object3D } from 'three';
import { platformGeometry } from '../sim/sceneMovingPlatform';
import { createMovingPlatformModel } from '../sim/sceneMovingPlatformVisual';
import { useMovingPlatformAsset } from './flight-scene/useMovingPlatformAsset';

function Vessel({ source, params, animate, collision }: { source: Object3D; params: Record<string, any>; animate: boolean; collision: boolean }) {
  const geometry = platformGeometry(params), signature = JSON.stringify(geometry);
  const model = useMemo(() => createMovingPlatformModel(source, geometry), [source, signature]);
  const root = useRef<Group>(null), time = useRef(0);
  useEffect(() => () => model.dispose(), [model]);
  useEffect(() => { model.collision.visible = collision; }, [model, collision]);
  useFrame((_, dt) => {
    if (!root.current) return;
    if (animate) time.current += Math.min(dt, .1); else time.current = 0;
    const mode = Number(params['scenario/mode'] ?? 0), custom = mode === 6, t = time.current;
    const wave = (key: string) => Math.sin(t * Math.PI * 2 / Math.max(.5, Number(params[`moving-platform/${key}-period-s`] ?? 4))
      + (custom ? Number(params[`moving-platform/${key}-phase-deg`] ?? 0) * Math.PI / 180 : 0));
    const roll = custom ? Number(params['scenario/custom/roll-deg'] ?? 1.71887) * Math.PI / 180 : mode < 2 ? 0 : mode === 3 ? .08 : .03;
    const pitch = custom ? Number(params['scenario/custom/pitch-deg'] ?? 1.14592) * Math.PI / 180 : mode < 2 ? 0 : mode === 3 ? .05 : .02;
    const heave = custom ? Number(params['scenario/custom/heave-m'] ?? .03) : mode < 2 ? 0 : mode === 3 ? .08 : .03;
    const fixedPitch = Number(params['moving-platform/fixed-pitch-deg'] ?? 0) * Math.PI / 180;
    const fixedRoll = Number(params['moving-platform/fixed-roll-deg'] ?? 0) * Math.PI / 180;
    root.current.rotation.set(
      fixedPitch + (animate ? pitch * wave('pitch') : 0),
      0,
      -(fixedRoll + (animate ? roll * wave('roll') : 0)),
      'YXZ',
    );
    root.current.position.y = animate ? heave * wave('heave') : 0;
  });
  return <group ref={root} dispose={null}><primitive object={model.root} /></group>;
}

export default function MovingPlatformPreview({ params, large = false }: { params: Record<string, any>; large?: boolean }) {
  const { model, error } = useMovingPlatformAsset(); const [animate, setAnimate] = useState(false), [collision, setCollision] = useState(false);
  const g = platformGeometry(params), radius = Math.max(8, g.length + 6, g.width + 3, g.rodLength * 2);
  return <section data-testid="moving-platform-preview" style={{ margin: '12px 0', border: '1px solid #38535c', borderRadius: 9, overflow: 'hidden', background: '#142a36' }}>
    <div style={{ height: large ? '68vh' : 240, minHeight: large ? 400 : 240, position: 'relative' }}>
      <Canvas camera={{ position: [radius * .8, radius * .65, radius * .9], fov: 42, near: .02, far: 10000 }} dpr={[1, 1.5]} gl={{ antialias: true }}>
        <color attach="background" args={['#142a36']} />
        <hemisphereLight args={['#d7efff', '#47626c', 2.4]} />
        <directionalLight position={[5, 12, 7]} intensity={3} color="#fff0d7" />
        {model && <Vessel source={model} params={params} animate={animate} collision={collision} />}
        <gridHelper args={[60, 60, '#355c6b', '#244451']} position={[0, -g.deckZ - 1.2, 0]} />
        <OrbitControls makeDefault target={[0, .2, -.7]} minDistance={.5} maxDistance={300} />
      </Canvas>
      {!model && <div role={error ? 'alert' : 'status'} style={{ position: 'absolute', top: '45%', width: '100%', textAlign: 'center', color: '#cfe1ec' }}>{error || '正在读取船模…'}</div>}
    </div>
    <div style={{ padding: '8px 10px', fontSize: 12, color: '#cbdde4', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <strong>工作船 · {g.length} × {g.width} m 甲板</strong>
      <button type="button" onClick={() => setAnimate(value => !value)} aria-pressed={animate}>{animate ? '停止摇摆预览' : '摇摆预览'}</button>
      <button type="button" onClick={() => setCollision(value => !value)} aria-pressed={collision}>碰撞网格</button>
      <span>拖动旋转 · 滚轮缩放</span>
      <span>Kenney · CC0 · 离线模型</span>
    </div>
    <p style={{ margin: '0 10px 10px', fontSize: 11, color: '#a8c1cb' }}>预览始终显示固定倾角，摇摆预览叠加所选场景运动。青色线框为船体与实体甲板碰撞范围，运行端需启用“船体网格与甲板降落”。</p>
  </section>;
}
