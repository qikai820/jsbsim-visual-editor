// Geometry and channel order from MorphQuad/Propulsion.xml in jsbsim_realtime.
// Positions use the scene's right/up/aft axes (metres), not XML structural axes.
export const isMorphQuad = (model: string) => /morph[\s_-]*quad/i.test(model);
export const MORPHQUAD_ARMS = [
  { label: '前右', x: .225, z: -.225, senses: [-1, 1] },
  { label: '前左', x: -.225, z: -.225, senses: [1, -1] },
  { label: '后左', x: -.225, z: .225, senses: [-1, 1] },
  { label: '后右', x: .225, z: .225, senses: [1, -1] },
] as const;
export const MORPHQUAD_ROTOR_RADIUS = .0762; // 6-inch diameter, three blades.
export const gimbalKey = (arm: number, axis: 'outer' | 'inner') => `fcs/gimbal-${axis}-rad[${arm}]`;
