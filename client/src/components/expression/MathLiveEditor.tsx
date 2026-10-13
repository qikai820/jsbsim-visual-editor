import { createElement, useEffect, useRef, useState } from 'react';
import 'mathlive';
import type { MathfieldElement } from 'mathlive';
import type { ExprNode } from '../../types';
import { expressionToMathLive, mathLiveSymbols, parseMathLive } from '../../utils/mathLiveFormula';
import { expressionToFormulaText, parseFormulaText } from '../../utils/expressionText';
import SignalPathInput from '../SignalPathInput';
import { activateMathLiveKeyboard, registerMathLiveKeyboard, toggleMathLiveKeyboard } from './mathLiveKeyboardPopup';
import './mathLiveEditor.css';

type Field = MathfieldElement;

const OPERATORS = [
  { label: '+', title: '加', latex: '+', text: ' + ' },
  { label: '−', title: '减', latex: '-', text: ' − ' },
  { label: '×', title: '乘', latex: '\\cdot ', text: ' × ' },
  { label: '分式', title: '分式', latex: '\\frac{#@}{#?}', text: '() ÷ ()', cursorBack: 6 },
  { label: 'min', title: '最小值', latex: '\\min\\left(#?,#?\\right)', text: 'min(, )', cursorBack: 3 },
  { label: 'max', title: '最大值', latex: '\\max\\left(#?,#?\\right)', text: 'max(, )', cursorBack: 3 },
  { label: 'sin', title: '正弦', latex: '\\sin\\left(#?\\right)', text: 'sin()', cursorBack: 1 },
] as const;

const AVIATION_SYMBOLS = [
  { label: 'x', title: '纵向位置' }, { label: 'y', title: '横向位置' }, { label: 'z', title: '垂向位置' },
  { label: 'u', title: '机体系前向速度' }, { label: 'v', title: '机体系侧向速度' }, { label: 'w', title: '机体系垂向速度' },
  { label: 'p', title: '滚转角速度' }, { label: 'q', title: '俯仰角速度' }, { label: 'r', title: '偏航角速度' },
  { label: 'V', title: '速度' },
  { label: 'φ', title: '滚转角', latex: '\\phi' }, { label: 'θ', title: '俯仰角', latex: '\\theta' },
  { label: 'ψ', title: '航向角', latex: '\\psi' }, { label: 'α', title: '迎角', latex: '\\alpha' },
  { label: 'β', title: '侧滑角', latex: '\\beta' }, { label: 'γ', title: '航迹倾角', latex: '\\gamma' },
  { label: 'δ', title: '操纵面偏角', latex: '\\delta' }, { label: 'ρ', title: '空气密度', latex: '\\rho' },
] as const;

const aviationSymbolTitle = Object.fromEntries(AVIATION_SYMBOLS.map(symbol => [symbol.label, symbol.title]));

