import { useEffect, useState } from 'react';
import { ftpDownloadSimConfig, ftpDownloadXml, listRemoteXmlParent, isTauri } from '../../utils/tauriApi';
import { modelGeocentricToGpsLatitude } from '../../utils/fleetModelGroups';
import type { SceneDocument } from '../../sim/sceneDocument';
import { waitForSceneTask } from './sceneTask';

type Origin = NonNullable<SceneDocument['georeference']>;
type InitialGround = { elevation: number; latitude?: number; longitude?: number; geodetic: boolean };

export function sceneOriginFromModelConfig(config: unknown, ground: InitialGround): Origin {
  const initial = (config as { initial?: Record<string, unknown> } | null)?.initial;
  const latitude = initial?.latitudeDeg, longitude = initial?.longitudeDeg, altitude = initial?.altitudeM;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180
    || typeof altitude !== 'number' || !Number.isFinite(altitude) || Math.abs(altitude) > 100000
    || !Number.isFinite(ground.elevation) || Math.abs(ground.elevation) > 100000) {
    throw new Error('模型初始状态缺少有效的纬度、经度或海拔');
  }
  // The simulator applies only nonzero JSON overrides; zero retains the XML coordinate.
  const xmlLatitude = latitude === 0 ? ground.latitude : undefined;
  return {
    latitude: xmlLatitude !== undefined && ground.geodetic ? xmlLatitude
      : modelGeocentricToGpsLatitude(xmlLatitude ?? latitude, altitude || ground.elevation),
    longitude: longitude === 0 ? ground.longitude ?? longitude : longitude,
    altitude: ground.elevation,
  };
}

export function readSceneInitialGround(source: string): InitialGround | null {
  const xml = new DOMParser().parseFromString(source, 'application/xml');
  if (xml.querySelector('parsererror') || xml.documentElement.tagName !== 'initialize') throw new Error('模型地面初始化 XML 无效');
  const root = xml.documentElement;
  const elevation = [...root.children].find(child => child.tagName === 'elevation');
  if (!elevation) return null;
  const text = elevation.textContent?.trim() ?? '', value = Number(text);
  const unit = (elevation.getAttribute('unit') || 'FT').toUpperCase();
  if (!text || !Number.isFinite(value) || !['M', 'FT'].includes(unit)) throw new Error('模型地面高程或单位无效');
  const metres = value * (unit === 'FT' ? .3048 : 1);
  if (Math.abs(metres) > 100000) throw new Error('模型地面高程超出范围');
  const position = [...root.children].find(child => child.tagName === 'position') ?? root;
  const latitude = [...position.children].find(child => child.tagName === 'latitude');
  const longitude = [...position.children].find(child => child.tagName === 'longitude');
  const angle = (element: Element | undefined, limit: number) => {
    const text = element?.textContent?.trim();
    if (!text) return undefined;
    const unit = (element?.getAttribute('unit') || 'RAD').toUpperCase();
    if (unit !== 'DEG' && unit !== 'RAD') return undefined;
    const degrees = Number(text) * (unit === 'RAD' ? 180 / Math.PI : 1);
    return Number.isFinite(degrees) && Math.abs(degrees) <= limit ? degrees : undefined;
  };
  const latitudeType = latitude?.getAttribute('type');
  return { elevation: metres, latitude: angle(latitude, 90), longitude: angle(longitude, 180),
    geodetic: latitudeType === 'geod' || latitudeType === 'geodetic' };
}

export function sceneGroundFromInitialXml(source: string): number | null {
  return readSceneInitialGround(source)?.elevation ?? null;
}

async function readModelGround(model: string, signal: AbortSignal): Promise<InitialGround & { source: string }> {
  const parent = `aircraft/${model}`;
  const listing = await listRemoteXmlParent(parent);
  // List before reading so a missing companion cannot trigger slow transport
  // fallback. Ground initialization takes precedence over airborne/reset ICs.
  for (const name of ['initGrnd.xml', 'initfile.xml', 'reset.xml']) {
    const actual = listing.files.find(file => file.toLowerCase() === name.toLowerCase());
    if (!actual) continue;
    if (signal.aborted) throw new Error('已取消读取模型基准');
    const file = await ftpDownloadXml(`${parent}/${actual}`);
    const ground = readSceneInitialGround(file.content);
    if (ground !== null) return { ...ground, source: actual };
  }
  throw new Error('模型初始化文件未提供地面高程 elevation，请手动设置地图基准海拔');
}

export type SceneModelOrigin = {
  model: string; loading: boolean; error: string; origin?: Origin; groundSource?: string; refresh: () => void;
};

export function useSceneModelOrigin(model: string, enabled: boolean,
  applyOrigin: (origin: Origin | undefined) => void): SceneModelOrigin {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Omit<SceneModelOrigin, 'refresh'>>({ model: '', loading: false, error: '' });
  useEffect(() => {
    if (!enabled) return;
    applyOrigin(undefined);
    if (!model) { setResult({ model, loading: false, error: '' }); return; }
    if (!isTauri) { setResult({ model, loading: false, error: '请在桌面端连接仿真机后读取模型初始状态' }); return; }
    const controller = new AbortController();
    setResult({ model, loading: true, error: '' });
    const safeModel = model.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const read = async () => {
      // These requests share the simulator file channel; keep them sequential.
      const file = await ftpDownloadSimConfig(`config/models/${safeModel}.json`);
      if (controller.signal.aborted) throw new Error('已取消读取模型基准');
      const config = JSON.parse(file.content);
      const ground = await readModelGround(safeModel, controller.signal);
      return { config, ground };
    };
    void waitForSceneTask(read(), controller.signal, '读取模型初始状态与地面高程', undefined, 15_000)
      .then(({ config, ground }) => {
        if (controller.signal.aborted) return;
        const origin = sceneOriginFromModelConfig(config, ground);
        applyOrigin(origin); setResult({ model, origin, groundSource: ground.source, loading: false, error: '' });
      }).catch(error => {
        if (!controller.signal.aborted) setResult({ model, loading: false, error: `模型基准读取失败：${error instanceof Error ? error.message : String(error)}` });
      });
    return () => controller.abort();
  }, [model, enabled, revision, applyOrigin]);
  return { ...(result.model === model && enabled ? result : { model, loading: enabled && !!model, error: '' }), refresh: () => setRevision(value => value + 1) };
}
