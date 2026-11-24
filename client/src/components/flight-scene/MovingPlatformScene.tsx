import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Group, Vector3 } from 'three';
import { FlightSceneFeed, localPosition, sceneAttitude } from '../../sim/flightSceneState';
import type { PlatformReading } from '../../sim/sceneMovingPlatform';
import { createMovingPlatformModel } from '../../sim/sceneMovingPlatformVisual';
import { useMovingPlatformAsset } from './useMovingPlatformAsset';

export default function MovingPlatformScene({ feed, id, reading }: { feed: FlightSceneFeed; id: string; reading: PlatformReading }) {
  const { model: source, error } = useMovingPlatformAsset();
  const signature = JSON.stringify(reading.geometry);
  const model = useMemo(() => source ? createMovingPlatformModel(source, reading.geometry) : null, [source, signature]);
  const root = useRef<Group>(null), key = useRef('');
  const anchor = useRef<{ latitude: number; longitude: number; altitude: number }>();
  const relative = useRef(new Vector3());
  useEffect(() => () => model?.dispose(), [model]);
  useFrame(() => {
    const pose = feed.aircraft.get(id)?.latest, platform = pose?.platform;
    if (!root.current || !pose || !platform || !feed.origin) return;
    root.current.visible = pose.platformEnabled !== false;
    const currentKey = `${pose.generation}:${platform.sampleAt}`;
    // Hold the entire platform pose if its stream stops while the aircraft continues.
    if (!anchor.current || key.current !== currentKey && performance.now() - platform.sampleAt < 2000) {
      key.current = currentKey; anchor.current = { latitude: pose.latitude, longitude: pose.longitude, altitude: pose.altitude };
      const [roll, pitch, yaw] = platform.angles.map(v => v * 180 / Math.PI);
      root.current.quaternion.copy(sceneAttitude({ roll, pitch, yaw }));
      const [north, east, down] = platform.relative;
      relative.current.set(east, -down, -north).applyQuaternion(root.current.quaternion);
      root.current.userData.sampleAt = platform.sampleAt;
    }
    // Recentring the view still transforms the frozen measured world position.
    root.current.position.copy(localPosition(anchor.current, feed.origin)).sub(relative.current);
  });
  useEffect(() => { if (error) console.error('移动平台船模加载失败', error); }, [error]);
  return <group ref={root} name={`scene-moving-platform-${id}`} visible={false} dispose={null}>
    {model && <primitive object={model.root} />}
  </group>;
}
