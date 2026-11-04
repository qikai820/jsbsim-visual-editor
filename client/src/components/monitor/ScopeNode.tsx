import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useSignalMonitorStore } from '../../store/signalMonitorStore';
import { scopeSampleText } from './scopeUnits';

export default function ScopeNode({ id }: NodeProps) {
  const state = useSignalMonitorStore(), scope = state.project.scopes.find(scope => scope.id === id);
  if (!scope) return null;
  return <div className={`monitor-scope${state.armedScope === id ? ' armed' : ''}`} data-testid="scope-node"
    onDoubleClick={event => { event.stopPropagation(); useSignalMonitorStore.setState({ openScope: id }); }}>
    <Handle type="target" position={Position.Left} id="scope-in" title="拖线连接，或点击接线后点选信号线" />
    <div className="monitor-scope-title"><span title={scope.title}>∿ {scope.title}</span><div className="monitor-scope-actions nodrag">
      <button aria-label={state.armedScope === id ? '取消接线' : '接入信号'} title={state.armedScope === id ? '点击信号线接入，或取消接线' : '接入信号'} onClick={() => useSignalMonitorStore.setState({ armedScope: state.armedScope === id ? null : id })}>+</button>
      <button aria-label="查看波形" title="查看波形" onClick={() => useSignalMonitorStore.setState({ openScope: id })}>⤢</button>
      <button aria-label="删除示波器" title="删除示波器" onClick={() => state.removeScope(id)}>×</button>
    </div></div>
    {scope.channels.length ? <div className="monitor-scope-channels nodrag nopan nowheel">{scope.channels.map((binding, index) => {
      const value = scopeSampleText(binding, state.instance, state);
      const sample = state.samples[`${state.instance}:${binding.key}`];
      return <div className="monitor-scope-value" key={`${binding.key}:${binding.sign}`} title={`${binding.label}\n${value.status}${sample ? ` · 仿真时间 ${sample.t.toFixed(3)} s` : ''}`}>
        <span>CH{index + 1}</span><strong data-sample-time={sample?.t}>{value.text}</strong>{value.status !== '实时' && value.status !== '低速遥测' && <small>{value.status}</small>}
      </div>;
    })}</div> : <div className="monitor-scope-empty">接入信号后显示数值</div>}
  </div>;
}
