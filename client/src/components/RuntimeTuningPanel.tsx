import { automaticRuntimeTuningSuppressed, projectForAutomaticRuntimeTuning } from '../sim/runtimeTuningOrigin';
import { useEffect, useMemo, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { useSignalMonitorStore } from '../store/signalMonitorStore';
import { useRuntimeTuningStore, refreshRuntimeSnapshot, submitRuntimeEdits } from '../store/runtimeTuningStore';
import { projectParameterChanges, projectParameterDiagnostics } from '../sim/runtimeParameters';
import { isTauri } from '../utils/tauriApi';
export default function RuntimeTuningPanel() {
  const state = useRuntimeTuningStore();
  const nodes = useFlowStore(project => project.nodes);
  const edges = useFlowStore(project => project.edges);
  const [runningBaseline, setRunningBaseline] = useState<any>(null);
  const tunableProject = useMemo(() => projectForAutomaticRuntimeTuning({ nodes, edges }), [nodes, edges]);
  const currentEdits = useMemo(() => runningBaseline
    ? projectParameterChanges(runningBaseline, tunableProject, runningBaseline) : [], [runningBaseline, tunableProject]);
  const diagnostics = useMemo(() => runningBaseline
    ? projectParameterDiagnostics(runningBaseline, tunableProject, runningBaseline) : [], [runningBaseline, tunableProject]);
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
        runningProject = project.xmlEditBaseline || projectForAutomaticRuntimeTuning(project);
        setRunningBaseline(runningProject);
      }
    } catch {} };
    void poll(); const timer = setInterval(poll, 500);
    // Numeric controls commit on Enter / blur. Coalesce paired field commits.
    type Project = ReturnType<typeof useFlowStore.getState>;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let batch: { before: Project; after: Project; instance: number } | undefined;
    const stop = useFlowStore.subscribe((next, previous) => {
      if (next.xmlEditBaseline !== previous.xmlEditBaseline || next.aircraft !== previous.aircraft) {
        clearTimeout(pending);
        batch = undefined;
        return;
      }
      if (automaticRuntimeTuningSuppressed()) return;
      if (next.nodes === previous.nodes) return;
      const before = projectForAutomaticRuntimeTuning(previous), after = projectForAutomaticRuntimeTuning(next);
      if (batch) batch.after = after;
      const edits = projectParameterChanges(before, after, runningProject || before);
      if (!edits.length) {
        const reasons = projectParameterDiagnostics(before, after, runningProject || before);
        if (reasons.length && useRuntimeTuningStore.getState().enabled) useRuntimeTuningStore.setState({message:reasons.join('；'),error:true});
        return;
      }
      batch ||= { before, after, instance: Number(useSignalMonitorStore.getState().instance) };
      clearTimeout(pending);
      pending = setTimeout(() => {
        const edits = batch;
        batch = undefined;
        if (edits) submitRuntimeEdits(projectParameterChanges(edits.before, edits.after, runningProject || edits.before), undefined, edits.instance);
      }, 250);
    });
    return () => { alive = false; clearInterval(timer); clearTimeout(pending); stop(); };
  }, []);
  const ready = state.snapshot && state.snapshot.age_ms < 3000 && ['running', 'paused'].includes(state.snapshot.state);
  return <div className={`runtime-tuning-panel ${state.error || diagnostics.length ? 'error' : ''}`} data-testid="runtime-tuning-panel" role="status">
    <label><input type="checkbox" checked={state.enabled} onChange={event => useRuntimeTuningStore.setState({ enabled: event.target.checked })} />实时调参</label>
    {currentEdits.length > 0 && <button type="button" data-testid="runtime-tuning-reapply"
      disabled={!state.enabled || !ready || state.busy}
      title="重新提交当前数值修改并回读确认，保留模型状态和示波器历史"
      onClick={() => submitRuntimeEdits(currentEdits)}>重新应用</button>}
    <span title={[state.message,...diagnostics].join('；')}>{state.busy ? '正在应用并回读…' : diagnostics.length ? diagnostics.join('；') : state.applied || state.error ? state.message : ready ? `${state.snapshot!.model} · ${(state.snapshot!.tuning.parameters || 0)>=2 ? '质量 / 惯量 / 动力 / 气动 / 系统 / 环境' : `增益 / 限幅 / 常量 / 环境${state.snapshot!.tuning.inertia ? ' / 惯量' : '（惯量需更新运行端）'}`}` : '等待支持实时调参的运行端'}</span>
  </div>;
}
