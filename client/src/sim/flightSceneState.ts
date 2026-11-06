import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { SCENE_POSE_KEYS, sceneSignalKeys } from './sceneSignals';
import { rotorCount, rotorRpmKey } from './sceneRotors';
import { ScenePlaybackClock } from './scenePlayback';
import { gimbalKey, isMorphQuad, MORPHQUAD_ARMS } from './sceneMorphQuad';

export type ScenePacket = Record<string, unknown>;
export type SceneOrigin = { latitude: number; longitude: number; altitude: number };
export type CameraMode = 'free' | 'follow' | 'ground' | 'cockpit' | 'fleet';
export type ScenePose = {
  id: string; model: string; generation: string; time: number; capture?: number;
  poseSource: 'telemetry' | 'monitor'; epoch?: number;
  receivedAt: number; state: string; latitude: number; longitude: number; altitude: number;
  roll: number; pitch: number; yaw: number; speed: number | null; verticalSpeed: number | null;
  agl: number | null; ground: number | null; tilt: number | null;
  motors: (number | null)[]; thrust: number | null;
  rpm: (number | null)[]; rpmSampleAt: (number | null)[]; rpmSense: (number | null)[];
  rpmModelVersion: number | null; rpmTailCalibrated: boolean | null;
  gimbals: { outer: number | null; inner: number | null; outerSampleAt: number | null; innerSampleAt: number | null }[];
  tiltSampleAt: number | null; motorSampleAt: (number | null)[];
  thrustSampleAt: number | null; groundSampleAt: number | null;
  tiltSource: 'monitor' | 'tree' | null;
};
type SceneAircraft = { latest: ScenePose; samples: ScenePose[]; trail: ScenePose[]; history: ScenePose[];
  retired: string[]; source: 'scene' | 'fallback'; telemetryTime?: number; playback: ScenePlaybackClock };
