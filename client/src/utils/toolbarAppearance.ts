export interface ToolbarAppearance {
  color: string;
  transparency: number;
}

const COLOR_KEY = 'jsbsim-toolbar-color';
const TRANSPARENCY_KEY = 'jsbsim-toolbar-transparency';
const DEFAULT_APPEARANCE: ToolbarAppearance = { color: '#ffffff', transparency: 28 };

export function getToolbarAppearance(): ToolbarAppearance {
  const storedColor = localStorage.getItem(COLOR_KEY);
  const storedTransparency = Number(localStorage.getItem(TRANSPARENCY_KEY));
  return {
    color: storedColor && /^#[0-9a-f]{6}$/i.test(storedColor) ? storedColor : DEFAULT_APPEARANCE.color,
    transparency: localStorage.getItem(TRANSPARENCY_KEY) !== null && Number.isFinite(storedTransparency)
      ? Math.max(0, Math.min(100, storedTransparency)) : DEFAULT_APPEARANCE.transparency,
  };
}

export function saveToolbarAppearance(appearance: ToolbarAppearance): void {
  localStorage.setItem(COLOR_KEY, appearance.color);
  localStorage.setItem(TRANSPARENCY_KEY, String(appearance.transparency));
}

export function toolbarBackground({ color, transparency }: ToolbarAppearance): string {
  const red = parseInt(color.slice(1, 3), 16);
  const green = parseInt(color.slice(3, 5), 16);
  const blue = parseInt(color.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${1 - transparency / 100})`;
}
