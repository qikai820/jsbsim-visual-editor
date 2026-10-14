// One gesture handler for the editor's modal windows, including windows rendered in portals.
// Keep the selectors explicit so menus, resize handles, and editable content never start a drag.
const dragTargets = [
  ['.local-settings-dialog > header', '.local-settings-dialog'],
  ['.xml-diagnostic-dialog > header', '.xml-diagnostic-dialog'],
  ['.j23-guide-header', '.j23-guide-dialog'],
  ['.serial-assistant-head', '.serial-assistant'],
  ['.script-editor-head', '.script-editor-modal'],
  ['.xml-source-header', '.xml-source-browser'],
  ['.sim-config-dialog > header', '.sim-config-dialog'],
  ['.sim-config-version-manager > header', '.sim-config-version-manager'],
  ['.wizard-header', '.wizard-modal'],
  ['.library-header', '.library-modal'],
  ['.xml-modal-header', '.xml-modal'],
  ['.model-import-dialog > header', '.model-import-dialog'],
  ['.xml-import-files-dialog > header', '.xml-import-files-dialog'],
  ['.lut-preview-header', '.lut-preview-dialog'],
  ['.expr-editor-topbar', '.expr-editor'],
  ['.usb-fm-conflict-dialog > strong', '.usb-fm-conflict-dialog'],
  ['.sim-performance-head', '.sim-performance-popup'],
  ['.telemetry-record-heading', '.telemetry-record-panel'],
  ['.xml-import-files-toast > div:first-child', '.xml-import-files-toast'],
  ['.viewer3d-info-header', '.viewer3d-info-panel'],
] as const;

const floatingRootSelector = [
  '.local-settings-overlay', '.xml-modal-overlay', '.expr-modal-overlay',
  '.wizard-overlay', '.sim-config-overlay', '.sim-config-version-overlay',
  '.script-editor-overlay', '.lut-preview-overlay', '.xml-import-files-overlay',
  '.model-import-overlay', '.xml-source-overlay', '.xml-diagnostic-overlay',
  '.nsh-console-overlay', '.serial-assistant-overlay', '.j23-guide-overlay',
  '.log-center-backdrop', '.usb-fm-backdrop', '.usb-fm-conflict-overlay',
  '.sim-performance-popup', '.telemetry-record-panel', '.xml-import-files-toast',
].join(', ');

export function installDialogDragging(): () => void {
  let topLayer = 11000;
  const layered = new WeakSet<Element>();
  const assignLayer = (element: Element) => {
    if (!(element instanceof HTMLElement) || layered.has(element)) return;
    layered.add(element);
    element.style.zIndex = String(++topLayer);
  };
  const scan = (element: Element) => {
    if (element.matches(floatingRootSelector)) assignLayer(element);
    element.querySelectorAll(floatingRootSelector).forEach(assignLayer);
  };
  scan(document.body);
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element) scan(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  let active: {
    dialog: HTMLElement;
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    rect: DOMRect;
  } | null = null;

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    let root = target.closest<HTMLElement>(floatingRootSelector);
    while (root) {
      const parent = root.parentElement?.closest<HTMLElement>(floatingRootSelector);
      if (!parent) break;
      root = parent;
    }
    if (root) { assignLayer(root); root.style.zIndex = String(++topLayer); }
    if (event.button !== 0 || !event.isPrimary ||
        target.closest('button, input, select, textarea, a, [contenteditable], [role="button"]')) return;

    for (const [handleSelector, dialogSelector] of dragTargets) {
      const handle = target.closest(handleSelector);
      if (!handle) continue;
      const dialog = handle.closest<HTMLElement>(dialogSelector);
      if (!dialog) continue;

      const [offsetX = 0, offsetY = 0] = dialog.style.translate.split(' ').map(value => Number.parseFloat(value) || 0);
      active = {
        dialog,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX,
        offsetY,
        rect: dialog.getBoundingClientRect(),
      };
      event.preventDefault();
      break;
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!active || active.pointerId !== event.pointerId) return;
    const { dialog, rect, startX, startY, offsetX, offsetY } = active;
    if (!dialog.isConnected) { active = null; return; }
    const dx = Math.max(48 - rect.right, Math.min(window.innerWidth - 48 - rect.left, event.clientX - startX));
    const dy = Math.max(-rect.top, Math.min(window.innerHeight - 40 - rect.top, event.clientY - startY));
    dialog.style.translate = `${offsetX + dx}px ${offsetY + dy}px`;
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (active?.pointerId === event.pointerId) active = null;
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerEnd, true);
  window.addEventListener('pointercancel', onPointerEnd, true);
  return () => {
    observer.disconnect();
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerEnd, true);
    window.removeEventListener('pointercancel', onPointerEnd, true);
  };
}
