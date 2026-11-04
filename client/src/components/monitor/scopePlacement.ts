import type { Node, ReactFlowInstance } from '@xyflow/react';
import { useSignalMonitorStore } from '../../store/signalMonitorStore';

export const SCOPE_WIDTH = 150;
export const scopeHeight = (channels: number) => 30 + Math.min(72, Math.max(1, channels) * 22);
type Point = { x: number; y: number };
type Flow = Pick<ReactFlowInstance<any, any>, 'screenToFlowPosition' | 'getViewport' | 'getNodes'>;
type Bounds = { left: number; top: number; right: number; bottom: number };

function visibleBounds(flow: Flow, canvas: Element): Bounds {
  const bounds = canvas.getBoundingClientRect();
  const start = flow.screenToFlowPosition({ x: bounds.left + 16, y: bounds.top + 16 }, { snapToGrid: false });
  const end = flow.screenToFlowPosition({ x: bounds.right - 16, y: bounds.bottom - 16 }, { snapToGrid: false });
  return { left: start.x, top: start.y, right: end.x, bottom: end.y };
}

function size(node: Node | undefined, channels: number) {
  return { width: Math.max(SCOPE_WIDTH, node?.measured?.width || node?.width || 0),
    height: Math.max(scopeHeight(channels), node?.measured?.height || node?.height || 0) };
}

/** Positions use the current screen-to-flow transform, including canvas offsets. */
export function scopePosition(flow: Flow, canvas: Element, preferred?: Point, channels = 0, ignoreId?: string): Point {
  const bounds = visibleBounds(flow, canvas), nodes = flow.getNodes() as Node[];
  const dimensions = size(nodes.find(node => node.id === ignoreId), channels);
  const base = preferred || { x: (bounds.left + bounds.right - dimensions.width) / 2,
    y: (bounds.top + bounds.bottom - dimensions.height) / 2 };
  const clamp = (point: Point) => ({ x: Math.max(bounds.left, Math.min(point.x, bounds.right - dimensions.width)),
    y: Math.max(bounds.top, Math.min(point.y, bounds.bottom - dimensions.height)) });
  const obstacles = nodes.filter(node => !node.hidden && node.id !== ignoreId && node.type !== 'monitorTap').map(node => ({
    x: node.position.x, y: node.position.y,
    width: node.measured?.width || node.width || 160,
    height: node.measured?.height || node.height || 70,
  }));
  const spacing = 48 / Math.max(0.05, flow.getViewport().zoom);
  let best = clamp(base), score = Infinity;
  for (let dx = -8; dx <= 8; ++dx) for (let dy = -8; dy <= 8; ++dy) {
    const point = clamp({ x: base.x + dx * spacing, y: base.y + dy * spacing });
    let overlap = 0;
    for (const obstacle of obstacles) {
      overlap += Math.max(0, Math.min(point.x + dimensions.width + 12, obstacle.x + obstacle.width) - Math.max(point.x - 12, obstacle.x))
        * Math.max(0, Math.min(point.y + dimensions.height + 12, obstacle.y + obstacle.height) - Math.max(point.y - 12, obstacle.y));
    }
    const candidate = overlap * 1000 + (point.x - base.x) ** 2 + (point.y - base.y) ** 2;
    if (candidate < score) { score = candidate; best = point; }
  }
  return best;
}

export function addScopeInView(graph: string, flow: Flow | null, canvas: Element | null, preferred?: Point): string | null {
  if (!flow || !canvas) {
    useSignalMonitorStore.setState({ error: '画布尚未准备好，请稍后添加示波器。' });
    return null;
  }
  return useSignalMonitorStore.getState().addScope(graph, scopePosition(flow, canvas, preferred));
}

/** Recover observers saved outside the current viewport without moving the model. */
export function revealScope(id: string, flow: Flow, canvas: Element | null, preferred?: Point) {
  const scope = useSignalMonitorStore.getState().project.scopes.find(scope => scope.id === id);
  if (!scope || !canvas) return;
  const bounds = visibleBounds(flow, canvas), dimensions = size(flow.getNodes().find(node => node.id === id), scope.channels.length);
  const { x, y } = scope.position;
  if (x >= bounds.left && y >= bounds.top && x + dimensions.width <= bounds.right && y + dimensions.height <= bounds.bottom) return;
  useSignalMonitorStore.getState().patchScope(id, { position: scopePosition(flow, canvas, preferred, scope.channels.length, id) });
}
