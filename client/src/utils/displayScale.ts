import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from './tauriApi';

export const DISPLAY_SCALE_KEY = 'jsbsim-display-scale';
export type DisplayScaleSetting = 'auto' | number;

export function readDisplayScale(): DisplayScaleSetting {
  const saved = localStorage.getItem(DISPLAY_SCALE_KEY);
  if (!saved || saved === 'auto') return 'auto';
  const value = Number(saved);
  return Number.isFinite(value) && value >= 0.75 && value <= 2 ? value : 'auto';
}

export function saveDisplayScale(setting: DisplayScaleSetting): void {
  localStorage.setItem(DISPLAY_SCALE_KEY, String(setting));
  window.dispatchEvent(new Event('jsbsim-display-scale-changed'));
}

// Use logical window pixels: the operating system's DPI setting has already
// converted physical pixels to the area available for CSS layout.
export function automaticDisplayScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  const fit = Math.min(width / 1400, height / 900);
  return Math.max(0.75, Math.min(1.6, Math.round(fit * 20) / 20));
}

export function installDisplayScaling(): void {
  let applied = 1;
  let revision = 0;
  let pending = Promise.resolve();
  const refresh = () => {
    const current = ++revision;
    // A previous WebView zoom can finish after a newer resize event. Apply
    // requests in order and skip superseded measurements before each write.
    pending = pending.then(async () => {
      let width: number;
      let height: number;
      if (isTauri) {
        try {
          const appWindow = getCurrentWindow();
          const [size, deviceScale] = await Promise.all([appWindow.innerSize(), appWindow.scaleFactor()]);
          width = size.width / deviceScale;
          height = size.height / deviceScale;
        } catch {
          width = window.innerWidth;
          height = window.innerHeight;
        }
      } else {
        width = window.innerWidth;
        height = window.innerHeight;
      }
      if (current !== revision) return;
      const setting = readDisplayScale();
      const next = setting === 'auto' ? automaticDisplayScale(width, height) : setting;
      if (next === applied) return;
      if (isTauri) {
        try {
          await getCurrentWebview().setZoom(next);
          document.documentElement.style.zoom = '';
          document.documentElement.style.removeProperty('--display-viewport-width');
          document.documentElement.style.removeProperty('--display-viewport-height');
          applied = next;
          return;
        } catch { /* Browser preview and older WebViews use CSS zoom. */ }
      }
      document.documentElement.style.zoom = String(next);
      document.documentElement.style.setProperty('--display-viewport-width', `${100 / next}vw`);
      document.documentElement.style.setProperty('--display-viewport-height', `${100 / next}vh`);
      applied = next;
    }).catch(error => { console.error('[Display scale]', error); });
  };

  // Keep a recovery shortcut available if a manual size hides the settings button.
  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === '0') {
      event.preventDefault();
      saveDisplayScale('auto');
    }
  });
  window.addEventListener('resize', refresh);
  window.addEventListener('jsbsim-display-scale-changed', refresh);
  if (isTauri) {
    void getCurrentWindow().onResized(refresh);
    void getCurrentWindow().onScaleChanged(refresh);
  }
  refresh();
}
