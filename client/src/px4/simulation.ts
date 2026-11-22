import { aborted, delay, Px4Connection } from './connection';
import { command, view } from './protocol';
import { readParameter, writeParameter, type Parameter } from './services';
import type { Px4Shell } from './shell';

type GpsBackup = { version: 1; uid: string; gps1Config: number };
export type SimulationBackupStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type FlightControllerRebootOptions = {
  getLink: () => Px4Connection | null;
  signal: AbortSignal;
  progress: (message: string) => void;
  timeoutMs?: number;
};
export type SimulationSwitchOptions = {
  enabled: boolean;
  getLink: () => Px4Connection | null;
  getShell: () => Px4Shell | null;
  signal: AbortSignal;
  storage: SimulationBackupStore;
  progress: (message: string) => void;
  parameter?: (value: Parameter) => void;
  timeoutMs?: number;
};

const backupKey = (uid: string) => 'px4-hitl-gps-backup-v1:' + uid;
function loadBackup(storage: SimulationBackupStore, uid: string): GpsBackup | null {
  const raw = storage.getItem(backupKey(uid));
  if (raw === null) return null;
  const value = JSON.parse(raw) as GpsBackup;
  if (!value || value.version !== 1 || value.uid !== uid || !Number.isInteger(value.gps1Config) || value.gps1Config < 0 || value.gps1Config > 2147483647) throw Error('此飞控的 GPS 配置备份无效，未修改参数');
  return value;
}
function assertDisarmed(link: Px4Connection, signal: AbortSignal) {
  aborted(signal, link.signal);
  if (!link.alive || Date.now() - link.lastHeartbeat > 2500 || link.armed === undefined) throw Error('请等待飞控最新心跳后操作');
  if (link.armed) throw Error('飞控已解锁，请先上锁后操作');
}
async function deviceUid(link: Px4Connection, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    aborted(signal, link.signal);
    const control = new AbortController(), cancel = () => control.abort();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const waiting = link.wait(f => f.id === 148, 1200, control.signal); void waiting.catch(() => {});
      await link.requestMessage(148);
      const frame = await waiting, uid = view(frame.payload).getBigUint64(8, true);
      if (uid !== 0n) return uid.toString(16);
      // MAVLink 2 hardware UID is used by firmware that leaves the legacy UID empty.
      const uid2 = frame.payload.subarray(60, 78);
      if (uid2.some(byte => byte !== 0)) return Array.from(uid2, b => b.toString(16).padStart(2, '0')).join('');
      throw Error('飞控未提供硬件标识，无法安全保存和恢复 GPS 配置');
    } catch (e) { aborted(signal, link.signal); if (attempt === 2) throw e; }
    finally { control.abort(); signal.removeEventListener('abort', cancel); }
  }
  throw Error('无法识别飞控硬件');
}
async function reboot(link: Px4Connection, signal: AbortSignal): Promise<boolean> {
  assertDisarmed(link, signal);
  const control = new AbortController(), cancel = () => control.abort();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const waiting = link.wait(f => f.id === 77 && view(f.payload).getUint16(0, true) === 246 && f.payload[2] !== 5
      && (f.payload[8] === 0 || f.payload[8] === 254) && (f.payload[9] === 0 || f.payload[9] === 190), 2000, control.signal);
    void waiting.catch(() => {});
    // Send once: retrying an uncertain reboot can restart a newly booted flight controller.
    await link.send(76, command(link.target, 246, [1]));
    let result: number;
    try { result = (await waiting).payload[2]; }
    catch { aborted(signal); return false; } // ACK can be lost when the USB device restarts.
    if (result !== 0) throw Error(`飞控拒绝重启（结果 ${result}），请检查后重试`);
    return true;
  } finally { control.abort(); signal.removeEventListener('abort', cancel); }
}

