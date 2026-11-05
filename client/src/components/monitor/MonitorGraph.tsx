import { createContext, useContext, useMemo, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { applyNodeChanges, BaseEdge, getSmoothStepPath, Handle, Position, useReactFlow, type Edge, type Node, type EdgeProps, type NodeProps, type NodeChange, type Connection } from '@xyflow/react';
import { propertyBinding, type SignalBinding } from '../../sim/monitorIdentity';
import { useSignalMonitorStore } from '../../store/signalMonitorStore';
import ScopeNode from './ScopeNode';
import { revealScope, SCOPE_WIDTH } from './scopePlacement';

interface TapAnchor { id: string; point: { x: number; y: number } }
interface GraphContext { graph: string; bindings: (edge: Pick<Edge, 'id' | 'source' | 'sourceHandle' | 'data' | 'label'>) => SignalBinding[]; taps: Record<string, TapAnchor[]>; updateTaps: (positions: TapAnchor[]) => void }
const Context = createContext<GraphContext>({ graph: 'main', bindings: () => [], taps: {}, updateTaps: () => {} });
export const useMonitorGraphContext = () => useContext(Context);
function fromSource(node: Node | undefined, handle?: string | null, allNodes: Node[] = []): SignalBinding[] {
  if (!node) return [];
  const d: any = node.data;
  if (d.monitorKey) return [{ key: d.monitorKey, label: d.exprNode?.kind || d.name || '中间结果', expectedKind: d.monitorKind || (d.kind === 'tablePreview' ? 'table' : undefined) }];
  if (d.signalName) return [propertyBinding(d.signalName)];
  if (d.outputSignal) return [propertyBinding(d.outputSignal)];
  if (d.exprNode?.kind === 'property' || d.exprNode?.kind === 'function_ref') return [propertyBinding(d.exprNode.name)];
  const p = d.params || {}, type = d.componentType;
  const index = Number(p.engine_index ?? p.index ?? Math.max(0, allNodes.filter(candidate => candidate.data.componentType === type).findIndex(candidate => candidate.id === node.id)));
  const paths: Record<string, string[]> = {
    wing: ['metrics/Sw-sqft', 'metrics/bw-ft', 'metrics/cbarw-ft'],
    htail: ['metrics/Sh-sqft'], vtail: ['metrics/Sv-sqft'], fuselage: ['inertia/weight-lbs'],
    inertia: ['inertia/ixx-slugs_ft2', 'inertia/iyy-slugs_ft2', 'inertia/izz-slugs_ft2'],
    fuel_tank: [`propulsion/tank[${index}]/contents-lbs`], point_mass: [`inertia/pointmass-weight-lbs[${index}]`],
    landing_gear: ['gear/gear-pos-norm'], environment: ['atmosphere/rho-slugs_ft3', 'atmosphere/T-R', 'atmosphere/wind-north-fps'],
    engine: [`propulsion/engine[${index}]/thrust-lbs`, `propulsion/engine[${index}]/rpm`],
    propeller: [`propulsion/engine[${index}]/thrust-lbs`, `propulsion/engine[${index}]/rpm`],
  };
  if (paths[type]) return paths[type].map(propertyBinding);
  let candidates: string[] = [];
  for (const field of ['properties', 'sensor_properties', 'gps_properties', 'actuator_properties', 'input', 'output']) {
    if (typeof p[field] === 'string') candidates.push(...p[field].split(/[\n,]/).map((v: string) => v.trim()).filter(Boolean));
  }
  for (const field of ['channels', 'topLevelItems', 'coefficients']) {
    try {
      const records = JSON.parse(p[field] || '[]');
      for (const item of records.flatMap((record: any) => record.items || [record])) {
        const output = item.output || item.componentProps?.output?.value || item.name;
        if (output) candidates.push(output.includes('/') ? output : `fcs/${output.toLowerCase().replace(/ /g, '-')}`);
      }
    } catch {}
  }
  if (!candidates.length && typeof handle === 'string' && handle.includes('/')) candidates = [handle];
  return [...new Set(candidates)].map(propertyBinding);
}

export function useMonitorGraph(graph: string, originalNodes: Node[], originalEdges: Edge[]) {
  const scopes = useSignalMonitorStore(state => state.project.scopes);
  // React Flow hides controlled nodes when their measured dimensions are lost.
  // Keep observer UI state locally; only positions/channels belong in the project.
  type ObserverState = Pick<Node, 'measured' | 'selected' | 'dragging' | 'resizing'>;
  const [observerState, setObserverState] = useState<Record<string, ObserverState>>({});
  const [tapPositions, setTapPositions] = useState<Record<string, { x: number; y: number }>>({});
  const updateTaps = useCallback((positions: TapAnchor[]) => setTapPositions(previous => {
    let next = previous;
    for (const { id, point } of positions) {
      const old = previous[id];
      if (old && Math.hypot(old.x - point.x, old.y - point.y) < 0.01) continue;
      if (next === previous) next = { ...previous };
      next[id] = point;
    }
    return next;
  }), []);
  // Moving/selecting a node changes its wrapper, not its signal identity.
  // Keep the shared context stable so it does not repaint every wire.
  const bindingNodesRef = useRef(originalNodes);
  if (bindingNodesRef.current.length !== originalNodes.length || originalNodes.some((node, index) => {
    const previous = bindingNodesRef.current[index];
    return node.id !== previous.id || node.data !== previous.data;
  })) bindingNodesRef.current = originalNodes;
  const bindingNodes = bindingNodesRef.current;
  const bindings = useMemo(() => {
    const byId = new Map(bindingNodes.map(node => [node.id, node]));
    const outputs = new Map<string, SignalBinding[]>();
    return (edge: Pick<Edge, 'id' | 'source' | 'sourceHandle' | 'data' | 'label'>): SignalBinding[] => {
      if (typeof edge.data?.monitorKey === 'string') return [{ key: edge.data.monitorKey, label: String(edge.label || '中间结果'), expectedKind: typeof edge.data?.monitorKind === 'string' ? edge.data.monitorKind : undefined }];
      if (typeof edge.data?.signal === 'string' && !edge.data?.tableResult) return [propertyBinding(edge.data.signal)];
      const key = JSON.stringify([edge.source, edge.sourceHandle]);
      let values = outputs.get(key);
      if (!values) { values = fromSource(byId.get(edge.source), edge.sourceHandle, bindingNodes); outputs.set(key, values); }
      return values;
    };
  }, [bindingNodes]);
  useEffect(() => {
    const state = useSignalMonitorStore.getState(), labels = { ...state.project.labels };
    let changed = false;
    for (const edge of originalEdges) {
      const id = `${graph}::${edge.id}`;
      if (labels[id] && JSON.stringify(labels[id].bindings) !== JSON.stringify(bindings(edge))) {
        labels[id] = { ...labels[id], bindings: bindings(edge) }; changed = true;
      }
    }
    if (changed) useSignalMonitorStore.setState({ project: { ...state.project, labels } });
  }, [graph, originalEdges, bindings]);
  const { current, observers, edges, taps, observerIds, nodes } = useMemo(() => {
    const current = scopes.filter(scope => scope.graph === graph);
    const observers: Node[] = current.map(scope => ({ id: scope.id, type: 'monitorScope', position: scope.position, data: { scopeId: scope.id }, style: { width: SCOPE_WIDTH }, zIndex: 1000 }));
    const edges: Edge[] = current.length ? [...originalEdges] : originalEdges;
    const taps: Record<string, TapAnchor[]> = {};
    for (const scope of current) for (const [index, binding] of scope.channels.entries()) {
      const source = originalEdges.find(edge => bindings(edge).some(candidate => candidate.key === binding.key && (candidate.sign ?? 1) === (binding.sign ?? 1)))
        || originalNodes.map(node => ({ id: '', source: node.id, sourceHandle: 'out', data: {} })).find(edge => bindings(edge).some(candidate => candidate.key === binding.key && (candidate.sign ?? 1) === (binding.sign ?? 1)));
      const hasTap = source && binding.tap && binding.sourceEdge && originalEdges.some(edge => edge.id === binding.sourceEdge);
      if (hasTap && binding.tap) {
        const id = `${scope.id}/tap-${index}`;
        (taps[binding.sourceEdge!] ||= []).push({ id, point: binding.tap });
        const point = tapPositions[id] || binding.tap;
        observers.push({ id, type: 'monitorTap', position: { x: point.x - 10, y: point.y - 10 }, data: { scopeId: scope.id, channel: index }, draggable: false, selectable: false, connectable: false, width: 20, height: 20, style: { pointerEvents: 'all' }, zIndex: 1001 });
      }
      if (source) edges.push({ id: `${scope.id}/ch-${index}`, source: hasTap ? `${scope.id}/tap-${index}` : source.source, sourceHandle: hasTap ? 'tap-out' : source.sourceHandle, target: scope.id, targetHandle: 'scope-in', type: 'monitorBranch', data: { monitorOnly: true }, style: { stroke: '#0891b2', strokeDasharray: '5 3' } });
    }
    const observerIds = new Set(observers.map(node => node.id));
    const nodes: Node[] = observers.length ? [...originalNodes, ...observers.map(node => ({ ...node, ...observerState[node.id] }))] : originalNodes;
    return { current, observers, edges, taps, observerIds, nodes };
  }, [scopes, graph, originalNodes, originalEdges, bindings, observerState, tapPositions]);
  const tapsRef = useRef({ key: '{}', taps: {} as Record<string, TapAnchor[]> });
  const tapsKey = JSON.stringify(taps);
  if (tapsKey !== tapsRef.current.key) tapsRef.current = { key: tapsKey, taps };
  const stableTaps = tapsRef.current.taps;
  const context = useMemo(() => ({ graph, bindings, taps: stableTaps, updateTaps }), [graph, bindings, stableTaps, updateTaps]);
  return {
    nodes, edges, context,
    filterChanges: (changes: NodeChange[]): NodeChange[] => {
      const observerChanges = changes.filter(change => 'id' in change && observerIds.has(change.id));
      if (observerChanges.length) setObserverState(previous => {
        const next = applyNodeChanges<Node>(observerChanges, observers.map(node => ({ ...node, ...previous[node.id] })));
        return Object.fromEntries(next.map(({ id, measured, selected, dragging, resizing }) => [id, { measured, selected, dragging, resizing }]));
      });
      for (const change of changes) if ('id' in change && current.some(scope => scope.id === change.id)) {
        if (change.type === 'position' && change.position) useSignalMonitorStore.getState().patchScope(change.id, { position: change.position });
        if (change.type === 'remove') useSignalMonitorStore.getState().removeScope(change.id);
      }
      return changes.filter(change => !('id' in change) || !observerIds.has(change.id));
    },
    connect: (connection: Connection): boolean => {
      const target = current.find(scope => scope.id === connection.target || scope.id === connection.source);
      if (!target) return false;
      const source = connection.source === target.id ? connection.target : connection.source;
      const sourceHandle = connection.source === target.id ? connection.targetHandle : connection.sourceHandle;
      const values = fromSource(originalNodes.find(node => node.id === source), sourceHandle, originalNodes);
      useSignalMonitorStore.getState().bindScope(target.id, values); return true;
    },
  };
}
export function MonitorGraphProvider({ value, children }: { value: GraphContext; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function MonitorBranch(props: EdgeProps) {
  const [path] = getSmoothStepPath(props);
  return <BaseEdge id={props.id} path={path} style={{ stroke: '#0891b2', strokeDasharray: '5 3' }} />;
}
export function PlainSignalEdge(props: EdgeProps) {
  const [path, x, y] = getSmoothStepPath(props);
  return <BaseEdge id={props.id} path={path} labelX={x} labelY={y} label={props.label} markerEnd={props.markerEnd} style={props.style} />;
}
function MonitorTap({ data }: NodeProps) {
  const flow = useReactFlow();
  const id = String(data.scopeId || '');
  const title = useSignalMonitorStore(state => state.project.scopes.find(scope => scope.id === id)?.title || '示波器');
  const open = (element: HTMLElement) => {
    revealScope(id, flow, element.closest('.react-flow'));
    useSignalMonitorStore.setState({ openScope: id });
  };
  return <div className="monitor-tap nodrag nopan" data-testid="monitor-tap" role="button" tabIndex={0}
    title={`${title} · CH${Number(data.channel || 0) + 1}，点击查看波形`}
    aria-label={`打开${title}波形`}
    onClick={event => { event.stopPropagation(); open(event.currentTarget); }}
    onDoubleClick={event => { event.stopPropagation(); open(event.currentTarget); }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(event.currentTarget); } }}>
    <span className="monitor-tap-dot" />
    <Handle type="source" position={Position.Right} id="tap-out" style={{ opacity: 0, left: '50%', right: 'auto', top: '50%', transform: 'translate(-50%, -50%)' }} />
  </div>;
}
export const monitorNodeTypes = { monitorScope: ScopeNode, monitorTap: MonitorTap };
