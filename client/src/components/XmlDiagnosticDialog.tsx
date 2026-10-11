import { useEffect, useRef, useState } from 'react';

export default function XmlDiagnosticDialog() {
  const [diagnostic, setDiagnostic] = useState<{ title: string; message: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const receive = (event: Event) => {
      setCopyStatus('');
      setDiagnostic((event as CustomEvent).detail);
    };
    window.addEventListener('jsbsim-xml-diagnostic', receive);
    return () => window.removeEventListener('jsbsim-xml-diagnostic', receive);
  }, []);
  useEffect(() => {
    if (!diagnostic) return;
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => previous?.focus();
  }, [diagnostic]);
  if (!diagnostic) return null;
  return <div className="xml-diagnostic-overlay" onKeyDown={event => {
    if (event.key === 'Escape') setDiagnostic(null);
    if (event.key === 'Tab') {
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
    }
  }}>
    <section className="xml-diagnostic-dialog" role="dialog" aria-modal="true" aria-labelledby="xml-diagnostic-title">
      <header><strong id="xml-diagnostic-title">{diagnostic.title}</strong>
        <button ref={close} aria-label="关闭诊断" onClick={() => setDiagnostic(null)}>×</button></header>
      <p>请根据文件路径和行列位置修正 XML，然后重新加载。</p>
      <pre>{diagnostic.message}</pre>
      <footer><span role="status">{copyStatus}</span><button onClick={async () => {
        try { await navigator.clipboard.writeText(diagnostic.message); setCopyStatus('已复制'); }
        catch { setCopyStatus('复制失败，可直接选择上方文字复制'); }
      }}>复制诊断</button><button onClick={() => setDiagnostic(null)}>关闭</button></footer>
    </section>
  </div>;
}