export default function MathLiveEditor({ expression, onApply, onCancel }: {
  expression: ExprNode;
  onApply: (expression: ExprNode) => void;
  onCancel?: () => void;
}) {
  const initial = useRef<ExprNode>(expression);
  const [prepared] = useState(() => {
    try { return { visual: expressionToMathLive(expression), unsupported: '' }; }
    catch (cause) { return { visual: null, unsupported: cause instanceof Error ? cause.message : String(cause) }; }
  }); // The parent remounts when selecting another expression.
  const [signals, setSignals] = useState(() => prepared.visual?.signals || []);
  const [latex, setLatex] = useState(() => prepared.visual?.latex || '');
  const [symbolBindings, setSymbolBindings] = useState<Record<string, string>>({});
  const [formulaText, setFormulaText] = useState(() => expressionToFormulaText(expression));
  const [error, setError] = useState('');
  const field = useRef<Field | null>(null);
  const textArea = useRef<HTMLTextAreaElement | null>(null);
  const usedSymbols = prepared.unsupported ? [] : mathLiveSymbols(latex);

  useEffect(() => {
    if (field.current) field.current.value = latex;
  }, []); // Initial value only; MathLive owns later keystrokes.

  useEffect(() => {
    if (prepared.unsupported) return;
    const unregister = registerMathLiveKeyboard();
    const currentField = field.current;
    return () => unregister(currentField);
  }, [prepared.unsupported]);

  const addSignal = () => {
    const next = [...signals, ''];
    setSignals(next);
    field.current?.insert(`u_{${next.length}}`);
    setLatex(field.current?.value || latex);
  };
  const insertSymbol = (symbol: typeof AVIATION_SYMBOLS[number]) => {
    const mathField = field.current;
    if (!mathField) return;
    mathField.insert('latex' in symbol ? symbol.latex : symbol.label, { focus: true });
    setLatex(mathField.value);
    setError('');
  };
  const insertOperator = (operator: typeof OPERATORS[number]) => {
    if (prepared.unsupported) {
      const input = textArea.current;
      const start = input?.selectionStart ?? formulaText.length;
      const end = input?.selectionEnd ?? start;
      setFormulaText(formulaText.slice(0, start) + operator.text + formulaText.slice(end));
      setError('');
      requestAnimationFrame(() => {
        input?.focus();
        const cursor = start + operator.text.length - ('cursorBack' in operator ? operator.cursorBack : 0);
        input?.setSelectionRange(cursor, cursor);
      });
      return;
    }
    const mathField = field.current;
    if (!mathField) return;
    mathField.insert(operator.latex, { selectionMode: 'placeholder', focus: true });
    setLatex(mathField.value);
    setError('');
  };
  const apply = () => {
    try {
      if (prepared.unsupported) { onApply(parseFormulaText(formulaText)); setError(''); return; }
      if (signals.some(path => !path.trim())) throw new Error('请为每个 u 输入信号路径');
      const unbound = usedSymbols.find(name => !symbolBindings[name]?.trim());
      if (unbound) throw new Error(`请为 ${unbound} 选择信号路径`);
      const result = latex === prepared.visual?.latex &&
        signals.every((path, index) => path === prepared.visual?.signals[index])
        ? initial.current : parseMathLive(latex, signals, symbolBindings);
      onApply(result);
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <div className="mathlive-editor">
    <div className="mathlive-operator-toolbar" role="toolbar" aria-label="公式运算符">
      {OPERATORS.map(operator => <button key={operator.label} type="button"
        title={`插入${operator.title}`} aria-label={`插入${operator.title}`}
        onPointerDown={event => event.preventDefault()}
        onClick={() => insertOperator(operator)}>{operator.label}</button>)}
      {!prepared.unsupported && <button type="button" className="mathlive-keyboard-trigger"
        aria-label="打开公式键盘" title="打开完整公式键盘"
        onPointerDown={event => event.preventDefault()}
        onClick={() => toggleMathLiveKeyboard(field.current)}>⌨ 键盘</button>}
    </div>
    {!prepared.unsupported && <div className="mathlive-symbol-toolbar" role="toolbar" aria-label="航空常用字母">
      <span>航空字母</span>
      {AVIATION_SYMBOLS.map(symbol => <button key={symbol.label} type="button"
        title={`${symbol.label} · ${symbol.title}`} aria-label={`插入${symbol.title} ${symbol.label}`}
        onPointerDown={event => event.preventDefault()}
        onClick={() => insertSymbol(symbol)}>{symbol.label}</button>)}
    </div>}
    {prepared.unsupported ? <>
      <p className="mathlive-hint">此运算使用公式文本编辑，保存时同样校验并回写 XML。</p>
      <textarea ref={textArea} aria-label="公式文本" spellCheck={false} value={formulaText}
        onChange={event => { setFormulaText(event.target.value); setError(''); }} />
    </> : <>
      {createElement('math-field', {
        ref: field, 'aria-label': 'MathLive 公式输入',
        onFocus: () => activateMathLiveKeyboard(field.current),
        onInput: (event: Event) => { setLatex((event.currentTarget as Field).value); setError(''); },
      })}
      <div className="mathlive-signals">
        {usedSymbols.map(name => <div key={name} className="mathlive-symbol-binding">
          <label title={aviationSymbolTitle[name] || '公式变量'}>{name}</label>
          <SignalPathInput value={symbolBindings[name] || ''}
            onChange={value => { setSymbolBindings(current => ({ ...current, [name]: value })); setError(''); }}
            placeholder={`为 ${name} 选择或输入信号路径`} />
        </div>)}
        {signals.map((path, index) => <div key={index}>
          <label>u<sub>{index + 1}</sub></label>
          <SignalPathInput value={path} onChange={value => setSignals(current => current.map((item, i) => i === index ? value : item))}
            placeholder="从全局信号索引选择或输入路径" />
        </div>)}
      </div>
      <button type="button" onClick={addSignal}>＋ 插入信号</button>
      <p className="mathlive-hint">可输入拉丁和常用希腊字母；字母需绑定信号路径。支持加减乘除、幂、三角函数及比较。</p>
    </>}
    {error && <p className="mathlive-error" role="alert">{error}</p>}
    <div className="mathlive-actions">
      {onCancel && <button type="button" onClick={onCancel}>取消</button>}
      <button type="button" onClick={apply}>校验并写入公式</button>
    </div>
  </div>;
}
