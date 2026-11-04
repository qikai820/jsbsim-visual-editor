import { useEffect } from 'react';
import { isTauri, listenTelemetry, simMonitorSnapshot, simMonitorSubscribe } from '../utils/tauriApi';
import { useSignalMonitorStore } from '../store/signalMonitorStore';
import { mergeSceneMonitorKeys, publishSceneMonitor } from './sceneSignals';

function ingestObservation(frame: any) {
  const id = String(Number(frame?.instance_id ?? 1)).padStart(2, '0');
  const state = useSignalMonitorStore.getState(), previous = state.running[id];
  const dedicated = frame?.monitor?.version === 1;
  if (dedicated && frame.monitor.revision === state.revisions[id] && previous
    && previous.revision === frame.monitor.revision
    && previous.generation === `${frame.model || ''}:${frame.tree_generation ?? ''}`
    && Number.isSafeInteger(frame.monitor.sequence) && previous.sequence !== undefined
    && frame.monitor.sequence < previous.sequence && frame.timestamp < previous.t - 1
    && performance.now() - previous.seen > 2000 && (Number(frame.age_ms) || 0) < 2000) {
    // A reboot can reuse the model/tree generation and the old VMON revision.
    // Require a new subscription acknowledgement before accepting its low counters.
    const revision = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    useSignalMonitorStore.setState({ revisions: { ...state.revisions, [id]: revision } });
    return;
  }
  state.ingest(frame);
  if (dedicated && frame.monitor.revision === useSignalMonitorStore.getState().revisions[id]) publishSceneMonitor(frame);
}

export function useSignalMonitor(instance: string, sceneKeys: string[] = []) {
  const project = useSignalMonitorStore(state => state.project);
  const keys = mergeSceneMonitorKeys([...Object.values(project.labels).flatMap(label => label.bindings), ...project.scopes.flatMap(scope => scope.channels)].map(binding => binding.key), sceneKeys);
  useEffect(() => {
    let cancelled = false; let stop: (() => void) | undefined;
    const pending: any[] = [];
    void listenTelemetry(frame => {
      // Local JSBSim emits dedicated frames directly. Remote observations,
      // including legacy tree slices, arrive through the lossless batch API.
      if (frame?.kind === 'signal_samples' && frame?.monitor?.version === 1) {
        if (pending.length >= 256) pending.shift(); pending.push(frame);
      }
    }).then(unlisten => { if (cancelled) unlisten(); else stop = unlisten; });
    const timer = window.setInterval(() => { for (const frame of pending.splice(0)) ingestObservation(frame); useSignalMonitorStore.setState(state => ({ tick: state.tick + 1 })); }, 40);
    return () => { cancelled = true; stop?.(); clearInterval(timer); };
  }, []);
  useEffect(() => { useSignalMonitorStore.setState({ instance }); }, [instance]);
  useEffect(() => {
    if (keys.length > 32) { useSignalMonitorStore.setState({ error: '当前实例最多同时监视 32 个不同信号，请减少标签或通道。' }); return; }
    const revision = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    useSignalMonitorStore.setState(state => ({ revisions: { ...state.revisions, [instance]: revision }, error: '' }));
    let alive = true, busy = false;
    const sync = async () => {
      if (!isTauri || busy) return;
      busy = true;
      try {
        await simMonitorSubscribe(Number(instance), useSignalMonitorStore.getState().revisions[instance] ?? revision, keys);
        if (alive && useSignalMonitorStore.getState().error.startsWith('通信：')) useSignalMonitorStore.setState({ error: '' });
      } catch (error) { if (alive) useSignalMonitorStore.setState({ error: '通信：' + String(error) }); }
      finally { busy = false; }
    };
    void sync(); const timer = window.setInterval(sync, 1500);
    return () => { alive = false; clearInterval(timer); void simMonitorSubscribe(Number(instance), crypto.getRandomValues(new Uint32Array(1))[0] || 1, []).catch(() => {}); };
  }, [instance, JSON.stringify(keys)]);
  useEffect(() => {
    let active = true, busy = false;
    const poll = async () => {
      if (!isTauri || busy) return;
      busy = true;
      try { const frame = await simMonitorSnapshot(instance); if (active) for (const sample of Array.isArray(frame) ? frame : frame ? [frame] : []) ingestObservation(sample); }
      catch {} finally { busy = false; }
    };
    // Drain fast enough for the task-machine displayRateHz range (1–100 Hz).
    // Empty projects use a slower poll; no artificial samples are generated.
    const timer = window.setInterval(() => { void poll(); }, keys.length ? 10 : 100);
    return () => { active = false; clearInterval(timer); };
  }, [instance, Boolean(keys.length)]);
}
