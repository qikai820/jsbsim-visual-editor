import { useEffect, useMemo, useState } from 'react';

export interface XmlSourceDocument {
  path: string;
  content: string;
  category?: string;
  dirty?: boolean;
}

interface XmlSourceBrowserProps {
  documents: XmlSourceDocument[];
  initialPath?: string;
  loadRemoteContent?: (path: string) => Promise<string>;
  onClose: () => void;
}

function fileName(path: string): string {
  return path.split('/').pop() || path;
}

type DiffLine = { text: string; kind: 'same' | 'changed' | 'added' | 'removed'; number: number };

function compareLines(local: string, remote: string): { local: DiffLine[]; remote: DiffLine[] } {
  const left = local.split('\n');
  const right = remote.split('\n');
  const outputLeft: DiffLine[] = [];
  const outputRight: DiffLine[] = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) {
      if (a !== undefined) outputLeft.push({ text: a || ' ', kind: 'same', number: index + 1 });
      if (b !== undefined) outputRight.push({ text: b || ' ', kind: 'same', number: index + 1 });
    } else {
      if (a !== undefined) outputLeft.push({ text: a || ' ', kind: b === undefined ? 'removed' : 'changed', number: index + 1 });
      if (b !== undefined) outputRight.push({ text: b || ' ', kind: a === undefined ? 'added' : 'changed', number: index + 1 });
    }
  }
  return { local: outputLeft, remote: outputRight };
}

export default function XmlSourceBrowser({ documents, initialPath, loadRemoteContent, onClose }: XmlSourceBrowserProps) {
  const normalized = useMemo(() => {
    const unique = new Map<string, XmlSourceDocument>();
    documents.forEach(document => {
      const path = String(document.path || '').replace(/^\/+/, '');
      if (path && !unique.has(path)) unique.set(path, { ...document, path });
    });
    return [...unique.values()].sort((a, b) => {
      if (a.category === 'main') return -1;
      if (b.category === 'main') return 1;
      return a.path.localeCompare(b.path);
    });
  }, [documents]);

  const [selectedPath, setSelectedPath] = useState(initialPath || normalized[0]?.path || '');
  const [filter, setFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const [remoteContent, setRemoteContent] = useState<Record<string, string>>({});
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [compareMode, setCompareMode] = useState(false);
  const selected = normalized.find(document => document.path === selectedPath) || normalized[0];
  const visible = normalized.filter(document =>
    `${document.path} ${document.category || ''}`.toLowerCase().includes(filter.trim().toLowerCase())
  );

  const copySource = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const content = selected?.content || '';
  const remote = selected ? remoteContent[selected.path] : undefined;
  const sourceMatch = sourceFilter.trim() && content.toLowerCase().includes(sourceFilter.trim().toLowerCase());

  useEffect(() => {
    setCompareMode(false);
    setRemoteError('');
  }, [selected?.path]);

  const openRemote = async () => {
    if (!selected || !loadRemoteContent) return;
    setRemoteLoading(true);
    setRemoteError('');
    try {
      const next = await loadRemoteContent(selected.path);
      setRemoteContent(current => ({ ...current, [selected.path]: next }));
      setCompareMode(true);
    } catch (error: any) {
      setRemoteError(error?.message || '无法读取仿真机文件');
    } finally {
      setRemoteLoading(false);
    }
  };
  useEffect(() => {
    if (loadRemoteContent && selected && remoteContent[selected.path] === undefined) void openRemote();
  }, [selected?.path, loadRemoteContent]);
  const diff = remote === undefined ? null : compareLines(content, remote);

  return (
    <div className="xml-source-overlay" role="dialog" aria-modal="true" aria-label="XML 源码浏览器" onClick={onClose}>
      <section className="xml-source-browser" onClick={event => event.stopPropagation()}>
        <header className="xml-source-header">
          <div>
            <strong>🧾 XML 源码浏览器</strong>
            <small>{normalized.length} 个文件 · 只读查看，不会修改工程文件</small>
          </div>
          <div className="xml-source-actions">
            {loadRemoteContent && <button className="xml-source-review-button" onClick={() => void openRemote()} disabled={!selected || remoteLoading}>{remoteLoading ? '⏳ 读取仿真机…' : remote ? '✓ 已读取仿真机' : '⇄ 对比仿真机'}</button>}
            <button onClick={() => void copySource()} disabled={!selected}>{copied ? '✓ 已复制' : '📋 复制源码'}</button>
            <button onClick={onClose} aria-label="关闭 XML 源码浏览器">×</button>
          </div>
        </header>
        <div className="xml-source-body">
          <aside className="xml-source-files">
            <label className="xml-source-search">🔎 <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索文件路径" /></label>
            <div className="xml-source-file-count">显示 {visible.length} / {normalized.length}</div>
            <div className="xml-source-file-list">
              {visible.map(document => (
                <button key={document.path} className={document.path === selected?.path ? 'selected' : ''} onClick={() => setSelectedPath(document.path)}>
                  <span>{document.category === 'main' ? '📄' : '🔗'}</span>
                  <span><strong>{fileName(document.path)}</strong><small>{document.path}{document.dirty ? ' · 已修改' : ''}</small></span>
                </button>
              ))}
              {!visible.length && <div className="xml-source-empty">没有匹配的 XML 文件</div>}
            </div>
          </aside>
          <main className="xml-source-content">
            <div className="xml-source-content-head">
              <strong>{selected?.path || '暂无 XML 文件'}</strong>
              <label>查找 <input value={sourceFilter} onChange={event => setSourceFilter(event.target.value)} placeholder="源码内搜索" /></label>
              {sourceFilter && <span className={sourceMatch ? 'found' : 'not-found'}>{sourceMatch ? '已找到' : '未找到'}</span>}
              {loadRemoteContent && <button className="xml-source-compare-button" onClick={() => setCompareMode(value => !value)} disabled={!remote}>{compareMode ? '单栏查看' : '双栏对比'}</button>}
            </div>
            {selected ? (
              <>
                {remoteError && <div className="xml-source-remote-error">仿真机读取失败：{remoteError}</div>}
                {compareMode && diff ? <div className="xml-source-diff-grid">
                  <div><div className="xml-source-pane-title local">本机版本</div><pre className="xml-source-code" tabIndex={0}>{diff.local.map((line, index) => <span className={`xml-source-line ${line.kind}`} key={`${index}-${line.number}`}><i>{String(line.number).padStart(5, ' ')}</i><code>{line.text}</code></span>)}</pre></div>
                  <div><div className="xml-source-pane-title remote">仿真机版本</div><pre className="xml-source-code" tabIndex={0}>{diff.remote.map((line, index) => <span className={`xml-source-line ${line.kind}`} key={`${index}-${line.number}`}><i>{String(line.number).padStart(5, ' ')}</i><code>{line.text}</code></span>)}</pre></div>
                </div> : <pre className="xml-source-code" tabIndex={0} aria-label={`${selected.path} 源码`}>
                  {content.split('\n').map((line, index) => <span className="xml-source-line" key={index}><i>{String(index + 1).padStart(5, ' ')}</i><code>{line || ' '}</code></span>)}
                </pre>}
              </>
            ) : <div className="xml-source-empty">当前工程没有可浏览的 XML 源码</div>}
          </main>
        </div>
      </section>
    </div>
  );
}
