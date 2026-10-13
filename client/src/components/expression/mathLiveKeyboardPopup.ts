import type { MathfieldElement } from 'mathlive';

type Keyboard = NonNullable<Window['mathVirtualKeyboard']>;

let popup: HTMLDivElement | null = null;
let keyboardHost: HTMLDivElement | null = null;
let activeField: MathfieldElement | null = null;
let users = 0;

function positionPopup() {
  if (!popup || !activeField) return;
  const anchor = activeField.getBoundingClientRect();
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  const gap = 8;
  const x = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
  const below = anchor.bottom + gap;
  const above = anchor.top - height - gap;
  const y = below + height <= window.innerHeight - 8 ? below
    : above >= 8 ? above
      : Math.max(8, Math.min(below, window.innerHeight - height - 8));
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
}

function syncPopup() {
  if (!popup) return;
  popup.hidden = !window.mathVirtualKeyboard.visible || !activeField;
  if (!popup.hidden) positionPopup();
}

function outsidePointer(event: PointerEvent) {
  if (!popup || popup.hidden || !activeField) return;
  const target = event.target as Node;
  if (target instanceof Element && target.closest('.mathlive-keyboard-trigger')) return;
  if (!popup.contains(target) && !activeField.contains(target)) window.mathVirtualKeyboard.hide();
}

function ensurePopup(keyboard: Keyboard) {
  if (popup) return;
  popup = document.createElement('div');
  popup.className = 'mathlive-keyboard-popup';
  popup.hidden = true;
  popup.setAttribute('role', 'group');
  popup.setAttribute('aria-label', '公式键盘');
  const header = document.createElement('div');
  header.className = 'mathlive-keyboard-popup-header';
  const title = document.createElement('span');
  title.textContent = '公式键盘';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭公式键盘');
  close.addEventListener('click', () => keyboard.hide());
  header.append(title, close);
  keyboardHost = document.createElement('div');
  keyboardHost.className = 'mathlive-keyboard-popup-content';
  popup.append(header, keyboardHost);
  document.body.appendChild(popup);
  keyboard.addEventListener('virtual-keyboard-toggle', syncPopup);
  window.addEventListener('resize', positionPopup);
  window.addEventListener('scroll', positionPopup, true);
  document.addEventListener('pointerdown', outsidePointer, true);
}

export function activateMathLiveKeyboard(field: MathfieldElement | null) {
  if (!field) return;
  const keyboard = window.mathVirtualKeyboard;
  ensurePopup(keyboard);
  if (activeField !== field) {
    if (keyboard.visible) keyboard.hide();
    activeField = field;
    keyboard.container = keyboardHost;
  }
  positionPopup();
}

export function toggleMathLiveKeyboard(field: MathfieldElement | null) {
  if (!field) return;
  const keyboard = window.mathVirtualKeyboard;
  if (activeField === field && keyboard.visible) { keyboard.hide(); return; }
  activateMathLiveKeyboard(field);
  field.focus();
  keyboard.show();
  syncPopup();
}

export function registerMathLiveKeyboard() {
  users += 1;
  return (field: MathfieldElement | null) => {
    users -= 1;
    if (field && activeField === field) {
      window.mathVirtualKeyboard.hide();
      activeField = null;
    }
    if (users || !popup) return;
    const keyboard = window.mathVirtualKeyboard;
    keyboard.removeEventListener('virtual-keyboard-toggle', syncPopup);
    window.removeEventListener('resize', positionPopup);
    window.removeEventListener('scroll', positionPopup, true);
    document.removeEventListener('pointerdown', outsidePointer, true);
    keyboard.container = document.body;
    popup.remove();
    popup = null;
    keyboardHost = null;
  };
}
