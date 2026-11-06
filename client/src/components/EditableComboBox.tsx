import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import SerialAssistantIcon from './SerialAssistantIcon';

type Option = { value: string; label: string };

export default function EditableComboBox({ label, ariaLabel, options, value, disabled, onChange, placeholder, suffix, inputMode, error, labelAction, className = '' }: {
  label: string; ariaLabel: string; options: Option[]; value: string; disabled: boolean;
  onChange: (value: string) => void; placeholder: string; suffix?: string; inputMode?: 'numeric';
  error?: string; labelAction?: ReactNode; className?: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({});
  const matches = options.filter(option => `${option.value} ${option.label}`.toLowerCase().includes(query.toLowerCase()));
  const expanded = open && !disabled;
  const activeId = expanded && matches[activeIndex] ? `${id}-option-${activeIndex}` : undefined;

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const updatePosition = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Client rectangles include CSS zoom, but the portaled menu's fixed
      // offsets are scaled again by that zoom. Convert back to layout units.
      let zoom = 1;
      for (let element: HTMLElement | null = menuRef.current; element; element = element.parentElement) {
        const factor = Number.parseFloat(getComputedStyle(element).zoom);
        if (Number.isFinite(factor) && factor > 0) zoom *= factor;
      }
      const viewportWidth = window.innerWidth / zoom;
      const viewportHeight = window.innerHeight / zoom;
      const left = rect.left / zoom;
      const top = rect.top / zoom;
      const bottom = rect.bottom / zoom;
      const below = viewportHeight - bottom - 14;
      const above = top - 14;
      const upward = below < 180 && above > below;
      const width = Math.min(Math.max(rect.width / zoom, 220), viewportWidth - 24);
      setPosition({ left: Math.max(12, Math.min(left, viewportWidth - width - 12)), width,
        maxHeight: Math.min(310, upward ? above : below),
        ...(upward ? { bottom: viewportHeight - top + 6 } : { top: bottom + 6 }) });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [expanded]);
  useEffect(() => { if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' }); }, [activeId]);

  function showOptions() {
    setQuery('');
    setActiveIndex(options.findIndex(option => option.value === value));
    setOpen(true);
  }

  function choose(next: string) {
    onChange(next); setOpen(false); inputRef.current?.focus();
  }

  // The app raises each floating window on interaction. Keep the popup in
  // that same stacking context so it cannot disappear behind its owner.
  const popupHost = rootRef.current?.closest('.serial-assistant-overlay') ?? document.body;

  return <div className={`serial-assistant-combo-field ${className}`} ref={rootRef} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !menuRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
  }}>
    <div className="serial-assistant-field-label"><label htmlFor={id}>{label}</label>{labelAction}</div>
    <div className={`serial-assistant-combo-control ${expanded ? 'expanded' : ''} ${suffix ? 'with-suffix' : ''}`}>
      <input id={id} ref={inputRef} role="combobox" aria-label={ariaLabel} autoComplete="off" spellCheck={false} inputMode={inputMode}
        aria-expanded={expanded} aria-controls={expanded ? `${id}-options` : undefined} aria-autocomplete="list" aria-activedescendant={activeId}
        aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined}
        value={value} disabled={disabled} placeholder={placeholder} title={options.find(option => option.value === value)?.label || value}
        onClick={() => { if (!expanded) showOptions(); }}
        onChange={event => { onChange(event.target.value); setQuery(event.target.value); setActiveIndex(-1); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!expanded) { showOptions(); return; }
            setActiveIndex(index => matches.length ? event.key === 'ArrowDown' ? (index + 1) % matches.length
              : (index < 0 ? matches.length - 1 : (index - 1 + matches.length) % matches.length) : -1);
          } else if (event.key === 'Enter' && expanded) {
            event.preventDefault();
            if (matches[activeIndex]) choose(matches[activeIndex].value); else setOpen(false);
          } else if (event.key === 'Escape' && expanded) {
            event.preventDefault(); event.stopPropagation(); setOpen(false);
          } else if (event.key === 'Tab') setOpen(false);
        }} />
      {suffix && <span className="serial-assistant-combo-suffix">{suffix}</span>}
      <button type="button" aria-label={`展开${label.replace(/（.*?）/, '')}列表`} aria-expanded={expanded} disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={() => {
          if (expanded) setOpen(false); else showOptions();
          inputRef.current?.focus();
        }}><SerialAssistantIcon name="chevron" /></button>
    </div>
    {error && <span className="serial-assistant-input-error" id={`${id}-error`} role="alert">{error}</span>}
    {expanded && createPortal(<div className="serial-assistant-combo-menu" ref={menuRef} style={position}>
      <div className="serial-assistant-combo-menu-title">{suffix ? '常用波特率' : '可用串口'}</div>
      <div className="serial-assistant-combo-options" id={`${id}-options`} role="listbox" aria-label={label}>
        {matches.map((option, index) => <button type="button" key={option.value} id={`${id}-option-${index}`} role="option" tabIndex={-1}
          aria-selected={option.value === value} className={index === activeIndex ? 'active' : ''}
          onMouseEnter={() => setActiveIndex(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.value)}
          title={option.label}><span>{option.label}</span>{option.value === value && <span aria-hidden="true">✓</span>}</button>)}
        {!matches.length && <div className="serial-assistant-combo-empty">{suffix ? '无匹配预设，直接输入数值即可' : '未找到匹配串口，可直接输入路径'}</div>}
      </div>
      <div className="serial-assistant-combo-menu-foot">{suffix ? '300～4000000 · 可直接输入自定义值' : '选择串口，或直接输入设备路径'}</div>
    </div>, popupHost)}
  </div>;
}
