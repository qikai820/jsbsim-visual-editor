// Published geometry: arXiv:2607.02764v5, Table S1 (2026-11-16).
// Scene axes are right/up/aft: body (+/-0.190, +/-0.203, 0) ->
// scene (+/-0.203, 0, -/+0.190). Channel order remains the existing XML order.
// This visual geometry does not rewrite the simulator's thruster locations.
export const isMorphQuad = (model: string) => /morph[\s_-]*quad/i.test(model);
export const MORPHQUAD_GEOMETRY = {
  halfLength: .190, halfWidth: .203, rotorRadius: .0762, height: .310, gimbalY: 0,
  // Photo estimates; no dimensioned part CAD was used for these details.
  ringOuterRadius: .096, ringInnerRadius: .093,
  ringHeight: .018, propellerY: .035, propellerPitch: .0762,
  plateTop: .012, plateBottom: -.024, plateThickness: .003,
  footY: -.205,
} as const;
const g = MORPHQUAD_GEOMETRY;
export const MORPHQUAD_ARMS = [
  { label: '前右', x: g.halfWidth, z: -g.halfLength, senses: [-1, 1] },
  { label: '前左', x: -g.halfWidth, z: -g.halfLength, senses: [1, -1] },
  { label: '后左', x: -g.halfWidth, z: g.halfLength, senses: [-1, 1] },
  { label: '后右', x: g.halfWidth, z: g.halfLength, senses: [1, -1] },
] as const;
export const MORPHQUAD_ROTOR_RADIUS = g.rotorRadius; // 6-inch diameter, three blades.
export const gimbalKey = (arm: number, axis: 'outer' | 'inner') => `fcs/gimbal-${axis}-rad[${arm}]`;
