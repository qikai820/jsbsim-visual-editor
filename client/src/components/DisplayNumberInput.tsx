import { useState, type InputHTMLAttributes } from 'react';
import { displayNumber } from '../utils/displayNumber';

/** Preserve property references and raw numeric text while editing. */
export default function DisplayNumberInput({ value, onFocus, onBlur, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & { value: string }) {
  const [focused, setFocused] = useState(false);
  return <input {...props} type="text" value={focused ? value : displayNumber(value)}
    onFocus={event => { setFocused(true); onFocus?.(event); }}
    onBlur={event => { setFocused(false); onBlur?.(event); }} />;
}
