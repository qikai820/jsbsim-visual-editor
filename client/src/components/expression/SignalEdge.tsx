import { SmoothStepEdge, type EdgeProps } from '@xyflow/react';

// Thin wrapper around the built-in SmoothStepEdge that shifts the endpoints by
// a small per-edge vertical offset (from edge.data.srcOffset / tgtOffset). This
// fans out wires that leave/enter the same handle so they don't overlap. All
// other rendering (including the signal-name label) is delegated to the
// built-in edge, so behaviour is unchanged except for the separation.
export default function SignalEdge(props: EdgeProps) {
  const { sourceY, targetY, data, ...rest } = props as EdgeProps & {
    sourceY: number; targetY: number; data?: any;
  };
  const srcOff = data?.srcOffset ?? 0;
  const tgtOff = data?.tgtOffset ?? 0;
  return (
    <SmoothStepEdge
      {...rest}
      sourceY={sourceY + srcOff}
      targetY={targetY + tgtOff}
    />
  );
}
