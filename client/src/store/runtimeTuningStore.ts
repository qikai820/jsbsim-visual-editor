import { create } from 'zustand';
import { runtimeApply, runtimeSnapshot, type RuntimeEdit, type RuntimeSnapshot } from '../sim/runtimeTuningApi';
import { useSignalMonitorStore } from './signalMonitorStore';
import { useFlowStore } from './flowStore';
import { projectModelNames } from '../sim/runtimeParameters';
interface State { enabled: boolean; busy: boolean; message: string; error: boolean; snapshot: RuntimeSnapshot | null; applied: number }
export const useRuntimeTuningStore = create<State>(() => ({ enabled: true, busy: false, message: '等待运行端', error: false, snapshot: null, applied: 0 }));
let chain = Promise.resolve();
export async function refreshRuntimeSnapshot() {
  const id = Number(useSignalMonitorStore.getState().instance);
  const snapshot = await runtimeSnapshot(id);
  if (id === Number(useSignalMonitorStore.getState().instance)) useRuntimeTuningStore.setState(state => ({ snapshot,
    ...(snapshot && state.snapshot?.tuning.session !== snapshot.tuning.session ? { applied: 0, error: false, message: '运行会话已就绪' } : {}),
  }));
  return snapshot;
}
export function submitRuntimeEdits(edits: RuntimeEdit[], modelNames = projectModelNames(useFlowStore.getState()), targetInstance?: number) {
  const state = useRuntimeTuningStore.getState(), instance = targetInstance ?? Number(useSignalMonitorStore.getState().instance), snapshot = state.snapshot;
  if (!edits.length || !state.enabled) return;
  if (instance !== Number(useSignalMonitorStore.getState().instance)) { useRuntimeTuningStore.setState({ message: '请先在编辑器中选择相同实例，再实时调参', error: true }); return; }
  if (!snapshot || snapshot.age_ms > 3000 || !['running', 'paused'].includes(snapshot.state)) {
    useRuntimeTuningStore.setState({ message: '修改已保留；运行端未就绪，未实时应用', error: true }); return;
  }
  if (!modelNames.includes(snapshot.model)) { useRuntimeTuningStore.setState({ message: `当前运行 ${snapshot.model}，与编辑模型不匹配，未实时应用`, error: true }); return; }
  chain = chain.catch(() => {}).then(async () => {
    if (!useRuntimeTuningStore.getState().enabled || Number(useSignalMonitorStore.getState().instance) !== instance) return;
    useRuntimeTuningStore.setState({ busy: true, message: '正在应用并回读…', error: false });
    try {
      // Keep limit pairs in the same atomic transaction. Do not split a group.
      if (edits.length > 12) throw new Error('一次修改超过 12 个参数，请分组提交');
      const actual = await runtimeApply(instance, snapshot, edits);
      useRuntimeTuningStore.setState(state => ({ snapshot: actual, applied: state.applied + edits.length,
        message: `${instance.toString().padStart(2, '0')} 已应用 ${edits.length} 项 · t=${actual.timestamp.toFixed(3)} s；保存后下次启动保留`, error: false }));
    } catch (error) { useRuntimeTuningStore.setState({ message: String(error), error: true }); }
    finally { useRuntimeTuningStore.setState({ busy: false }); }
  });
}
