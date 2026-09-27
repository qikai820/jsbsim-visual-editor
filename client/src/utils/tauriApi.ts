/** Tauri desktop IPC adapter. The standalone HTTP/web edition is removed. */

// Detect Tauri runtime
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const REMOTE_UPLOAD_KEY = 'jsbsim-remote-upload-enabled';
const SIMULATOR_TRANSPORT_KEY = 'jsbsim-simulator-transport';

export type SimulatorTransportMode = 'auto' | 'network' | 'usb';

// Writing to the NuttX SD card is opt-in. Until the user enables it in the
// local settings the editor treats the simulator model data as read-only.
export function isRemoteUploadEnabled(): boolean {
  return localStorage.getItem(REMOTE_UPLOAD_KEY) === 'true';
}

export function setRemoteUploadEnabled(enabled: boolean): void {
  localStorage.setItem(REMOTE_UPLOAD_KEY, String(enabled));
}

export function getSimulatorTransportMode(): SimulatorTransportMode {
  const value = localStorage.getItem(SIMULATOR_TRANSPORT_KEY);
  return value === 'network' || value === 'usb' ? value : 'auto';
}

// Lazy-load Tauri APIs (only available inside Tauri)
let tauriInvoke: any = null;
let tauriListen: any = null;

async function ensureTauri() {
  if (tauriInvoke) return;
  const api = await import('@tauri-apps/api/core');
  tauriInvoke = api.invoke;
  const event = await import('@tauri-apps/api/event');
  tauriListen = event.listen;
}

// ── Generic Tauri invoke wrapper ───────────────────────────────────────────

async function call(command: string, args: Record<string, any> = {}): Promise<any> {
  if (!isTauri) throw new Error('此编辑器仅支持 Tauri 桌面端运行。');
  await ensureTauri();
  return tauriInvoke(command, args);
}

export async function setSimulatorTransportMode(mode: SimulatorTransportMode): Promise<void> {
  await call('simulator_transport_set', { mode });
  localStorage.setItem(SIMULATOR_TRANSPORT_KEY, mode);
}

export async function initializeSimulatorTransport(): Promise<void> {
  if (!isTauri) return;
  await call('simulator_transport_set', { mode: getSimulatorTransportMode() });
}

// ── Typed API functions ─────────────────────────────────────────────────────

export interface ReferenceFile {
  name: string;
  xml: string;
  /** User-confirmed import classification for package-only XML files. */
  category?: 'initialization' | 'model-config' | 'system' | 'engine' | 'companion';
}

export async function selectModelImport(directory: boolean): Promise<{
  directory: string; mainFile: string | null; files: Array<{ name: string; xml: string }>;
  assets: Array<{ name: string; size: number }>;
} | null> {
  const preferenceKey = 'jsbsim-last-model-import-directory';
  const initialDirectory = localStorage.getItem(preferenceKey);
  const selected = await call('select_model_import', { directory, initialDirectory });
  if (selected?.directory) localStorage.setItem(preferenceKey, selected.directory);
  return selected;
}

export async function generateXml(data: any): Promise<string> {
  const result = await call('generate_xml', { data });
  if (result.error) throw new Error(result.error);
  return result.xml;
}

export async function parseXml(xml: string, files?: ReferenceFile[]): Promise<any> {
  const result = await call('parse_xml', { xml, files: files || null });
  if (result.error) throw new Error(result.error);
  return result;
}

export async function getJsbsimFiles(): Promise<any> {
  return call('get_jsbsim_files');
}

export async function generateSubfile(fileType: string, name: string, params: any): Promise<string> {
  const request = { type: fileType, name, params };
  const result = await call('generate_subfile', { req: request });
  if (result.error) throw new Error(result.error);
  return result.xml;
}

export async function parseSubfile(xml: string, fileType: string): Promise<any> {
  const request = { xml, fileType };
  const result = await call('parse_subfile', { req: request });
  if (result.error) throw new Error(result.error);
  return result;
}

