import { createContext } from 'react';
import type { Bendpoint } from '../edges/bendpoints';

// Bridge between SignalEdge (rendered inside ReactFlow) and ModuleExpressionCanvas
// (which owns the controlled edges state). Avoids a SignalEdge <-> Canvas import cycle.
export const SignalEdgeActionsContext = createContext<{
  updateBendpoints: (edgeId: string, bps: Bendpoint[]) => void;
  persistBendpoints: () => void;
} | null>(null);
