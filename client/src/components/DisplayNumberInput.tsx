import { useState, type InputHTMLAttributes } from 'react';
import { displayNumber } from '../utils/displayNumber';

/** Preserve property references; live scalar fields commit only on Enter/blur. */
export default function DisplayNumberInput({ value, commitOnBlur = false, onChange, onFocus, onBlur, onKeyDown, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & { value: string; commitOnBlur?: boolean }) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  return <input {...props} type="text" value={draft ?? (focused ? value : displayNumber(value))}
    aria-invalid={invalid || undefined}
    onChange={event => { if (commitOnBlur) { setDraft(event.target.value); setInvalid(false); } else onChange?.(event); }}
    onFocus={event => { setFocused(true); onFocus?.(event); }}
    onBlur={event => {
      setFocused(false);
      if (commitOnBlur && event.currentTarget.value !== value) {
        const text = event.currentTarget.value.trim();
        if (text && /^[+\-\d.]/.test(text) && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) { setInvalid(true); return; }
        if (/^[+\-\d.]/.test(text) && !Number.isFinite(Number(text))) { setInvalid(true); return; }
        onChange?.(event as any); setDraft(null); setInvalid(false);
      }
      onBlur?.(event);
    }}
    onKeyDown={event => {
      onKeyDown?.(event);
      if (!commitOnBlur || event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(null); setInvalid(false); }
    }} />;
}
