/**
 * Tauri IPC API adapter — replaces all fetch('/api/...') calls with invoke().
 *
 * When running inside Tauri, uses @tauri-apps/api invoke/listen.
 * When running in a browser (dev with Vite), falls back to fetch().
 */

// Detect Tauri runtime
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

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

// ── Generic invoke wrapper with fetch fallback ──────────────────────────────

async function call(command: string, args: Record<string, any> = {}): Promise<any> {
  if (isTauri) {
    await ensureTauri();
    return tauriInvoke(command, args);
  }
  // Fallback: map command names to legacy HTTP endpoints
  const routeMap: Record<string, { method: string; path: string; bodyKey?: string }> = {
    generate_xml: { method: 'POST', path: '/api/generate-xml', bodyKey: 'data' },
    parse_xml: { method: 'POST', path: '/api/parse-xml' },
    get_jsbsim_files: { method: 'GET', path: '/api/jsbsim-files' },
    generate_subfile: { method: 'POST', path: '/api/generate-subfile' },
    parse_subfile: { method: 'POST', path: '/api/parse-subfile' },
    save_project: { method: 'POST', path: '/api/save' },
    load_project: { method: 'POST', path: '/api/load' },
    list_projects: { method: 'GET', path: '/api/projects' },
    generate_aircraft: { method: 'POST', path: '/api/generate-aircraft', bodyKey: 'data' },
    get_aircraft_library: { method: 'GET', path: '/api/aircraft-library' },
    load_aircraft: { method: 'POST', path: '/api/load-aircraft' },
    send_control: { method: 'POST', path: '/ws/sim' }, // WebSocket, not HTTP
    get_sim_status: { method: 'GET', path: '/api/sim-status' },
    parse_dataflow: { method: 'POST', path: '/api/parse-dataflow' },
    sim_start: { method: 'POST', path: '/api/sim/start' },
    sim_stop: { method: 'POST', path: '/api/sim/stop' },
    sim_status: { method: 'GET', path: '/api/sim/status' },
    sim_pause: { method: 'POST', path: '/api/sim/pause' },
    sim_resume: { method: 'POST', path: '/api/sim/resume' },
    sim_restart: { method: 'POST', path: '/api/sim/restart' },
    sim_list_tests: { method: 'GET', path: '/api/sim/tests' },
    sim_list_models: { method: 'GET', path: '/api/sim/models' },
  };

  const route = routeMap[command];
  if (!route) throw new Error(`Unknown API command: ${command}`);

  if (route.method === 'GET') {
    const res = await fetch(route.path);
    return res.json();
  }

  // Build body: if bodyKey is set, wrap args under that key; otherwise spread
  const body = route.bodyKey ? { [route.bodyKey]: args } : args;
  const res = await fetch(route.path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Typed API functions ─────────────────────────────────────────────────────

export interface ReferenceFile {
  name: string;
  xml: string;
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
  const result = await call('generate_subfile', { type: fileType, name, params });
  if (result.error) throw new Error(result.error);
  return result.xml;
}

export async function parseSubfile(xml: string, fileType: string): Promise<any> {
  const result = await call('parse_subfile', { xml, fileType });
  if (result.error) throw new Error(result.error);
  return result;
}

export async function saveProject(filename: string, data: any): Promise<void> {
  const result = await call('save_project', { filename, ...data });
  if (result.error) throw new Error(result.error);
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
  if (isTauri) {
    await call('send_control', { msg: { override, channels } });
  }
  // In browser mode, control is sent via WebSocket (handled by useSimSocket)
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

export async function simPause(): Promise<any> {
  return call('sim_pause');
}

export async function simResume(): Promise<any> {
  return call('sim_resume');
}

export async function simRestart(): Promise<any> {
  return call('sim_restart');
}

export async function simGetStatus(): Promise<{ running: boolean; paused?: boolean; script?: string; model?: string; external?: boolean; connected?: boolean }> {
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
