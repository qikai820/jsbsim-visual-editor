import { invoke } from '@tauri-apps/api/core';
import { simGetStatus } from '../utils/tauriApi';
import { aborted, delay, type Px4Connection } from './connection';
import type { Px4Shell } from './shell';

export type FirmwareUsbTarget = {
  simulator: string;
  path: string;
  vid: number;
  pid: number;
  serialNumber: string | null;
  label: string;
};

export const MICOAIR_H743_V2_BOARD = 1179;

export function isMicoAirApplication(target: FirmwareUsbTarget) {
  return target.vid === 0x1b8c && target.pid === 0x0036;
}

export function isMicoAirBootloader(target: FirmwareUsbTarget) {
  return target.vid === 0x3162 && target.pid === 0x004b;
}

export async function rebootFirmwareTarget(
  target: FirmwareUsbTarget,
  link: Px4Connection,
  shell: Px4Shell,
  signal: AbortSignal,
  timeoutMs = 10000,
): Promise<FirmwareUsbTarget> {
  const assertConnected = () => {
    aborted(signal, link.signal);
    if (link.expectedHost !== target.simulator || !link.alive || link.armed !== false || Date.now() - link.lastHeartbeat > 2500) {
      throw Error('所选仿真机需要新鲜、上锁的双向飞控连接');
    }
  };
  if (!isMicoAirApplication(target)) throw Error('所选飞控不支持软件进入 Bootloader');
  assertConnected();
  const simulation = await simGetStatus();
  const controller = simulation.flightController;
  if (simulation.stopped !== true || simulation.running || simulation.paused) throw Error('请先停止仿真模型');
  if (!controller?.usb_connected || !controller.heartbeat_alive || controller.heartbeat_age_ms > 2500
      || controller.status_stale !== false || controller.armed !== false || controller.network_configured
      || controller.device_path !== target.path || controller.usb_vendor_id !== target.vid
      || controller.usb_product_id !== target.pid) {
    throw Error('仿真机上的飞控身份或上锁状态已变化');
  }

  const deadline = performance.now() + timeoutMs;
  let sent = false;
  let shellError = '';
  try {
    const result = await shell.runCommand('reboot -b', Math.min(timeoutMs, 1800), signal, () => {
      assertConnected();
      sent = true;
    });
    if (!result.succeeded) throw Error(result.output || '飞控拒绝进入 Bootloader');
  } catch (error) {
    if (!sent) throw error;
    // A successful reboot can disconnect NSH before it returns to the prompt.
    shellError = String(error);
  }
  await shell.close(false);

  do {
    aborted(signal);
    const ports = await invoke<FirmwareUsbTarget[]>('px4_firmware_ports');
    aborted(signal);
    const bootloader = ports.find(port => port.simulator === target.simulator && isMicoAirBootloader(port));
    if (bootloader) return bootloader;
    if (ports.some(port => port.simulator !== target.simulator)) throw Error('仿真机目标已变化');
    if (performance.now() < deadline) await delay(200, signal);
  } while (performance.now() < deadline);

  throw Error('已发送一次 reboot -b，未识别到 MicoAir H743-v2 Bootloader' + (shellError ? `（${shellError}）` : ''));
}