async function rebootAndWait(options: FlightControllerRebootOptions, link: Px4Connection, uid: string, verify?: (current: Px4Connection) => Promise<void>): Promise<void> {
  const { getLink, signal, progress } = options;
  assertDisarmed(link, signal);
  const previous = { heartbeat: link.heartbeatGeneration, boot: link.bootGeneration, hil: link.hilEnabled };
  const sentAt = Date.now();
  progress('正在发送飞控重启指令…');
  const accepted = await reboot(link, signal);
  progress(accepted ? '飞控已接受重启，等待重新连接…' : '重启回执未收到，正在检查飞控是否重启…');
  const deadline = sentAt + (options.timeoutMs ?? 90000);
  let lastError = '';
  while (Date.now() < deadline) {
    aborted(signal);
    const current = getLink();
    if (current?.alive && current.lastHeartbeat > sentAt) {
      const restarted = current !== link || current.heartbeatGeneration !== previous.heartbeat || current.bootGeneration !== previous.boot
        || current.hilEnabled !== previous.hil;
      if (restarted) {
        try {
          progress('飞控已重新连接，正在核实状态…');
          if (await deviceUid(current, signal) !== uid) throw Error('重新连接的是另一块飞控，未确认本次重启');
          await verify?.(current);
          return;
        } catch (e) {
          aborted(signal);
          if (current.alive && !current.signal.aborted) throw e;
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
    }
    await delay(250, signal);
  }
  throw Error('等待飞控重启及状态确认超时，请检查转发链路后重新连接核实' + (lastError ? `：${lastError}` : ''));
}

export async function rebootFlightController(options: FlightControllerRebootOptions): Promise<string> {
  const link = options.getLink();
  if (!link) throw Error('请先连接飞控');
  assertDisarmed(link, options.signal);
  options.progress('正在确认飞控身份…');
  const uid = await deviceUid(link, options.signal);
  await rebootAndWait(options, link, uid);
  return '飞控已重启并重新连接，硬件身份已确认';
}

export async function switchSimulationMode(options: SimulationSwitchOptions): Promise<string> {
  const { enabled, getLink, getShell, signal, storage, progress, parameter = () => {} } = options;
  const link = getLink(), shell = getShell(), desired = enabled ? 1 : 0;
  if (!link || !shell) throw Error('请先连接飞控');
  assertDisarmed(link, signal);
  progress('正在读取飞控配置…');
  const uid = await deviceUid(link, signal), hitl = await readParameter(link, 'SYS_HITL', signal);
  if (hitl.type !== 6) throw Error('SYS_HITL 参数类型不受支持');
  parameter(hitl);
  const backup = loadBackup(storage, uid);
  if (hitl.value === desired && link.hilEnabled === enabled && (enabled || !backup)) return enabled ? '飞控已处于仿真模式' : '飞控已处于正常模式';

  const gps = await readParameter(link, 'GPS_1_CONFIG', signal);
  if (gps.type !== 6) throw Error('GPS_1_CONFIG 参数类型不受支持');
  let restoredGps: number | undefined, gpsNotice = '';
  if (enabled && !backup && !link.hilEnabled) {
    // Persist before touching SYS_HITL; a reload or failed reboot must retain the original port.
    const saved: GpsBackup = { version: 1, uid, gps1Config: gps.value };
    const text = JSON.stringify(saved); storage.setItem(backupKey(uid), text);
    if (storage.getItem(backupKey(uid)) !== text) throw Error('无法保存 GPS 配置备份，未修改参数');
  }
  if (!enabled && backup) {
    if (gps.value === 0 || gps.value === backup.gps1Config) {
      restoredGps = backup.gps1Config;
    } else {
      gpsNotice = '；保留当前手动修改的 GPS 端口配置';
    }
  } else if (!enabled) {
    gpsNotice = '；没有此飞控的进入前备份，GPS 端口配置保持当前值';
  }

  let wrote = false, rebootSent = false;
  try {
    if (restoredGps !== undefined && gps.value !== restoredGps) {
      assertDisarmed(link, signal); progress('正在恢复真实 GPS 端口…');
      await writeParameter(link, gps, restoredGps, signal, parameter); wrote = true;
    }
    assertDisarmed(link, signal); progress(enabled ? '正在启用仿真模式…' : '正在关闭仿真模式…');
    await writeParameter(link, hitl, desired, signal, parameter); wrote = true;
    assertDisarmed(link, signal); progress('正在保存飞控参数…');
    await shell.saveParameters(signal);
    assertDisarmed(link, signal);
    rebootSent = true;
    await rebootAndWait(options, link, uid, async current => {
      const actual = await readParameter(current, 'SYS_HITL', signal); parameter(actual);
      if (actual.value !== desired || current.hilEnabled !== enabled) throw Error(`重启后模式不符：SYS_HITL=${actual.value}，HIL=${current.hilEnabled ? '开' : '关'}，请检查固件和机型启动配置`);
      if (restoredGps !== undefined && (await readParameter(current, 'GPS_1_CONFIG', signal)).value !== restoredGps) throw Error('重启后 GPS 端口配置未恢复，请检查机型启动配置');
    });
    if (!enabled && backup) storage.removeItem(backupKey(uid));
    return (enabled ? '已进入仿真模式（HITL），飞控重启及模式已确认' : '已退出仿真模式，飞控重启及正常模式已确认') + gpsNotice;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw Error(wrote ? `${detail}；飞控参数可能已变更${rebootSent ? '' : '，未发送重启指令'}${backup || (enabled && !link.hilEnabled) ? '，GPS 备份已保留' : ''}` : detail);
  }
}
