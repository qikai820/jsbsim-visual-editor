import { useEffect, useMemo, useRef, useState } from 'react';
import { xmlContentEqual } from '../utils/xmlContentEqual';
import { changedParts, diffText, type DiffKind, type DiffRow } from '../utils/textDiff';

export interface XmlSourceDocument {
  path: string;
  content: string;
  category?: string;
  dirty?: boolean;
}

interface XmlSourceBrowserProps {
  documents: XmlSourceDocument[];
  initialPath?: string;
  loadRemoteContent?: (path: string) => Promise<string | null>;
  onClose: () => void;
}

function fileName(path: string): string {
  return path.split('/').pop() || path;
}

type DisplayRow = { row: DiffRow; index: number } | { skipped: number; index: number };

function visibleDiffRows(rows: DiffRow[], changeStarts: number[], expanded: boolean): DisplayRow[] {
  if (expanded || !changeStarts.length) return rows.map((row, index) => ({ row, index }));
  const visible = new Set<number>();
  rows.forEach((row, index) => {
    if (!row.changed) return;
    for (let context = Math.max(0, index - 3); context <= Math.min(rows.length - 1, index + 3); context += 1) {
      visible.add(context);
    }
  });
  const result: DisplayRow[] = [];
  for (let index = 0; index < rows.length;) {
    if (visible.has(index)) {
      result.push({ row: rows[index], index });
      index += 1;
    } else {
      const start = index;
      while (index < rows.length && !visible.has(index)) index += 1;
      result.push({ skipped: index - start, index: start });
    }
  }
  return result;
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
  const [remoteContent, setRemoteContent] = useState<Record<string, string | null>>({});
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [viewMode, setViewMode] = useState<'source' | 'split' | 'unified'>('split');
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activeChange, setActiveChange] = useState(0);
  const diffScrollRef = useRef<HTMLDivElement>(null);
  const autoReadPaths = useRef(new Set<string>());
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
    setRemoteError('');
    setExpanded(false);
    setActiveChange(0);
  }, [selected?.path]);

  const openRemote = async () => {
    if (!selected || !loadRemoteContent) return;
    setRemoteLoading(true);
    setRemoteError('');
    try {
      const next = await loadRemoteContent(selected.path);
      setRemoteContent(current => ({ ...current, [selected.path]: next }));
      setViewMode(current => current === 'source' ? 'split' : current);
    } catch (error: any) {
      setRemoteError(error?.message || '无法读取仿真机文件');
    } finally {
      setRemoteLoading(false);
    }
  };
  useEffect(() => {
    if (loadRemoteContent && selected && remoteContent[selected.path] === undefined && !autoReadPaths.current.has(selected.path)) {
      autoReadPaths.current.add(selected.path);
      void openRemote();
    }
  }, [selected?.path, loadRemoteContent]);
  const sameXml = typeof remote === 'string' && xmlContentEqual(content, remote);
  const diff = useMemo(() => typeof remote !== 'string' ? null : diffText(content, remote, ignoreWhitespace), [content, remote, ignoreWhitespace]);
  const displayRows = useMemo(() => diff ? visibleDiffRows(diff.rows, diff.changeStarts, expanded) : [], [diff, expanded]);
  const jumpToChange = (direction: number) => {
    if (!diff?.changeStarts.length) return;
    const next = (activeChange + direction + diff.changeStarts.length) % diff.changeStarts.length;
    setActiveChange(next);
    const target = diff.changeStarts[next];
    requestAnimationFrame(() => diffScrollRef.current?.querySelector(`[data-diff-row="${target}"]`)?.scrollIntoView({ block: 'center' }));
  };
  const showText = (text: string) => showWhitespace ? text.replace(/ /g, '·').replace(/\t/g, '→\u00a0\u00a0') : text;
  const renderCode = (text: string, counterpart: string | undefined, kind: DiffKind) => {
    if (counterpart === undefined || kind === 'same' || kind === 'empty' || ignoreWhitespace) return showText(text) || ' ';
    const [prefix, changed, counterpartChanged, suffix] = changedParts(text, counterpart);
    return <>{showText(prefix)}<mark>{showText(changed || (counterpartChanged ? ' ' : ''))}</mark>{showText(suffix)}</>;
  };
  const renderSide = (text: string, number: number | null, kind: DiffKind, counterpart?: string, marker?: string, rightNumber?: number | null) => (
    <div className={`xml-git-side ${kind}`}>
      <span className="xml-git-number">{number ?? ''}</span>
      {rightNumber !== undefined && <span className="xml-git-number">{rightNumber ?? ''}</span>}
      <span className="xml-git-marker">{marker || ''}</span>
      <code>{kind === 'empty' ? ' ' : renderCode(text, counterpart, kind)}</code>
    </div>
  );

  return (
    <div className="xml-source-overlay" role="dialog" aria-label="XML 源码浏览器" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="xml-source-browser" onClick={event => event.stopPropagation()}>
        <header className="xml-source-header">
          <div>
            <strong>🧾 XML 源码浏览器</strong>
            <small>{normalized.length} 个文件 · 只读查看，不会修改工程文件</small>
          </div>
          <div className="xml-source-actions">
            {loadRemoteContent && <button className="xml-source-review-button" onClick={() => void openRemote()} disabled={!selected || remoteLoading}>{remoteLoading ? '⏳ 读取仿真机…' : remote === null ? '＋ 仿真机待创建' : remote !== undefined ? '✓ 已读取仿真机' : '⇄ 对比仿真机'}</button>}
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
                  <span><strong>{fileName(document.path)}</strong><small>{document.path}{remoteContent[document.path] === null ? ' · 仿真机待创建' : typeof remoteContent[document.path] === 'string' && xmlContentEqual(document.content, remoteContent[document.path]!) ? ' · XML 内容一致' : document.dirty ? ' · 待同步' : ''}</small></span>
                </button>
              ))}
              {!visible.length && <div className="xml-source-empty">没有匹配的 XML 文件</div>}
            </div>
          </aside>
          <main className="xml-source-content">
            <div className="xml-source-content-head">
              <strong>{selected?.path || '暂无 XML 文件'}</strong>
              {typeof remote === 'string' && <span className={sameXml ? 'found' : 'not-found'}>{sameXml ? content === remote ? '内容完全一致' : '模型内容一致，仅格式不同' : 'XML 内容不同'}</span>}
              <label>查找 <input value={sourceFilter} onChange={event => setSourceFilter(event.target.value)} placeholder="源码内搜索" /></label>
              {sourceFilter && <span className={sourceMatch ? 'found' : 'not-found'}>{sourceMatch ? '已找到' : '未找到'}</span>}
              {loadRemoteContent && <div className="xml-git-view-switch" role="group" aria-label="对比显示方式">
                <button className={viewMode === 'source' ? 'active' : ''} onClick={() => setViewMode('source')}>源码</button>
                <button className={viewMode === 'split' ? 'active' : ''} onClick={() => setViewMode('split')} disabled={typeof remote !== 'string'}>双栏</button>
                <button className={viewMode === 'unified' ? 'active' : ''} onClick={() => setViewMode('unified')} disabled={typeof remote !== 'string'}>单栏</button>
              </div>}
            </div>
            {selected ? (
              <>
                {remoteError && <div className="xml-source-remote-error">仿真机读取失败：{remoteError}</div>}
                {remote === null && <div className="xml-source-remote-pending">仿真机上尚无此 XML；确认上传后将创建。</div>}
                {viewMode !== 'source' && diff ? <>
                  <div className="xml-git-toolbar">
                    <span className="xml-git-counts"><b className="removed">−{diff.deletions}</b><b className="added">+{diff.additions}</b><span>{diff.changeStarts.length} 处差异</span></span>
                    {diff.finalNewlineDiffers && <span className="xml-git-note">文件末尾换行不同</span>}
                    {diff.lineEndingDiffers && <span className="xml-git-note">换行格式不同（CRLF/LF）</span>}
                    {diff.approximate && <span className="xml-git-note">文件较大，按行近似对齐</span>}
                    <label><input type="checkbox" checked={ignoreWhitespace} onChange={event => { setIgnoreWhitespace(event.target.checked); setActiveChange(0); }} />忽略空白</label>
                    <label><input type="checkbox" checked={showWhitespace} onChange={event => setShowWhitespace(event.target.checked)} />显示空白</label>
                    <button onClick={() => setExpanded(value => !value)} disabled={!diff.changeStarts.length}>{expanded ? '收起未改动行' : '展开全部'}</button>
                    <div className="xml-git-nav"><button onClick={() => jumpToChange(-1)} disabled={!diff.changeStarts.length} aria-label="上一处差异">↑</button><span>{diff.changeStarts.length ? `${activeChange + 1} / ${diff.changeStarts.length}` : '0 / 0'}</span><button onClick={() => jumpToChange(1)} disabled={!diff.changeStarts.length} aria-label="下一处差异">↓</button></div>
                  </div>
                  <div className={`xml-git-scroll ${viewMode}`} ref={diffScrollRef} tabIndex={0} aria-label={`${selected.path} 差异`}>
                    {viewMode === 'split' && <div className="xml-git-pane-head"><span>本机版本</span><span>仿真机版本</span></div>}
                    {displayRows.map(item => 'skipped' in item ? (
                      <button className="xml-git-skipped" key={`skip-${item.index}`} onClick={() => setExpanded(true)}>··· {item.skipped} 行未改动，点击展开 ···</button>
                    ) : viewMode === 'split' ? (
                      <div className={`xml-git-row ${item.row.changed ? 'has-change' : ''}`} data-diff-row={item.index} key={item.index}>
                        {renderSide(item.row.left.text, item.row.left.number, item.row.left.kind, item.row.right.number === null ? undefined : item.row.right.text, item.row.left.kind === 'empty' ? '' : item.row.changed ? '−' : '')}
                        {renderSide(item.row.right.text, item.row.right.number, item.row.right.kind, item.row.left.number === null ? undefined : item.row.left.text, item.row.right.kind === 'empty' ? '' : item.row.changed ? '+' : '')}
                      </div>
                    ) : (
                      <div className="xml-git-unified-row" data-diff-row={item.index} key={item.index}>
                        {item.row.changed ? <>
                          {item.row.left.number !== null && renderSide(item.row.left.text, item.row.left.number, 'removed', item.row.right.number === null ? undefined : item.row.right.text, '−', null)}
                          {item.row.right.number !== null && renderSide(item.row.right.text, null, 'added', item.row.left.number === null ? undefined : item.row.left.text, '+', item.row.right.number)}
                        </> : renderSide(item.row.left.text, item.row.left.number, 'same', undefined, ' ', item.row.right.number)}
                      </div>
                    ))}
                    {!diff.changeStarts.length && <div className="xml-git-empty">{ignoreWhitespace ? '忽略空白后没有文本差异' : '两个文件的文本完全一致'}</div>}
                  </div>
                </> : <pre className="xml-source-code" tabIndex={0} aria-label={`${selected.path} 源码`}>
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
