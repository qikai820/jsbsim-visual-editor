import { useCallback, useState } from 'react';
import type { ExprNode } from '../../types';
import {
  expressionToFormulaText, expressionToXmlText, parseFormulaText, parseXmlText,
} from '../../utils/expressionText';

export type ExpressionMode = 'formula' | 'source' | 'canvas';

/** Keeps the three editor views on one expression draft. Invalid text never
 * replaces the canvas or reaches the model. */
export function useExpressionModes(
  initial: ExprNode,
  readCanvas: () => ExprNode,
  writeCanvas: (expression: ExprNode) => void,
) {
  const [mode, setMode] = useState<ExpressionMode>('canvas');
  const [draft, setDraft] = useState(initial);
  const [formula, setFormula] = useState(() => expressionToFormulaText(initial));
  const [source, setSource] = useState(() => expressionToXmlText(initial));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');

  const currentExpression = useCallback((): ExprNode => {
    if (mode === 'canvas') return readCanvas();
    if (!dirty) return draft;
    return mode === 'formula' ? parseFormulaText(formula) : parseXmlText(source);
  }, [mode, dirty, draft, formula, source, readCanvas]);

  const switchMode = useCallback((next: ExpressionMode) => {
    if (next === mode) return;
    try {
      const expression = currentExpression();
      if (mode !== 'canvas' && dirty) writeCanvas(expression);
      setDraft(expression);
      setFormula(expressionToFormulaText(expression));
      setSource(expressionToXmlText(expression));
      setDirty(false);
      setError('');
      setMode(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [mode, dirty, currentExpression, writeCanvas]);

  const editText = useCallback((value: string) => {
    if (mode === 'formula') setFormula(value);
    else if (mode === 'source') setSource(value);
    setDirty(true);
    setError('');
  }, [mode]);

  return {
    mode, text: mode === 'formula' ? formula : source, error,
    switchMode, editText, currentExpression,
    reportError: (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
  };
}
