import type { ExpressionMode } from './useExpressionModes';
import type { ExprNode } from '../../types';
import { expressionToFormulaText, parseFormulaText } from '../../utils/expressionText';
import MathLiveEditor from './MathLiveEditor';
import SignalPathInput from '../SignalPathInput';
import { useRef, useState } from 'react';

interface ExpressionTextPanelProps {
  mode: Exclude<ExpressionMode, 'canvas'>;
  text: string;
  onChange: (value: string) => void;
  onSyncToCanvas: () => void;
  fallbackExpression: ExprNode;
}

export default function ExpressionTextPanel({ mode, text, onChange, onSyncToCanvas, fallbackExpression }: ExpressionTextPanelProps) {
  const textArea = useRef<HTMLTextAreaElement>(null);
  const [signal, setSignal] = useState('');
  const insertSignal = () => {
    if (!signal.trim()) return;
    const input = textArea.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    const inserted = mode === 'formula' ? `{${signal.trim()}}` : signal.trim();
    onChange(text.slice(0, start) + inserted + text.slice(end));
    requestAnimationFrame(() => {
      input?.focus(); input?.setSelectionRange(start + inserted.length, start + inserted.length);
    });
  };
  let visualExpression = fallbackExpression;
  if (mode === 'formula') {
    try { visualExpression = parseFormulaText(text); } catch { /* Text errors remain in the text editor. */ }
  }
  return <div className="expr-text-workspace">
    <div className="expr-text-sheet">
      <div className="expr-text-heading">
        <strong>{mode === 'formula' ? '手写公式' : 'JSBSim 函数 XML'}</strong>
        <button type="button" onClick={onSyncToCanvas}>校验并更新画布 →</button>
      </div>
      {mode === 'formula' && <div className="expr-mathlive-inline">
        <MathLiveEditor key={text} expression={visualExpression}
          onApply={expression => onChange(expressionToFormulaText(expression))} />
      </div>}
      <textarea ref={textArea} aria-label={mode === 'formula' ? '手写公式' : 'XML 源码'} spellCheck={false}
        value={text} onChange={event => onChange(event.target.value)} />
    </div>
    <aside className="expr-text-help">
      {mode === 'formula' ? <>
        <strong>公式写法</strong>
        <p>可用 MathLive 输入数学式，并在 u 的绑定栏中选择信号；下方文本框支持完整路径写法 <code>{'{fcs/throttle-cmd-norm}'}</code>。</p>
        <p>支持 <code>+ − × ÷ ^</code>、括号、比较运算，以及 <code>sin(...)</code>、<code>min(...)</code>、<code>ifthen(...)</code> 等函数。</p>
        <p>查表可在画布中编辑，或在 XML 源码中修改数据。</p>
      </> : <>
        <strong>源码写法</strong>
        <p>编辑当前函数的 <code>&lt;function&gt;</code> 表达式。标签与 JSBSim 模型一致。</p>
        <p>切换视图或点击“应用”时校验。XML 或公式有错时不会写入模型。</p>
      </>}
      <div className="expr-signal-insert">
        <strong>插入信号路径</strong>
        <SignalPathInput value={signal} onChange={setSignal} placeholder="选择或输入信号" />
        <button type="button" onClick={insertSignal} disabled={!signal.trim()}>插入到光标位置</button>
      </div>
    </aside>
  </div>;
}