export async function saveProject(filename: string, data: any): Promise<{ path?: string }> {
  let result: any;
  if (isTauri) {
    await ensureTauri();
    result = await tauriInvoke('save_project', { filename, data });
  } else {
    result = await call('save_project', { filename, ...data });
  }
  if (result.error) throw new Error(result.error);
  return result;
}

export async function getProjectPath(filename: string): Promise<string> {
  const result = await call('get_project_path', { filename });
  if (result.error) throw new Error(result.error);
  return result.path || filename;
}

export async function loadProject(filename: string): Promise<any> {
  const result = await call('load_project', { filename });
  if (result.error) throw new Error(result.error);
  return result;
}

export async function listProjects(): Promise<string[]> {
  return call('list_projects');
}

export async function generateAircraft(data: any): Promise<string> {
  const result = await call('generate_aircraft', { data });
  if (result.error) throw new Error(result.error);
  return result.xml;
}

export async function getAircraftLibrary(): Promise<any[]> {
  const result = await call('get_aircraft_library');
  return result.library || [];
}

export async function loadAircraft(aircraftId: string): Promise<any> {
  const result = await call('load_aircraft', { aircraftId });
  // Tauri commands throw on Err, but check for error field just in case
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    throw new Error(result.error);
  }
  return result;
}

export async function sendControl(override: boolean, channels: number[]): Promise<void> {
  await call('send_control', { msg: { override, channels } });
}

export async function getSimStatus(): Promise<{ connected: boolean; latest: any }> {
  return call('get_sim_status');
}

export async function parseDataflow(xml: string, files?: ReferenceFile[]): Promise<any> {
  const result = await call('parse_dataflow', { xml, files: files || null });
  if (typeof result === 'string') throw new Error(result);
  return result;
}

// ── JSBSim Simulation Control ───────────────────────────────────────────────

export async function simStart(options: { script?: string; model?: string }): Promise<any> {
  return call('sim_start', options);
}

export async function simStop(): Promise<any> {
  return call('sim_stop');
}

export async function nshExecute(command: string): Promise<string> {
  return call('nsh_execute', { command });
}

export async function simPause(): Promise<any> {
  return call('sim_pause');
}

export async function simResume(): Promise<any> {
  return call('sim_resume');
}

export async function simRestart(): Promise<any> {
  return call('sim_restart');
}

export async function simGetStatus(): Promise<{ running: boolean; paused?: boolean; stopped?: boolean; state?: string; script?: string; model?: string; external?: boolean; connected?: boolean; packets?: number; taskAlive?: boolean; cpu?: number; cpuCores?: number[]; healthAgeMs?: number | null; memory?: { total: number; used: number; free: number; percent: number }; fdmRunMs?: number; fdmWindow?: { averageMs: number; maxMs: number; samples: number }; simulationDt?: number }> {
  return call('sim_status');
}

export async function simListTests(): Promise<any[]> {
  const result = await call('sim_list_tests');
  return result.tests || [];
}

export async function simListModels(): Promise<any[]> {
  const result = await call('sim_list_models');
  return result.models || [];
}

export async function ftpDownloadModel(model: string): Promise<{ model: string; xml: string; source: string }> {
  return call('ftp_download_model', { model });
}

export async function ftpDownloadXml(path: string): Promise<{ path: string; content: string; source: string }> {
  return call('ftp_download_xml', { path });
}

