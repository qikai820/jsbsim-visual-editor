import { useLayoutEffect, useRef, type ComponentType } from 'react';
import { EdgeLabelRenderer, useReactFlow, type EdgeProps } from '@xyflow/react';
import { monitorEdgeId, sampleText, useSignalMonitorStore } from '../../store/signalMonitorStore';
import { useMonitorGraphContext } from './MonitorGraph';
import { revealScope } from './scopePlacement';
import { closestWirePoint, wirePath } from './tapProjection';

export function withSignalMonitor(Edge: ComponentType<EdgeProps>) {
  return function MonitoredEdge(props: EdgeProps) {
    const graph = useMonitorGraphContext();
    const flow = useReactFlow();
    const { screenToFlowPosition } = flow;
    const groupRef = useRef<SVGGElement>(null);
    const anchors = graph.taps[props.id] || [];
    const anchorsKey = JSON.stringify(anchors);
    useLayoutEffect(() => {
      if (!anchors.length || !groupRef.current) return;
      const group = groupRef.current;
      let scheduled = 0;
      const project = () => {
        scheduled = 0;
        const path = wirePath(group);
        if (!path) return;
        const positions = anchors.flatMap(anchor => {
          const point = closestWirePoint(path, anchor.point);
          return point ? [{ id: anchor.id, point }] : [];
        });
        if (positions.length) graph.updateTaps(positions);
      };
      const observer = new MutationObserver(() => {
        if (!scheduled) scheduled = requestAnimationFrame(project);
      });
      observer.observe(group, { childList: true, subtree: true, attributes: true, attributeFilter: ['d'] });
      project();
      return () => { observer.disconnect(); if (scheduled) cancelAnimationFrame(scheduled); };
    }, [anchorsKey, graph.updateTaps]);
    const id = monitorEdgeId(graph.graph, props.id);
    const label = useSignalMonitorStore(state => state.project.labels[id]);
    const armedScope = useSignalMonitorStore(state => state.armedScope);
    useSignalMonitorStore(state => label ? state.tick : 0);
    const state = useSignalMonitorStore.getState();
    const bindings = graph.bindings({ ...props, sourceHandle: props.sourceHandleId });
    const startMove = (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation(); event.preventDefault();
      const start = screenToFlowPosition({ x: event.clientX, y: event.clientY }), offset = label?.offset || { x: 0, y: 0 };
      const move = (next: PointerEvent) => {
        const point = screenToFlowPosition({ x: next.clientX, y: next.clientY });
        state.moveLabel(id, { x: offset.x + point.x - start.x, y: offset.y + point.y - start.y });
      };
      const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true });
    };
    return <g ref={groupRef} onDoubleClickCapture={event => {
      if (event.altKey) return;
      event.stopPropagation(); event.preventDefault(); state.toggleLabel(graph.graph, props.id, bindings);
    }} onClickCapture={event => {
      if (!state.armedScope) return;
      event.stopPropagation();
      const pointer = screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
      const path = wirePath(groupRef.current);
      const tap = path ? closestWirePoint(path, pointer) || pointer : pointer;
      state.bindScope(state.armedScope, bindings.map(binding => ({ ...binding, sourceEdge: props.id, tap })));
      revealScope(state.armedScope, flow, event.currentTarget.closest('.react-flow'), { x: tap.x + 32, y: tap.y + 48 });
    }}>
      <Edge {...props} />
      {label && <EdgeLabelRenderer><div className="monitor-value-label nodrag nopan" data-testid="signal-value-label"
        style={{ transform: `translate(-50%,-100%) translate(${(props.sourceX + props.targetX) / 2 + (label.offset?.x || 0)}px,${(props.sourceY + props.targetY) / 2 + (label.offset?.y || 0) - 8}px)` }}
        onPointerDown={startMove} onDoubleClick={event => { event.stopPropagation(); state.toggleLabel(graph.graph, props.id, bindings); }}>
        {!bindings.length ? <span>此关联线无标量信号</span> : bindings.map(binding => {
          const value = sampleText(binding, state.instance, state);
          const live = value.status === '实时' || value.status === '低速遥测';
          const sample = state.samples[`${state.instance}:${binding.key}`];
          return <div key={binding.key} className={live ? '' : 'stale'} title={`${binding.label}\n${value.status}${sample ? ` · 仿真时间 ${sample.t.toFixed(3)} s` : ''}`}>
            {bindings.length > 1 && <small>{binding.label.split('/').pop()} </small>}<strong data-testid="signal-number" data-sample-time={sample?.t}>{value.text}</strong>{!live && <small> {value.status}</small>}
          </div>;
        })}
      </div></EdgeLabelRenderer>}
    </g>;
  };
}
