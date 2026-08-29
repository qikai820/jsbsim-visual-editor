import { useEffect, useRef, useState, useCallback } from 'react';
import { sendControl as tauriSendControl, listenTelemetry, listenSimStatus, removeAllListeners, isTauri } from '../utils/tauriApi';

export interface Telemetry {
  t?: number;
  frame?: number;
  // JSBSim property tree: flat key-value with slash-separated paths
  // e.g. "/position/h-sl-ft": 10.0, "/attitude/phi-deg": 2.5
  task_top?: TaskTopSnapshot;
  [propertyPath: string]: number | string | Record<string, number> | TaskTopSnapshot | undefined;
}

export interface TaskTopEntry {
  pid: number;
  cpu: number;
  pri: number;
  load: number;
  stack_used: number;
  stack_size: number;
  name: string;
  state: string;
}

export interface TaskTopSnapshot {
  tasks: TaskTopEntry[];
}

/* NuttX sends the complete JSBSim tree in small UDP slices under
 * `properties`, so a full tree never depends on IP fragmentation.  Flatten
 * and retain the previous slices here; the property browser can then render
 * every path as soon as its slice arrives. */
function mergeTelemetry(previous: Telemetry | null, frame: Telemetry): Telemetry {
  const previousModel = typeof previous?.model === 'string' ? previous.model : undefined;
  const frameModel = typeof frame.model === 'string' ? frame.model : undefined;
  const modelChanged = !!previousModel && !!frameModel && previousModel !== frameModel;
  const next: Telemetry = modelChanged ? {} : { ...(previous || {}) };
  const properties = frame.properties;

  for (const [key, value] of Object.entries(frame)) {
    if (key !== 'properties') next[key] = value;
  }
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [path, value] of Object.entries(properties)) {
      if (typeof value === 'number') next[path] = value;
    }
  }
  if (typeof frame.timestamp === 'number') next.t = frame.timestamp;
  return next;
}

// Detect Tauri runtime (same check as tauriApi.ts)
const _isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function useSimSocket() {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // In Tauri mode, use event listeners instead of WebSocket
    if (_isTauri) {
      let cancelled = false;
      (async () => {
        const unlistenTel = await listenTelemetry((data: Telemetry) => {
          if (!cancelled) setTelemetry(previous => mergeTelemetry(previous, data));
        });
        const unlistenStatus = await listenSimStatus((payload: any) => {
          if (!cancelled) setConnected(!!payload.connected);
        });
        // Get initial status
        try {
          const { getSimStatus } = await import('../utils/tauriApi');
          const status = await getSimStatus();
          if (!cancelled) {
            setConnected(status.connected);
            if (status.latest) setTelemetry(previous => mergeTelemetry(previous, status.latest));
          }
        } catch { /* ignore */ }

        // Cleanup
        return () => {
          cancelled = true;
          unlistenTel();
          unlistenStatus();
        };
      })();
      return () => { cancelled = true; removeAllListeners(); };
    }

    // Browser mode: use WebSocket
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws/sim`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        reconnectTimer = setTimeout(connect, 1000);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'telemetry') setTelemetry(previous => mergeTelemetry(previous, m.data));
          else if (m.type === 'status') setConnected(!!m.connected);
        } catch {
          /* ignore */
        }
      };
    };

    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  const sendControl = useCallback((override: boolean, channels: number[]) => {
    if (_isTauri) {
      tauriSendControl(override, channels);
      return;
    }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'control', override, channels }));
    }
  }, []);

  return { telemetry, connected, sendControl };
}
