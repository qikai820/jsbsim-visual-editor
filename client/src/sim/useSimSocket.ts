import { useEffect, useState, useCallback } from 'react';
import { sendControl as tauriSendControl, listenTelemetry, listenSimStatus } from '../utils/tauriApi';

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
  memory?: { total: number; used: number; free: number; percent: number };
}

/* NuttX sends the complete JSBSim tree in small UDP slices under
 * `properties`, so a full tree never depends on IP fragmentation.  Flatten
 * and retain the previous slices here; the property browser can then render
 * every path as soon as its slice arrives. */
function mergeTelemetry(previous: Telemetry | null, frame: Telemetry): Telemetry {
  const previousModel = typeof previous?.model === 'string' ? previous.model : undefined;
  const frameModel = typeof frame.model === 'string' ? frame.model : undefined;
  const modelChanged = !!previousModel && !!frameModel && previousModel !== frameModel;
  const treeChanged = typeof previous?.tree_generation === 'number'
    && typeof frame.tree_generation === 'number'
    && previous.tree_generation !== frame.tree_generation;
  const next: Telemetry = modelChanged || treeChanged ? {} : { ...(previous || {}) };
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

export function useSimSocket() {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unlistenFns: (() => void)[] = [];
    (async () => {
      const unlistenTelemetry = await listenTelemetry((data: Telemetry) => {
        if (!cancelled) setTelemetry(previous => mergeTelemetry(previous, data));
      });
      if (cancelled) {
        unlistenTelemetry();
        return;
      }
      unlistenFns.push(unlistenTelemetry);
      const unlistenSimStatus = await listenSimStatus((payload: any) => {
        if (!cancelled) setConnected(!!payload.connected);
      });
      if (cancelled) {
        unlistenSimStatus();
        return;
      }
      unlistenFns.push(unlistenSimStatus);
      try {
        const { getSimStatus } = await import('../utils/tauriApi');
        const status = await getSimStatus();
        if (!cancelled) {
          setConnected(status.connected);
          if (status.latest) setTelemetry(previous => mergeTelemetry(previous, status.latest));
        }
      } catch { /* ignore */ }
    })();
    return () => {
      cancelled = true;
      for (const unlisten of unlistenFns) unlisten();
    };
  }, []);

  const sendControl = useCallback((override: boolean, channels: number[]) => {
    void tauriSendControl(override, channels);
  }, []);

  return { telemetry, connected, sendControl };
}
