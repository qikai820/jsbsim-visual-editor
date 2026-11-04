import { useEffect } from 'react';
import { useFlowStore } from '../store/flowStore';
import { useRuntimeTuningStore, refreshRuntimeSnapshot, submitRuntimeEdits } from '../store/runtimeTuningStore';
import { projectParameterChanges } from '../sim/runtimeParameters';
import { isTauri } from '../utils/tauriApi';
export default function RuntimeTuningPanel() {
  const state = useRuntimeTuningStore();
  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    let session = '', runningProject: any;
    const poll = async () => { try {
      if (!alive) return;
      const snapshot = await refreshRuntimeSnapshot();
      if (snapshot && snapshot.tuning.session !== session) {
        session = snapshot.tuning.session;
        const project = useFlowStore.getState();
        runningProject = project.xmlEditBaseline || project;
      }
    } catch {} };
    void poll(); const timer = setInterval(poll, 500);
    // Numeric controls commit on Enter / blur. Coalesce paired field commits.
    let pending: ReturnType<typeof setTimeout> | undefined, baseline: any;
    const stop = useFlowStore.subscribe((next, previous) => {
      if (next.nodes === previous.nodes || next.xmlEditBaseline !== previous.xmlEditBaseline || next.aircraft !== previous.aircraft) return;
      if (!projectParameterChanges(previous, next, runningProject || previous).length) return;
      baseline ||= previous;
      clearTimeout(pending);
      pending = setTimeout(() => { const before = baseline; baseline = undefined; submitRuntimeEdits(projectParameterChanges(before, useFlowStore.getState(), runningProject || before)); }, 250);
    });
    return () => { alive = false; clearInterval(timer); clearTimeout(pending); stop(); };
  }, []);
  const ready = state.snapshot && state.snapshot.age_ms < 3000 && ['running', 'paused'].includes(state.snapshot.state);
  return <div className={`runtime-tuning-panel ${state.error ? 'error' : ''}`} data-testid="runtime-tuning-panel" role="status">
    <label><input type="checkbox" checked={state.enabled} onChange={event => useRuntimeTuningStore.setState({ enabled: event.target.checked })} />实时调参</label>
    <span title={state.message}>{state.busy ? '正在应用并回读…' : state.applied || state.error ? state.message : ready ? `${state.snapshot!.model} · 增益 / 限幅 / 常量 / 环境` : '等待支持实时调参的运行端'}</span>
  </div>;
}
