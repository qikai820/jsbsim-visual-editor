import type { InternalNode, Node } from '@xyflow/react';

/** Validate persisted coordinates against current, measured node sizes. Old
 * layouts can be partial or predate changes to operator ports and dimensions. */
export function canvasLayoutNeedsRepair(
  nodes: Node[], saved: Record<string, { x: number; y: number }> | undefined,
  getInternalNode: (id: string) => InternalNode | undefined,
): boolean {
  const boxes = [];
  for (const node of nodes) {
    if (node.hidden) continue;
    const position = saved?.[node.id];
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return true;
    const internal = getInternalNode(node.id);
    const width = internal?.measured.width || node.measured?.width || node.width || 64;
    const height = internal?.measured.height || node.measured?.height || node.height || 48;
    boxes.push({ x: position.x, y: position.y, right: position.x + width, bottom: position.y + height });
  }
  boxes.sort((a, b) => a.x - b.x);
  let active: typeof boxes = [];
  for (const box of boxes) {
    active = active.filter(other => other.right > box.x + .5);
    if (active.some(other => other.y < box.bottom - .5 && box.y < other.bottom - .5)) return true;
    active.push(box);
  }
  return false;
}
