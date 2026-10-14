import { useMemo, useState } from 'react';
import type { Node } from '@xyflow/react';
import type { ExprNode } from '../../types';
import { formulaRelations, signalFormulaSheets } from '../../utils/formulaNotebook';
import MathLiveEditor from './MathLiveEditor';
import SignalPathInput from '../SignalPathInput';
import './formulaNotebook.css';

export default function FormulaNotebook({ nodes, onUpdate, onCreate }: {
  nodes: Node[];
  onUpdate: (id: string, expression: ExprNode) => void;
  onCreate: (name: string, expression: ExprNode) => void;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sheets = useMemo(() => signalFormulaSheets(nodes), [nodes]);
  const relations = useMemo(() => formulaRelations(sheets), [sheets]);
  const sheetsByName = useMemo(() => new Map(sheets.map(sheet => [sheet.name, sheet])), [sheets]);
  const selected = sheets.find(sheet => sheet.id === selectedId) || sheets[0];
  const incoming = selected ? relations.filter(relation => relation.target.id === selected.id) : [];
  const outgoing = selected ? relations.filter(relation => relation.source.id === selected.id) : [];
  const normalized = query.trim().toLowerCase();
  const visible = sheets.filter(sheet => !normalized ||
    sheet.name.toLowerCase().includes(normalized) ||
    sheet.inputs.some(input => input.path.toLowerCase().includes(normalized) ||
      input.symbol.toLowerCase() === normalized));
  const jumpToSheet = (id: string) => {
    setQuery('');
    setSelectedId(id);
    requestAnimationFrame(() => document.getElementById(`formula-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const showRelations = (id: string) => {
    setQuery('');
    setSelectedId(id);
    requestAnimationFrame(() => document.getElementById('formula-relationship')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return <section className="formula-notebook" aria-label="多行公式视图">
    <aside className="formula-index">
      <div className="formula-index-heading">公式目录 <span>{sheets.length}</span></div>
      <button type="button" className="formula-create" onClick={() => { setCreating(true); setEditing(null); }}>＋ 新建公式</button>
      <div className="formula-index-count" aria-live="polite">显示 {visible.length} / {sheets.length} 条公式</div>
      <nav aria-label="公式索引">
        {visible.map(sheet => <a key={sheet.id} href={`#formula-${sheet.id}`} title={sheet.name} onClick={() => setSelectedId(sheet.id)}>
          <span>{String(sheet.sequence).padStart(2, '0')}</span>{sheet.output}
        </a>)}
      </nav>
    </aside>
    <div className="formula-paper-scroll">
      <div className="formula-paper-heading">
        <div className="formula-eyebrow">SYSTEM EQUATIONS · MATHLIVE</div>
        <h2>系统公式手稿</h2>
        <p>按 XML 运算顺序逐步展开。u 表示输入信号，t 表示中间结果；选择公式可编辑并回写 XML。</p>
        <div className="formula-search">
          <label htmlFor="formula-search">搜索已有公式中的变量名</label>
          <input id="formula-search" type="search" value={query} onChange={event => setQuery(event.target.value)}
            placeholder="如 position/h-sl-meters 或 camera-pitch-rad" />
          <span aria-live="polite">找到 {visible.length} 条公式</span>
        </div>
      </div>
      {selected && <div className="formula-relationship" id="formula-relationship" aria-label="所有公式的信号关联">
        <div className="formula-relationship-heading">
          <label htmlFor="formula-relationship-select">信号关联</label>
          <select id="formula-relationship-select" value={selected.id} onChange={event => setSelectedId(event.target.value)}>
            {sheets.map(sheet => <option key={sheet.id} value={sheet.id}>
              {String(sheet.sequence).padStart(2, '0')} {sheet.output}{sheet.kind === 'integrator' ? ' · 积分器' : ''}
            </option>)}
          </select>
          <span>{sheets.length} 个节点 · {relations.length} 条内部关联</span>
        </div>
        <div className="formula-relationship-track">
          <div className="formula-relationship-group">
            <div className="formula-relationship-label">输入来源 · {incoming.length}</div>
            {incoming.length ? incoming.map(({ source }) => <button type="button" className={`formula-relationship-step${source.kind === 'integrator' ? ' integrator' : ''}`}
              key={source.id} onClick={() => setSelectedId(source.id)} aria-label={`查看 ${source.name} 的关联`}>
              <span>{source.kind === 'integrator' ? '积分器' : `${String(source.sequence).padStart(2, '0')} · 系统函数`}</span>
              <strong>{source.output}</strong><code>{source.name}</code>
            </button>) : <div className="formula-relationship-empty">无内部公式来源</div>}
          </div>
          <span className="formula-relationship-arrow" aria-hidden="true">→</span>
          <div className={`formula-relationship-current${selected.kind === 'integrator' ? ' integrator' : ''}`}>
            <span>{selected.kind === 'integrator' ? '积分器' : `${String(selected.sequence).padStart(2, '0')} · 当前公式`}</span>
            <strong>{selected.output}</strong><code>{selected.name}</code>
            <button type="button" onClick={() => jumpToSheet(selected.id)}>定位卡片</button>
          </div>
          <span className="formula-relationship-arrow" aria-hidden="true">→</span>
          <div className="formula-relationship-group">
            <div className="formula-relationship-label">输出去向 · {outgoing.length}</div>
            {outgoing.length ? outgoing.map(({ target }) => <button type="button" className={`formula-relationship-step${target.kind === 'integrator' ? ' integrator' : ''}`}
              key={target.id} onClick={() => setSelectedId(target.id)} aria-label={`查看 ${target.name} 的关联`}>
              <span>{target.kind === 'integrator' ? '积分器' : `${String(target.sequence).padStart(2, '0')} · 系统函数`}</span>
              <strong>{target.output}</strong><code>{target.name}</code>
            </button>) : <div className="formula-relationship-empty">无内部公式去向</div>}
          </div>
        </div>
      </div>}
      {creating && <section className="formula-edit-card">
        <h3>新建公式</h3>
        <label>输出信号名</label>
        <SignalPathInput value={newName} onChange={setNewName} placeholder="如 fcs/new-output" />
        {createError && <p role="alert" className="mathlive-error">{createError}</p>}
        <MathLiveEditor expression={{ kind: 'value', value: 0 }} onCancel={() => setCreating(false)}
          onApply={expression => {
            const name = newName.trim();
            if (!name) { setCreateError('请填写输出信号名'); return; }
            if (sheets.some(sheet => sheet.name === name)) { setCreateError('该输出信号已存在'); return; }
            onCreate(name, expression);
            setCreating(false); setNewName(''); setCreateError('');
          }} />
      </section>}
      {visible.length ? <div className="formula-sheets">
        {visible.map(sheet => {
          const destinations = relations.filter(relation => relation.source.id === sheet.id).map(relation => relation.target);
          return <article className="formula-sheet" id={`formula-${sheet.id}`} key={sheet.id}>
          <header>
            <span className="formula-sheet-number">{String(sheet.sequence).padStart(2, '0')}</span>
            <div><div className="formula-channel">{sheet.channel}</div><h3>{sheet.output}</h3>
              <div className="formula-path" title={sheet.name}>{sheet.name}</div></div>
            <button type="button" className="formula-show-relations" onClick={() => showRelations(sheet.id)}>查看关联</button>
          </header>
          {(['function', 'fcs_function'].includes(String(nodes.find(node => node.id === sheet.id)?.data?.itemType))) &&
            <button type="button" className="formula-edit-toggle" onClick={() => setEditing(editing === sheet.id ? null : sheet.id)}>
              {editing === sheet.id ? '收起编辑器' : '✎ MathLive 编辑'}
            </button>}
          {editing === sheet.id && (() => {
            const expression = nodes.find(node => node.id === sheet.id)?.data?.expression as ExprNode | undefined;
            return expression ? <MathLiveEditor key={sheet.id} expression={expression}
              onApply={next => { onUpdate(sheet.id, next); setEditing(null); }} onCancel={() => setEditing(null)} /> : null;
          })()}
          <div className="formula-equations" aria-label={`${sheet.output} 的计算步骤`}>
            {sheet.lines.map((line, index) => <div className={`formula-line${line.result ? ' result' : ''}`} key={index}>
              <span className="formula-line-left">{line.left}</span><span className="formula-equals">=</span>
              <span className="formula-line-right">{line.right}</span>
            </div>)}
          </div>
          {!!sheet.inputs.length && <div className="formula-inputs">
            {sheet.inputs.map(input => {
              const source = sheetsByName.get(input.path);
              const matched = normalized && (input.path.toLowerCase().includes(normalized) || input.symbol.toLowerCase() === normalized);
              return <div key={input.path} title={input.path}
                className={[matched && 'formula-input-match', source && 'formula-input-linked'].filter(Boolean).join(' ') || undefined}>
                <strong>{input.symbol}</strong><span>=</span>
                {source ? <button type="button" className="formula-input-link" onClick={() => jumpToSheet(source.id)}
                  aria-label={`跳转到信号来源 ${source.name}`}><code>{input.path}</code></button> : <code>{input.path}</code>}
              </div>;
            })}
          </div>}
          {!!destinations.length && <div className="formula-relationship-output">
            <span>输出到</span>
            {destinations.map(target => <button type="button" key={target.id} onClick={() => jumpToSheet(target.id)}>
              {target.kind === 'integrator' ? '积分器' : String(target.sequence).padStart(2, '0')} {target.output}
            </button>)}
          </div>}
        </article>})}
      </div> : <div className="formula-empty">没有找到匹配的公式</div>}
    </div>
  </section>;
}
