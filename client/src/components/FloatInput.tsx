import { useState, type InputHTMLAttributes } from 'react';
import { useLanguage } from '../i18n';

type FloatInputProps = Omit<InputHTMLAttributes<HTMLInputElement>,
  'type' | 'inputMode' | 'value' | 'onChange' | 'step' | 'min' | 'max'> & {
  value: number | undefined;
  onValueChange: (value: number) => void;
  onClear?: () => void;
};

function parseFloatInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// Keep the text being edited separate from the numeric model value. This lets
// users clear the field or type prefixes such as "-", "0." and "1e-".
// Like QGC's FactTextField, validate and commit when editing finishes.
export default function FloatInput({
  value, onValueChange, onClear, onFocus, onBlur, onKeyDown, className, title, ...props
}: FloatInputProps) {
  const { isZh } = useLanguage();
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const text = draft ?? (value === undefined ? '' : String(value));
  const error = isZh
    ? '请输入有效的有限数值，例如 -0.18 或 1e-3；按 Esc 恢复原值。'
    : 'Enter a finite number, such as -0.18 or 1e-3. Press Esc to restore the previous value.';

  return <input
    {...props}
    type="text"
    inputMode="decimal"
    className={['float-input', className].filter(Boolean).join(' ')}
    aria-invalid={invalid || undefined}
    title={invalid ? error : title}
    value={text}
    onFocus={event => {
      setDraft(current => current ?? (value === undefined ? '' : String(value)));
      const input = event.currentTarget;
      queueMicrotask(() => {
        if (document.activeElement === input) input.select();
      });
      onFocus?.(event);
    }}
    onChange={event => {
      const next = event.target.value;
      setDraft(next);
      setInvalid(false);
    }}
    onBlur={event => {
      const parsed = parseFloatInput(event.currentTarget.value);
      if (parsed !== null) {
        if (parsed !== value) onValueChange(parsed);
        setDraft(null);
        setInvalid(false);
      } else if (event.currentTarget.value.trim() === '' && onClear) {
        onClear();
        setDraft(null);
        setInvalid(false);
      } else {
        // Retain invalid text for correction; never write it into the model.
        setInvalid(true);
      }
      onBlur?.(event);
    }}
    onKeyDown={event => {
      onKeyDown?.(event);
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDraft(null);
        setInvalid(false);
      }
    }}
  />;
}
