import metadata from '../../public/aircraft/f35a/visual-model.json';

/** Bundled, attributed static F-35A; the same loaded mesh is used for optional
 * collision export. The USDZ source remains untouched in the user's Downloads. */
// Scene asset IDs cannot contain @ or /, so an imported asset cannot shadow it.
export const F35_MODEL_KEY = '@builtin/f35a';
export const F35_MODEL = metadata;
