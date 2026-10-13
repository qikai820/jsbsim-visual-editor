import { useEffect, useRef, useState } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { xml } from '@codemirror/lang-xml';
import { json } from '@codemirror/lang-json';
import SignalPathInput from './SignalPathInput';

function languageFor(path: string) {
  const suffix = path.split('.').pop()?.toLowerCase();
  if (suffix === 'xml' || suffix === 'svg') return xml();
  if (suffix === 'json') return json();
  return [];
}

export default function UsbTextEditor({ path, content, onChange }: {
  path: string;
  content: string;
  onChange: (content: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const [signal, setSignal] = useState('');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!container.current) return;
    const view = new EditorView({
      parent: container.current,
      doc: content,
      extensions: [
        basicSetup,
        languageFor(path),
        EditorView.lineWrapping,
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    editor.current = view;
    view.focus();
    return () => { editor.current = null; view.destroy(); };
  // This component is remounted for each opened file; document edits stay in CodeMirror.
  }, []);

  return <>
    {path.toLowerCase().endsWith('.xml') && <div className="usb-fm-signal-insert">
      <span>信号路径</span>
      <SignalPathInput value={signal} onChange={setSignal} placeholder="从全局索引选择" />
      <button type="button" disabled={!signal.trim()} onClick={() => {
        const view = editor.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: signal.trim() }, selection: { anchor: from + signal.trim().length } });
        view.focus();
      }}>插入</button>
    </div>}
    <div className="usb-fm-code-editor" ref={container} />
  </>;
}