export async function ftpListSystems(): Promise<string[]> {
  const result = await call('ftp_list_systems');
  if (Array.isArray(result.files) && typeof result.files[0] === 'string') return result.files;
  return (result.files || []).map((file: any) => String(file.path || '').replace(/^systems\//, ''));
}

export async function listRemoteXmlParent(parent: string): Promise<{ exists: boolean; files: string[] }> {
  const result = await call('ftp_list_xml_parent', { parent });
  return { exists: result.exists === true, files: (result.files || []).map((file: unknown) => String(file)) };
}

async function remoteXmlOrNew(parent: string, name: string, loadRemote: () => Promise<string>): Promise<string | null> {
  const listing = await listRemoteXmlParent(parent);
  if (!listing.exists || !listing.files.some(entry => entry.toLowerCase() === name.toLowerCase())) return null;
  return loadRemote();
}

export async function ftpListEngines(): Promise<string[]> {
  const result = await call('ftp_list_engines');
  return (result.engines || result.files || []).map((file: any) => String(file.path || file).replace(/^engine\//, ''));
}

export interface RemoteLogFile {
  name: string;
  size?: number | null;
  modified?: string | null;
}

export async function ftpListLogs(): Promise<RemoteLogFile[]> {
  const result = await call('ftp_list_logs');
  return (result.files || []).map((file: any) => typeof file === 'string'
    ? { name: file, size: null, modified: null }
    : { name: String(file.name || ''), size: typeof file.size === 'number' ? file.size : null, modified: file.modified || null });
}

export async function ftpDownloadLog(file: string, directory?: string): Promise<{ file: string; path: string; size: number; bytes?: number[] | null }> {
  return call('ftp_download_log', { file, directory });
}

export async function simSyncTime(thresholdSecs: number): Promise<{ checked: boolean; synchronized: boolean; differenceSeconds?: number | null }> {
  return call('sim_sync_time', { thresholdSecs });
}

export async function ftpDeleteLog(file: string): Promise<{ file: string; deleted: boolean }> {
  return call('ftp_delete_log', { file });
}

export async function ftpListEngineCatalog(): Promise<{ engines: string[]; propellers: string[] }> {
  const result = await call('ftp_list_engines');
  return {
    engines: (result.engines || []).map((file: any) => String(file.path || file).replace(/^engine\//, '')),
    propellers: (result.propellers || []).map((file: any) => String(file.path || file).replace(/^engine\//, '')),
  };
}

export async function ftpListDsdl(): Promise<string[]> {
  const result = await call('ftp_list_dsdl');
  return result.files || [];
}

export async function ftpDownloadDsdl(file: string): Promise<string> {
  const result = await call('ftp_download_dsdl', { file });
  return result.content || '';
}

function comparableXml(xml: string): string {
  return String(xml || '').replace(/\r\n?/g, '\n').trim();
}

function xmlChangePreview(remoteXml: string, localXml: string): string {
  const remoteLines = comparableXml(remoteXml).split('\n');
  const localLines = comparableXml(localXml).split('\n');
  const changes: string[] = [];
  let changedLines = 0;
  const total = Math.max(remoteLines.length, localLines.length);
  for (let index = 0; index < total; index++) {
    const before = remoteLines[index] ?? '';
    const after = localLines[index] ?? '';
    if (before === after) continue;
    changedLines++;
    if (changes.length < 24) {
      const line = index + 1;
      changes.push(`- ${line}: ${before.slice(0, 180)}`);
      changes.push(`+ ${line}: ${after.slice(0, 180)}`);
    }
  }
  const omitted = changedLines - changes.length / 2;
  return `${changes.join('\n')}${omitted > 0 ? `\n…另有 ${omitted} 行差异` : ''}`;
}

async function confirmRemoteXmlUpdate(path: string, localXml: string, loadRemote: () => Promise<string | null>): Promise<boolean> {
  if (!isRemoteUploadEnabled()) {
    throw new Error('仿真机 XML 上传已关闭，请先在“本地配置”中启用');
  }
  let remoteXml: string | null;
  try {
    remoteXml = await loadRemote();
  } catch (error: any) {
    throw new Error(`无法读取仿真机原文件，不能比较变更，已禁止上传：${error?.message || error}`);
  }
  if (remoteXml === null) {
    const confirmed = window.confirm(
      `仿真机上尚无此 XML，将新建：\n/mnt/sdcard/jsbsim/${path}\n\n不会覆盖已有文件。确认创建吗？`
    );
    if (!confirmed) throw new Error('用户取消新建 XML，仿真机文件未修改');
    return true;
  }
  if (comparableXml(remoteXml) === comparableXml(localXml)) return false;
  const preview = xmlChangePreview(remoteXml, localXml);
  const confirmed = window.confirm(
    `即将更新仿真机 XML：\n/mnt/sdcard/jsbsim/${path}\n\n请比较以下变更：\n\n${preview}\n\n确认覆盖原文件吗？`
  );
  if (!confirmed) throw new Error('用户取消 XML 更新，仿真机文件未修改');
  return true;
}

export async function ftpUploadFile(path: string, content: string): Promise<{ path: string; uploaded: boolean }> {
  const normalizedPath = String(path).replace(/^\/+|^jsbsim\//g, '');
  const shouldUpload = await confirmRemoteXmlUpdate(normalizedPath, content, async () => {
    const load = async () => (await ftpDownloadXml(normalizedPath)).content;
    const parts = normalizedPath.split('/');
    const filename = parts.pop() || '';
    const directory = parts.join('/');
    if (!filename || !/^(?:systems|engine|scripts|aircraft\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/.test(directory)) return load();
    return remoteXmlOrNew(directory, filename, load);
  });
  if (!shouldUpload) return { path: normalizedPath, uploaded: false };
  return call('ftp_upload_file', { path: normalizedPath, content });
}

export async function ftpUploadModelAssets(sourceDirectory: string, model: string, expectedFiles: string[]): Promise<{ files: string[] }> {
  return call('ftp_upload_model_assets', { sourceDirectory, model, expectedFiles });
}

export async function checkModelAssets(sourceDirectory: string, expectedFiles: string[]): Promise<void> {
  await call('check_model_assets', { sourceDirectory, expectedFiles });
}

export async function ftpDownloadScript(file: string): Promise<{ file: string; xml: string; source: string }> {
  return call('ftp_download_script', { file });
}

export async function ftpUploadModel(model: string, xml: string): Promise<{ model: string; uploaded: boolean }> {
  const modelName = String(model).replace(/^aircraft\//, '').replace(/\/.*$/, '');
  const path = `aircraft/${modelName}/${modelName}.xml`;
  const shouldUpload = await confirmRemoteXmlUpdate(path, xml, async () => {
    return remoteXmlOrNew(`aircraft/${modelName}`, `${modelName}.xml`, async () => (await ftpDownloadModel(modelName)).xml);
  });
  if (!shouldUpload) return { model: modelName, uploaded: false };
  return call('ftp_upload_model', { model: modelName, xml });
}

export async function ftpDownloadSimConfig(path: string): Promise<{ path: string; content: string }> {
  return call('ftp_download_sim_config', { path });
}

export async function ftpUploadSimConfig(path: string, content: string): Promise<{ path: string; saved: boolean }> {
  return call('ftp_upload_sim_config', { path, content });
}

export interface SimulatorVersion {
  product?: string;
  version?: string;
  firmware?: string;
  jsbsim?: string;
  aviation_library?: string;
  build_time?: string;
  git_short_hash?: string;
  schema?: number;
  [key: string]: unknown;
}

export async function ftpGetSimulatorVersion(): Promise<SimulatorVersion> {
  const result = await call('ftp_get_simulator_version');
  return result.version || {};
}

export interface UsbFileStatus {
  connected: boolean;
  identity?: string | null;
  vid: number;
  pid: number;
}

export interface UsbFileEntry {
  name: string;
  directory: boolean;
  size: number;
}

export async function usbFileStatus(): Promise<UsbFileStatus> {
  return call('usb_file_status');
}

export async function usbFilePing(): Promise<{ identity: string; source: string }> {
  return call('usb_file_ping');
}

export async function usbFileList(path: string): Promise<UsbFileEntry[]> {
  const result = await call('usb_file_list', { path });
  return result.files || [];
}

export async function usbFileRead(path: string): Promise<Uint8Array> {
  const result = await call('usb_file_read', { path });
  return Uint8Array.from(result.bytes || []);
}

export async function usbFileWrite(path: string, bytes: Uint8Array | number[]): Promise<void> {
  await call('usb_file_write', { path, bytes: Array.from(bytes) });
}

export async function usbFileDelete(path: string): Promise<void> {
  await call('usb_file_delete', { path });
}

export async function usbFileMkdir(path: string): Promise<void> {
  await call('usb_file_mkdir', { path });
}

export interface FirmwareStageResult {
  fileName: string;
  path: string;
  size: number;
  crc32: number;
  staged: boolean;
  source: string;
}

export interface FirmwareApplyResult {
  path: string;
  installed: boolean;
  verification: string;
  rebootRequired: boolean;
  source: string;
}

export interface FirmwareProgress {
  stage: 'upload' | 'write' | 'verify';
  completed: number;
  total: number;
}

export interface FirmwareSelection {
  path: string;
  name: string;
  size: number;
}

export async function selectFirmwareFile(): Promise<FirmwareSelection | null> {
  const preferenceKey = 'jsbsim-last-firmware-path';
  const previousPath = localStorage.getItem(preferenceKey);
  const selected = await call('select_firmware_file', { previousPath }) as FirmwareSelection | null;
  if (selected?.path) localStorage.setItem(preferenceKey, selected.path);
  return selected;
}

export async function firmwareStageFile(path: string): Promise<FirmwareStageResult> {
  return call('firmware_stage_file', { path });
}

export async function firmwareStage(fileName: string, bytes: Uint8Array): Promise<FirmwareStageResult> {
  return call('firmware_stage', { fileName, bytes: Array.from(bytes) });
}

export async function firmwareApply(expectedSize: number, expectedCrc32: number): Promise<FirmwareApplyResult> {
  return call('firmware_apply', { expectedSize, expectedCrc32 });
}

// ── Tauri event listeners (for telemetry) ───────────────────────────────────

type EventCallback = (payload: any) => void;
let unlistenFns: (() => void)[] = [];

export async function listenSimProcessStatus(callback: EventCallback): Promise<() => void> {
  if (!isTauri) return () => {};
  await ensureTauri();
  const unlisten = await tauriListen('sim-process-status', (event: any) => {
    callback(event.payload);
  });
  unlistenFns.push(unlisten);
  return unlisten;
}

export async function listenFirmwareProgress(callback: (progress: FirmwareProgress) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  await ensureTauri();
  const unlisten = await tauriListen('firmware-progress', (event: any) => callback(event.payload as FirmwareProgress));
  unlistenFns.push(unlisten);
  return unlisten;
}

export async function listenJsbsimLog(callback: EventCallback): Promise<() => void> {
  if (!isTauri) return () => {};
  await ensureTauri();
  const unlisten = await tauriListen('jsbsim-log', (event: any) => callback(event.payload));
  unlistenFns.push(unlisten);
  return unlisten;
}

export async function listenTelemetry(callback: EventCallback): Promise<() => void> {
  if (!isTauri) return () => {};
  await ensureTauri();
  const unlisten = await tauriListen('telemetry', (event: any) => {
    callback(event.payload);
  });
  unlistenFns.push(unlisten);
  return unlisten;
}

export async function listenSimStatus(callback: EventCallback): Promise<() => void> {
  if (!isTauri) return () => {};
  await ensureTauri();
  const unlisten = await tauriListen('sim-status', (event: any) => {
    callback(event.payload);
  });
  unlistenFns.push(unlisten);
  return unlisten;
}

export function removeAllListeners() {
  for (const fn of unlistenFns) {
    fn();
  }
  unlistenFns = [];
}

export interface TelemetryRecordingStatus {
  recording: boolean;
  path?: string | null;
  written: number;
  dropped: number;
  error?: string | null;
}
export async function telemetryRecordStart(directory?: string): Promise<TelemetryRecordingStatus> {
  return call('telemetry_record_start', { directory: directory ?? null });
}
export async function telemetryRecordStop(): Promise<TelemetryRecordingStatus> {
  return call('telemetry_record_stop');
}
export async function telemetryRecordStatus(): Promise<TelemetryRecordingStatus> {
  return call('telemetry_record_status');
}
