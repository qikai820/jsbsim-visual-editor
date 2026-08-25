import { useEffect, useRef, useState, useCallback } from 'react';
import { sendControl as tauriSendControl, listenTelemetry, listenSimStatus, removeAllListeners, isTauri } from '../utils/tauriApi';

export interface Telemetry {
  t: number;
  frame?: number;
  // JSBSim property tree: flat key-value with slash-separated paths
  // e.g. "/position/h-sl-ft": 10.0, "/attitude/phi-deg": 2.5
  [propertyPath: string]: number | undefined;
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
          if (!cancelled) setTelemetry(data);
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
            if (status.latest) setTelemetry(status.latest);
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
          if (m.type === 'telemetry') setTelemetry(m.data);
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
