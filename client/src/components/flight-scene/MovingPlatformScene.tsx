import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group } from 'three';
import { FlightSceneFeed } from '../../sim/flightSceneState';
import type { PlatformReading } from '../../sim/sceneMovingPlatform';
import { createMovingPlatformModel } from '../../sim/sceneMovingPlatformVisual';
import { useMovingPlatformAsset } from './useMovingPlatformAsset';

export default function MovingPlatformScene({ feed, id, reading }: { feed: FlightSceneFeed; id: string; reading: PlatformReading }) {
  const { model: source, error } = useMovingPlatformAsset();
  const signature = JSON.stringify(reading.geometry);
  const model = useMemo(() => source ? createMovingPlatformModel(source, reading.geometry) : null, [source, signature]);
  const root = useRef<Group>(null);
  useEffect(() => () => model?.dispose(), [model]);
  useFrame(({ clock }) => {
    if (!root.current) return;
    const platform = feed.sample(id, clock.oldTime)?.platform;
    root.current.visible = !!platform;
    if (!platform) return;
    root.current.position.copy(platform.position);
    root.current.quaternion.copy(platform.quaternion);
    Object.assign(root.current.userData, { sampleAt: platform.sampleAt, displayTime: platform.time, stale: platform.stale });
  });
  useEffect(() => { if (error) console.error('移动平台船模加载失败', error); }, [error]);
  return <group ref={root} name={`scene-moving-platform-${id}`} visible={false} dispose={null}>
    {model && <primitive object={model.root} />}
  </group>;
}
