import { useEffect, useRef, useState, useCallback } from 'react';

export interface Telemetry {
  t: number;
  att: [number, number, number];   // phi, theta, psi [rad]
  rate: [number, number, number];   // p, q, r [rad/s]
  pos: [number, number, number];    // lat, lon, alt_m
  vel: [number, number, number];    // vn, ve, vd [m/s] NED
  vc: number;
  mach: number;
  aero: [number, number, number];   // alpha, beta, qbar
  thrust: number;
  rpm: number;
  fuel: number;
  fcs: [number, number, number, number]; // throttle, elevator, aileron, rudder
}

export function useSimSocket() {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
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
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'control', override, channels }));
    }
  }, []);

  return { telemetry, connected, sendControl };
}
