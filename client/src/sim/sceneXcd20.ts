import metadata from '../../public/aircraft/xcd20/visual-model.json';

/** Generated from the XCD20 physics-model configuration. All dimensions are metres. */
export const isXcd20 = (model: string) => /^xcd[\s_-]*20(?:$|[._\s-])/i.test(model);
export const XCD20_GEOMETRY = metadata;
const labels = ['右前上', '左前上', '左后上', '右后上', '左前下', '右前下', '右后下', '左后下'];
export const XCD20_ROTORS = metadata.rotors.map((rotor, index) => ({
  ...rotor,
  label: labels[index],
  x: rotor.scene_position_m[0], y: rotor.scene_position_m[1], z: rotor.scene_position_m[2],
  sense: rotor.propeller_sense,
}));