export const SCENE_COLORS = ['#3b82f6', '#12b9b1', '#e7a43a', '#a77beb', '#ee718b', '#63a878', '#6f91c6', '#bf946d'];
export const STALE_MS = 2000;
const rad = Math.PI / 180;
const basis = new Quaternion().setFromRotationMatrix(new Matrix4().set(
  0, 1, 0, 0, 0, 0, -1, 0, -1, 0, 0, 0, 0, 0, 0, 1,
));
const inverseBasis = basis.clone().invert();
export const bodyToSceneBasis = () => basis.clone();
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const number = (...values: unknown[]) => values.find(finite) as number | undefined;
const canonical = (path: string) => path.replace(/\[0\]/g, '').replace(/^\/(?:\d+\/)?jsbsim\//, '/');
const scenePropertyKeys = new Set([...sceneSignalKeys('voliro_t'), ...sceneSignalKeys('F450'), ...sceneSignalKeys('MorphQuad')].map(key => canonical('/' + key)));

export interface ScenePropertyReading { value: number; age: number; source: 'monitor' | 'tree' }
/** Keep measured values separate from freshness; a rotating tree is not a 2 s stream. */
export function scenePropertyReading(packet: ScenePacket, path: string): ScenePropertyReading | undefined {
  const properties = packet.properties as Record<string, unknown> | undefined;
  const ages = packet.scene_property_age_ms as Record<string, unknown> | undefined;
  const sources = packet.scene_property_sources as Record<string, unknown> | undefined;
  const target = canonical('/' + path.replace(/^\//, ''));
  for (const [key, value] of Object.entries(properties || {})) {
    const owner = key.match(/^\/(\d+)\//)?.[1];
    if (owner && Number(owner) !== Number(packet.instance_id ?? '01')) continue;
    if (canonical(key.startsWith('/') ? key : '/' + key) !== target || !finite(value)) continue;
    const age = ages?.[key];
    if (finite(age) && age >= 0) return { value, age: Math.max(age, finite(packet.age_ms) ? packet.age_ms : 0),
      source: sources?.[key] === 'monitor' ? 'monitor' : 'tree' };
  }
  return undefined;
}
export function sceneProperty(packet: ScenePacket, path: string): number | undefined {
  const reading = scenePropertyReading(packet, path);
  return reading && reading.age < STALE_MS ? reading.value : undefined;
}
export const propertyAgeMs = (sampleAt: number | null | undefined, now = performance.now()) => sampleAt == null ? null : Math.max(0, now - sampleAt);

// Legacy POSIX compact packets expose geocentric latitude. Convert the direction
// to WGS84 geodetic latitude using radial sea-level altitude (local-scene use).
export function geocentricLatitude(latitude: number, altitude = 0): number {
  const a = 6378137, e2 = 6.69437999014e-3, b = a * Math.sqrt(1 - e2);
  const beta = latitude * rad;
  const surfaceRadius = a * b / Math.hypot(b * Math.cos(beta), a * Math.sin(beta));
  const radius = surfaceRadius + altitude;
  const p = radius * Math.cos(beta), z = radius * Math.sin(beta);
  let phi = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    phi = Math.atan2(z + e2 * n * Math.sin(phi), p);
  }
  return phi / rad;
}

export function decodeScenePose(packet: ScenePacket, now: number): ScenePose | null {
  const idNumber = Number(packet.instance_id ?? '01');
  if (!Number.isInteger(idNumber) || idNumber < 1 || idNumber > 32) return null;
  const compact = Array.isArray(packet.pos) ? packet.pos : [];
  const attitude = Array.isArray(packet.att) ? packet.att : [];
  const altitude = number(packet.altitude_m, compact[2]);
  let latitude = number(packet.latitude_deg, compact[0]);
  const longitude = number(packet.longitude_deg, compact[1]);
  const roll = number(packet.roll_deg, finite(attitude[0]) ? attitude[0] / rad : undefined);
  const pitch = number(packet.pitch_deg, finite(attitude[1]) ? attitude[1] / rad : undefined);
  const yaw = number(packet.yaw_deg, finite(attitude[2]) ? attitude[2] / rad : undefined);
  const time = number(packet.timestamp, packet.t);
  if ([latitude, longitude, altitude, roll, pitch, yaw, time].some(v => v === undefined)) return null;
  if (Math.abs(latitude!) > 90 || Math.abs(longitude!) > 180) return null;
  if (!finite(packet.latitude_deg) && packet.latitude_kind !== 'geodetic') latitude = geocentricLatitude(latitude!, altitude);
  const groundFeet = scenePropertyReading(packet, 'position/terrain-elevation-asl-ft');
  const aglFeet = scenePropertyReading(packet, 'position/h-agl-ft');
  const ground = groundFeet === undefined ? null : groundFeet.value * .3048;
  const agl = aglFeet === undefined ? null : aglFeet.value * .3048;
  const tilt = scenePropertyReading(packet, 'fcs/voliro_t/pitch-rad');
  const motors = Array.from({ length: 5 }, (_, i) => scenePropertyReading(packet, `fcs/esc-out[${i}]`));
  const thrusts = Array.from({ length: 5 }, (_, i) => scenePropertyReading(packet, `fcs/voliro_t/thrust-lbf[${i}]`));
  const thrust = thrusts.every(reading => reading !== undefined)
    ? (thrusts as ScenePropertyReading[]).reduce((sum, reading) => sum + reading.value, 0) * 4.4482216153 : null;
  const model = typeof packet.model === 'string' ? packet.model : '未知机型';
  const rpm = Array.from({ length: rotorCount(model) }, (_, i) => scenePropertyReading(packet, rotorRpmKey(model, i)));
  const rpmSense = rpm.map((_, i) => scenePropertyReading(packet, `propulsion/engine[${i}]/propeller-sense`));
  const gimbals = isMorphQuad(model) ? MORPHQUAD_ARMS.map((_, i) => {
    const outer = scenePropertyReading(packet, gimbalKey(i, 'outer'));
    const inner = scenePropertyReading(packet, gimbalKey(i, 'inner'));
    return { outer: outer?.value ?? null, inner: inner?.value ?? null,
      outerSampleAt: outer ? now - outer.age : null, innerSampleAt: inner ? now - inner.age : null };
  }) : [];
  return {
    id: String(idNumber).padStart(2, '0'), model,
    generation: String(packet.tree_generation ?? ''), time: time!, capture: number(packet.capture_monotonic_us, packet.scene_sequence),
    poseSource: 'telemetry', epoch: number(packet.scene_epoch),
    receivedAt: now - Math.max(0, number(packet.age_ms) ?? 0), state: String(packet.state ?? 'running'),
    latitude: latitude!, longitude: longitude!, altitude: altitude!, roll: roll!, pitch: pitch!, yaw: yaw!,
    speed: number(packet.groundspeed_mps) ?? null, verticalSpeed: number(packet.vertical_speed_mps) ?? null,
    ground, agl, gimbals, tilt: tilt?.value ?? null, motors: motors.map(reading => reading?.value ?? null), thrust,
    rpm: rpm.map(reading => reading?.value ?? null), rpmSampleAt: rpm.map(reading => reading ? now - reading.age : null),
    rpmSense: rpmSense.map(reading => reading?.value === 1 || reading?.value === -1 ? reading.value : null),
    rpmModelVersion: scenePropertyReading(packet, 'fcs/voliro_t/rpm-model/version')?.value ?? null,
    rpmTailCalibrated: scenePropertyReading(packet, 'fcs/voliro_t/rpm-model/tail-calibrated')?.value == null ? null
      : scenePropertyReading(packet, 'fcs/voliro_t/rpm-model/tail-calibrated')!.value >= .5,
    tiltSampleAt: tilt ? now - tilt.age : null, motorSampleAt: motors.map(reading => reading ? now - reading.age : null),
    thrustSampleAt: thrust !== null ? now - Math.max(...thrusts.map(reading => reading!.age)) : null,
    groundSampleAt: groundFeet || aglFeet ? now - (groundFeet ?? aglFeet)!.age : null, tiltSource: tilt?.source ?? null,
  };
}

/** Local horizontal WGS84 tangent plane; preserve the simulator's altitude datum. */
export function localPosition(pose: Pick<ScenePose, 'latitude' | 'longitude' | 'altitude'>, origin: SceneOrigin): Vector3 {
  const ecef = (lat: number, lon: number) => {
    const phi = lat * rad, lambda = lon * rad, e2 = 6.69437999014e-3;
    const n = 6378137 / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    return [n * Math.cos(phi) * Math.cos(lambda), n * Math.cos(phi) * Math.sin(lambda), n * (1 - e2) * Math.sin(phi)];
  };
  const a = ecef(pose.latitude, pose.longitude), b = ecef(origin.latitude, origin.longitude);
  const [dx, dy, dz] = a.map((v, i) => v - b[i]);
  const phi = origin.latitude * rad, lambda = origin.longitude * rad;
  const east = -Math.sin(lambda) * dx + Math.cos(lambda) * dy;
  const north = -Math.sin(phi) * Math.cos(lambda) * dx - Math.sin(phi) * Math.sin(lambda) * dy + Math.cos(phi) * dz;
  return new Vector3(east, pose.altitude - origin.altitude, -north);
}

/** Body FRD -> NED aerospace ZYX -> Three.js right/up/aft model axes. */
export function sceneAttitude(pose: Pick<ScenePose, 'roll' | 'pitch' | 'yaw'>): Quaternion {
  const attitude = new Quaternion().setFromEuler(new Euler(pose.roll * rad, pose.pitch * rad, pose.yaw * rad, 'ZYX'));
  return basis.clone().multiply(attitude).multiply(inverseBasis);
}

export class FlightSceneFeed {
  readonly aircraft = new Map<string, SceneAircraft>();
  private monitor = new Map<string, { generation: string; revision: unknown; sequence: number; poseSequence: number; restart: boolean;
    values: Map<string, { value: number; seen: number; time: number; sequence: number }> }>();
  origin: SceneOrigin | null = null;
  /** Existing desktop binaries already provide the lossless monitor queue. */
  ingestMonitor(frame: ScenePacket, now = performance.now()): boolean {
    const instance = Number(frame.instance_id ?? 1);
    if (!Number.isInteger(instance) || instance < 1 || instance > 32 || typeof frame.model !== 'string') return false;
    const id = String(instance).padStart(2, '0');
    const entry = this.aircraft.get(id), monitor = frame.monitor as any;
    if (!monitor || monitor.version !== 1 || !Number.isSafeInteger(monitor.sequence) || !finite(frame.timestamp)) return false;
    const generation = `${frame.model}:${frame.tree_generation ?? ''}`;
    if (entry && generation !== `${entry.latest.model}:${entry.latest.generation}`) return false;
    if (entry?.retired.includes(generation)) return false;
    const previous = this.monitor.get(id);
    const same = previous?.generation === generation && previous.revision === monitor.revision;
    if (same && previous.sequence >= monitor.sequence) return false;
    const cache = same ? previous : { generation, revision: monitor.revision, sequence: -1, poseSequence: -1,
      restart: !!entry && Number.isSafeInteger(monitor.revision) && now - entry.latest.receivedAt >= STALE_MS
        && frame.timestamp < entry.latest.time - 1,
      values: new Map<string, { value: number; seen: number; time: number; sequence: number }>() };
    cache.sequence = monitor.sequence;
    for (const [path, tuple] of Object.entries(monitor.samples || {})) {
      const key = canonical(path.startsWith('/') ? path : '/' + path);
      const owner = path.match(/^\/(\d+)\//)?.[1];
      if (owner && Number(owner) !== Number(id) || !scenePropertyKeys.has(key)) continue;
      if (!Array.isArray(tuple) || tuple.length < 3 || !finite(tuple[0]) || !finite(tuple[1]) || tuple[1] > frame.timestamp + .001) {
        if ((SCENE_POSE_KEYS as readonly string[]).some(path => '/' + path === key)) cache.values.delete(key);
        continue;
      }
      const lag = Math.max(0, frame.timestamp - tuple[1]) * 1000;
      const old = cache.values.get(key);
      if (old && tuple[1] < old.time) continue;
      cache.values.set(key, { value: tuple[0], seen: now - Math.max(0, number(frame.age_ms) ?? 0) - lag,
        time: tuple[1], sequence: monitor.sequence });
    }
    this.monitor.set(id, cache);
    if (entry) entry.latest = this.withMonitor(entry.latest, now);
    // The monitor sends at most four channels per packet. Publish only after
    // all six measured pose channels have advanced, with bounded sample skew.
    // Servo-only traffic, cached IPC frames and partial cycles never revive pose.
    const samples = SCENE_POSE_KEYS.map(key => cache.values.get('/' + key));
    if (samples.every(sample => sample && sample.sequence > cache.poseSequence)) {
      const complete = samples as NonNullable<typeof samples[number]>[];
      const oldest = Math.min(...complete.map(sample => sample.seen));
      const newest = Math.max(...complete.map(sample => sample.seen));
      const firstTime = Math.min(...complete.map(sample => sample.time));
      const lastTime = Math.max(...complete.map(sample => sample.time));
      const current = entry?.latest;
      if (now - oldest < STALE_MS && newest - oldest <= 250
        && (!current || (cache.restart || firstTime >= current.time) && oldest > current.receivedAt)
        && ['running', 'paused'].includes(String(frame.state))) {
        const [latitude, longitude, altitude, roll, pitch, yaw] = complete.map(sample => sample.value);
        const decoded = decodeScenePose({ instance_id: id, model: frame.model, tree_generation: frame.tree_generation,
          timestamp: lastTime, latitude_deg: latitude, longitude_deg: longitude, altitude_m: altitude,
          roll_deg: roll / rad, pitch_deg: pitch / rad, yaw_deg: yaw / rad, state: frame.state }, now);
        if (decoded) {
          const pose = current && !cache.restart ? { ...current, latitude, longitude, altitude,
            roll: roll / rad, pitch: pitch / rad, yaw: yaw / rad, time: lastTime, state: String(frame.state) } : decoded;
          cache.poseSequence = monitor.sequence;
          this.commitPose(this.withMonitor({ ...pose, receivedAt: oldest, poseSource: 'monitor' }, now), entry, false, cache.restart, 'scene', now);
          cache.restart = false;
        }
      }
    }
    return true;
  }
  private withMonitor(pose: ScenePose, now: number): ScenePose {
    const cache = this.monitor.get(pose.id);
    if (!cache || cache.generation !== `${pose.model}:${pose.generation}` || !cache.values.size) return pose;
    const properties = Object.fromEntries([...cache.values].map(([key, sample]) => [key, sample.value]));
    const fast = decodeScenePose({ instance_id: pose.id, model: pose.model, tree_generation: pose.generation,
      timestamp: pose.time, latitude_deg: pose.latitude, longitude_deg: pose.longitude, altitude_m: pose.altitude,
      roll_deg: pose.roll, pitch_deg: pose.pitch, yaw_deg: pose.yaw, properties,
      scene_property_age_ms: Object.fromEntries([...cache.values].map(([key, sample]) => [key, Math.max(0, now - sample.seen)])),
      scene_property_sources: Object.fromEntries([...cache.values].map(([key]) => [key, 'monitor'])) }, now)!;
    const prefer = (fastAt: number | null, baseAt: number | null) => fastAt !== null &&
      (baseAt === null || fastAt > baseAt || now - fastAt < STALE_MS && pose.tiltSource !== 'monitor');
    const tilt = prefer(fast.tiltSampleAt, pose.tiltSampleAt), thrust = prefer(fast.thrustSampleAt, pose.thrustSampleAt);
    const ground = prefer(fast.groundSampleAt, pose.groundSampleAt);
    return { ...pose, ...(tilt ? { tilt: fast.tilt, tiltSampleAt: fast.tiltSampleAt, tiltSource: fast.tiltSource } : {}),
      ...(thrust ? { thrust: fast.thrust, thrustSampleAt: fast.thrustSampleAt } : {}),
      ...(ground ? { ground: fast.ground ?? pose.ground, agl: fast.agl ?? pose.agl, groundSampleAt: fast.groundSampleAt } : {}),
      motors: pose.motors.map((value, i) => prefer(fast.motorSampleAt[i], pose.motorSampleAt[i]) ? fast.motors[i] : value),
      motorSampleAt: pose.motorSampleAt.map((seen, i) => prefer(fast.motorSampleAt[i], seen) ? fast.motorSampleAt[i] : seen),
      rpm: pose.rpm.map((value, i) => prefer(fast.rpmSampleAt[i], pose.rpmSampleAt[i]) ? fast.rpm[i] : value),
      rpmSampleAt: pose.rpmSampleAt.map((seen, i) => prefer(fast.rpmSampleAt[i], seen) ? fast.rpmSampleAt[i] : seen),
      rpmSense: pose.rpmSense.map((sense, i) => fast.rpmSense[i] ?? sense),
      gimbals: pose.gimbals.map((gimbal, i) => {
        const sample = fast.gimbals[i];
        const newer = (fastAt: number | null, baseAt: number | null) => fastAt !== null && (baseAt === null || fastAt >= baseAt);
        const outer = newer(sample.outerSampleAt, gimbal.outerSampleAt), inner = newer(sample.innerSampleAt, gimbal.innerSampleAt);
        return { outer: outer ? sample.outer : gimbal.outer, inner: inner ? sample.inner : gimbal.inner,
          outerSampleAt: outer ? sample.outerSampleAt : gimbal.outerSampleAt, innerSampleAt: inner ? sample.innerSampleAt : gimbal.innerSampleAt };
      }),
      rpmModelVersion: fast.rpmModelVersion ?? pose.rpmModelVersion,
      rpmTailCalibrated: fast.rpmTailCalibrated ?? pose.rpmTailCalibrated };
  }
  ingest(packet: ScenePacket, now = performance.now(), source: 'scene' | 'fallback' = 'scene'): boolean {
    let pose = decodeScenePose(packet, now);
    if (!pose) return false;
    const existing = this.aircraft.get(pose.id);
    // Ordinary telemetry is compatibility input. Once this aircraft has a
    // dedicated scene stream, its pose/property cache and ages are authoritative.
    // Mixing newer fallback poses with it briefly blanks all optional fields.
    if (source === 'fallback' && existing?.source === 'scene') return false;
    const key = (p: ScenePose) => `${p.model}:${p.generation}`;
    const previous = existing?.latest;
    // Never let a continuously rebroadcast native cache undo a newer measured pose.
    if (previous && pose.receivedAt < previous.receivedAt - 1) return false;
    if (previous?.epoch !== undefined && pose.epoch !== undefined && pose.epoch < previous.epoch) return false;
    const restarted = previous?.epoch !== undefined && pose.epoch !== undefined && pose.epoch > previous.epoch;
    if (!restarted && existing?.retired.includes(key(pose))) return false;
    const changed = previous && key(previous) !== key(pose);
    // A delayed core frame can lag a monitored pose. Detect simulator resets
    // against the last core time, rather than treating that lag as a restart.
    const rewound = restarted || previous && pose.time < (existing!.telemetryTime ?? previous.time) - 1
      && pose.capture !== undefined && previous.capture !== undefined && pose.capture > previous.capture;
    if (changed || rewound) this.monitor.delete(pose.id);
    pose = this.withMonitor(pose, now);
    if (previous && !changed && !rewound) {
      if (pose.capture !== undefined && previous.capture !== undefined && pose.capture < previous.capture) return false;
      if (pose.time < previous.time) return false;
      if (pose.time === previous.time && pose.capture === previous.capture) {
        if (source === 'scene') existing!.source = 'scene';
        // Cached IPC snapshots carry increasing age_ms. Never revive a stale pose.
        if (packet.scene_property_age_ms) {
          existing!.latest = this.withMonitor({ ...previous, state: pose.state, tilt: pose.tilt, motors: pose.motors,
            thrust: pose.thrust, ground: pose.ground, agl: pose.agl, tiltSampleAt: pose.tiltSampleAt,
            motorSampleAt: pose.motorSampleAt, thrustSampleAt: pose.thrustSampleAt,
            groundSampleAt: pose.groundSampleAt, tiltSource: pose.tiltSource,
            rpm: pose.rpm, rpmSampleAt: pose.rpmSampleAt, rpmSense: pose.rpmSense,
            gimbals: pose.gimbals,
            rpmModelVersion: pose.rpmModelVersion, rpmTailCalibrated: pose.rpmTailCalibrated }, now);
        }
        return false;
      }
    }
    this.commitPose(pose, existing, !!changed, !!rewound, source, now);
    return true;
  }
  private commitPose(pose: ScenePose, existing: SceneAircraft | undefined, changed: boolean, rewound: boolean, source: 'scene' | 'fallback', now: number) {
    const entry: SceneAircraft = !existing || changed || rewound
      ? { latest: pose, samples: [], trail: [], history: [], retired: rewound ? [] : changed ? [...existing!.retired, `${existing!.latest.model}:${existing!.latest.generation}`].slice(-8) : existing?.retired || [], source, playback: new ScenePlaybackClock() }
      : existing;
    if (entry.samples.length && (pose.receivedAt - entry.latest.receivedAt >= STALE_MS
      || pose.state !== entry.latest.state)) {
      // Resume from the new measured pose, without interpolating through a pause
      // or replaying the samples retained from before a connection outage.
      entry.samples = [];
      entry.playback = new ScenePlaybackClock();
    }
    entry.source = source;
    entry.latest = pose;
    if (pose.poseSource === 'telemetry') entry.telemetryTime = pose.time;
    entry.samples.push(pose);
    if (entry.samples.length > 64) entry.samples.shift();
    entry.playback.observe(entry.samples, now);
    const lastHistory = entry.history[entry.history.length - 1];
    if (!lastHistory || pose.time - lastHistory.time >= .1) entry.history.push(pose);
    if (entry.history.length > 300) entry.history.shift();
    const last = entry.trail[entry.trail.length - 1];
    if (!last || (pose.time > last.time + .15 && localPosition(pose, { ...last }).distanceTo(new Vector3()) > .08)) entry.trail.push(pose);
    if (entry.trail.length > 600) entry.trail.shift();
    this.aircraft.set(pose.id, entry);
    if (!this.origin) this.recenter(pose.id);
  }
  recenter(id: string) {
    const pose = this.aircraft.get(id)?.latest;
    if (pose) this.origin = { latitude: pose.latitude, longitude: pose.longitude,
      altitude: pose.ground ?? (pose.agl === null ? pose.altitude : pose.altitude - pose.agl) };
  }
  clearTrails() { for (const item of this.aircraft.values()) item.trail = []; }
  sample(id: string, now = performance.now()) {
    const entry = this.aircraft.get(id);
    if (!entry || !this.origin) return null;
    const latest = entry.latest;
    const stale = now - latest.receivedAt > STALE_MS;
    const target = entry.playback.sample(entry.samples, now, latest.state !== 'running' || stale);
    let a = entry.samples[0], b = latest;
    for (let i = 1; i < entry.samples.length; i++) {
      if (entry.samples[i].time >= target) { a = entry.samples[i - 1]; b = entry.samples[i]; break; }
    }
    const fraction = a === b || b.time <= a.time ? 1 : Math.max(0, Math.min(1, (target - a.time) / (b.time - a.time)));
    return { time: target, position: localPosition(a, this.origin).lerp(localPosition(b, this.origin), fraction),
      quaternion: sceneAttitude(a).slerp(sceneAttitude(b), fraction), stale, pose: latest };
  }
}

export function demoPackets(time: number): ScenePacket[] {
  return Array.from({ length: 8 }, (_, i) => {
    const north = i === 0 ? Math.sin(time * .08) * 8 : 24 + Math.floor((i - 1) / 3) * 18;
    const east = i === 0 ? Math.cos(time * .08) * 8 : ((i - 1) % 3 - 1) * 16;
    const properties: Record<string, number> = { '/position/terrain-elevation-asl-ft': 582.6 / .3048, '/position/h-agl-ft': (12.4 + Math.sin(time * .2 + i) * .3) / .3048 };
    if (i === 0) {
      properties['/fcs/voliro_t/pitch-rad'] = (18 + Math.sin(time * .3) * 4) * rad;
      for (let m = 0; m < 5; m++) { properties[`/fcs/esc-out[${m}]`] = m === 4 ? -.08 : .5 + Math.sin(time + m) * .04; properties[`/fcs/voliro_t/thrust-lbf[${m}]`] = m === 4 ? -.1 : 2.9; }
    }
    const model = i === 0 ? 'voliro_t' : i === 7 ? 'MorphQuad' : 'F450';
    if (isMorphQuad(model)) MORPHQUAD_ARMS.forEach((_, arm) => {
      properties[gimbalKey(arm, 'outer')] = Math.sin(time * .45 + arm) * .6;
      properties[gimbalKey(arm, 'inner')] = Math.cos(time * .35 + arm) * .35;
    });
    for (let m = 0; m < rotorCount(model); m++) {
      properties[rotorRpmKey(model, m)] = i === 0 && m === 4 ? -4200 : 2800 + Math.sin(time + m) * 200;
      if (i !== 0) properties[`/propulsion/engine[${m}]/propeller-sense`] = isMorphQuad(model)
        ? MORPHQUAD_ARMS[Math.floor(m / 2)].senses[m % 2] : [1, -1, -1, 1][m];
    }
    return { instance_id: String(i + 1).padStart(2, '0'), model, tree_generation: 'demo',
      timestamp: time, capture_monotonic_us: time * 1e6, state: 'running', latitude_deg: 34.07189 + north / 110_900,
      longitude_deg: 108.99734 + east / 92_300, altitude_m: 595 + Math.sin(time * .2 + i) * .3,
      roll_deg: Math.sin(time * .4 + i) * 2.3, pitch_deg: -5.6 + Math.cos(time * .3) * 1.2, yaw_deg: 86.2,
      groundspeed_mps: 2.8, vertical_speed_mps: Math.cos(time * .2 + i) * .06, properties,
      scene_property_age_ms: Object.fromEntries(Object.keys(properties).map(key => [key, 0])) };
  });
}
