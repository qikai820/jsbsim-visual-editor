import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView } from '@codemirror/view';
import { xml } from '@codemirror/lang-xml';
import { json } from '@codemirror/lang-json';

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
    view.focus();
    return () => view.destroy();
  // This component is remounted for each opened file; document edits stay in CodeMirror.
  }, []);

  return <div className="usb-fm-code-editor" ref={container} />;
}
