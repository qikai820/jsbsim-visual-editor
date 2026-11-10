import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Px4Connection } from '../px4/connection';
import { metadataLabel, parseMetadata, type MetadataCatalog } from '../px4/metadata';
import { downloadLog, loadVehicleMetadata, readLogs, readParameters, type LogEntry, type Parameter, type UlogSummary } from '../px4/services';
import { Px4Shell, type TerminalChannel } from '../px4/shell';
import { selectSimulatorPx4Source, simulatorPx4AttachError, simulatorPx4Sources } from '../px4/simulatorSource';
import { useFlowStore } from '../store/flowStore';
import { useSignalMonitorStore } from '../store/signalMonitorStore';
import NshTerminal from './NshTerminal';
import './Px4Toolbox.css';

type LibraryItem = { path: string; name: string; size: number; source: 'downloaded' | 'local'; stamp?: string };
const EMPTY_CHANNEL: TerminalChannel = { write: async () => { throw Error('请先连接飞控'); }, subscribe: () => () => {} };
function stored<T>(key: string, fallback: T): T { try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value ?? fallback; } catch { return fallback; } }
function save(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* A full preferences store does not stop device operations. */ } }
const bytes = (n: number) => n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1)+' KiB' : (n/1048576).toFixed(1)+' MiB';
const logTime = (n: number) => n ? new Date(n*1000).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
const valueText = (p: Parameter) => p.type === 9 ? String(Number(p.value.toPrecision(7))) : String(p.value);
const typeText: Record<number,string> = { 1:'UINT8',2:'INT8',3:'UINT16',4:'INT16',5:'UINT32',6:'INT32',9:'FLOAT' };

export default function Px4Toolbox({ onClose }: { onClose: () => void }) {
  const nodes = useFlowStore(s => s.nodes), instance = useSignalMonitorStore(s => s.instance);
  const sources = useMemo(() => simulatorPx4Sources(nodes), [nodes]);
  const [sourceKey, setSourceKey] = useState('');
  const source = selectSimulatorPx4Source(sources, sourceKey);
  const sourceIdentity = JSON.stringify([instance,source]);
  const [sourceState, setSourceState] = useState('等待仿真机数据');
  const [tab, setTab] = useState<'parameters'|'logs'|'nsh'>('parameters');
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [, refresh] = useState(0);
  const mounted = useRef(true), linkRef = useRef<Px4Connection | null>(null), shellRef = useRef<Px4Shell | null>(null);
  const metadataAbort = useRef<AbortController>(), operation = useRef<AbortController>();
  const [busy, setBusy] = useState(''), [metadataBusy, setMetadataBusy] = useState(false), [metadataError, setMetadataError] = useState('');
  const [catalog, setCatalog] = useState<MetadataCatalog>(), bundled = useRef<MetadataCatalog>();
  const [parameters, setParameters] = useState<Parameter[]>([]), [expected, setExpected] = useState<number | null>(null), [parameterComplete, setParameterComplete] = useState(false);
  const [mode, setMode] = useState<'metadata'|'prefix'|'custom'>('metadata'), [group, setGroup] = useState('all'), [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [page, setPage] = useState(0), [selectedParam, setSelectedParam] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => { const saved = stored<unknown>('px4-parameter-favorites', []); return Array.isArray(saved) ? saved.filter(x => typeof x === 'string') : []; });
  const [custom, setCustom] = useState<Record<string,string[]>>(() => {
    const saved = stored<Record<string,unknown>>('px4-parameter-groups', {}); return saved && typeof saved === 'object' && !Array.isArray(saved) ? Object.fromEntries(Object.entries(saved).filter(([k,v]) => k !== '__proto__' && Array.isArray(v)).map(([k,v]) => [k, (v as unknown[]).filter((s): s is string => typeof s === 'string')])) : {};
  });
  const [newGroup, setNewGroup] = useState(''), [addingGroup, setAddingGroup] = useState(false), [assignGroup, setAssignGroup] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]), [logExpected, setLogExpected] = useState<number | null>(null), [logSource, setLogSource] = useState('onboard'), [logSearch, setLogSearch] = useState(''), [selectedLogs, setSelectedLogs] = useState<number[]>([]), [selectedLog, setSelectedLog] = useState('');
  const [library, setLibrary] = useState<LibraryItem[]>(() => { const value = stored<unknown>('px4-log-library-v1', []); return Array.isArray(value) ? value.filter(l => l && typeof l.path === 'string' && typeof l.name === 'string' && typeof l.size === 'number' && ['downloaded','local'].includes(l.source)).slice(0,64) : []; });
  const [summary, setSummary] = useState<UlogSummary>(), [detailTab, setDetailTab] = useState('overview'), [summaryBusy, setSummaryBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ id: number; received: number; total: number; index: number; count: number }>();
  const summaryGeneration = useRef(0);
  const link = linkRef.current, shell = shellRef.current, alive = link?.alive || false;
  useEffect(() => {
    mounted.current = true; const abort = new AbortController();
    void fetch('/px4/PX4ParameterFactMetaData.json', { signal: abort.signal }).then(r => { if (!r.ok) throw Error('内置参数库读取失败'); return r.text(); }).then(text => {
      const fallback = parseMetadata(text, { kind:'bundled', label:'QGC / PX4ParameterFactMetaData.json', matched:false }); bundled.current = fallback;
      if (mounted.current) setCatalog(current => current || fallback);
    }).catch(e => { if (!abort.signal.aborted && mounted.current) setMetadataError(String(e)); });
    return () => { mounted.current = false; abort.abort(); operation.current?.abort(); metadataAbort.current?.abort();  };
  }, []);
  useEffect(() => { save('px4-parameter-favorites', favorites); }, [favorites]);
  useEffect(() => { save('px4-parameter-groups', custom); }, [custom]);
  useEffect(() => { save('px4-log-library-v1', library); }, [library]);
  useEffect(() => { setPage(0); }, [group, mode, filter, search]);

  const loadMetadata = async (connection: Px4Connection) => {
    metadataAbort.current?.abort(); const abort = new AbortController(); metadataAbort.current = abort; setMetadataBusy(true); setMetadataError('');
    try { const metadata = await loadVehicleMetadata(connection, abort.signal); if (mounted.current && linkRef.current === connection && !abort.signal.aborted) setCatalog(metadata); }
    catch (e) { if (mounted.current && !abort.signal.aborted && linkRef.current === connection) setMetadataError(`飞控元数据未取得，使用参考库：${String(e)}`); }
    finally { if (mounted.current && metadataAbort.current === abort) setMetadataBusy(false); }
  };
  useEffect(() => {
    let disposed = false, opening = false, owned: Px4Connection | null = null;
    operation.current?.abort(); metadataAbort.current?.abort(); setParameters([]); setExpected(null); setParameterComplete(false); setLogs([]); setLogExpected(null); setSelectedLog(''); setSummary(undefined); setCatalog(bundled.current);
    const attach = async () => {
      if (disposed || opening) return;
      if (owned?.connected && (!owned.lastHeartbeat || Date.now()-owned.lastHeartbeat<5000)) return;
      if (!source.enabled) { setSourceState('仿真机 MAVLink 转发已关闭'); return; }
      if (!Number.isInteger(source.port) || source.port<1 || source.port>65535) { setSourceState('模型中的 MAVLink 转发端口无效'); return; }
      opening = true;
      try {
        await owned?.close();
        if (owned) { operation.current?.abort(); metadataAbort.current?.abort(); setParameters([]);setExpected(null);setParameterComplete(false);setLogs([]);setLogExpected(null);setSelectedLogs([]);setCatalog(bundled.current); }
        const host = await invoke<string|null>('simulator_network_target_get').catch(()=>null);
        if (disposed) return;
        const connection = new Px4Connection({system:0,component:0},host||undefined), terminal = new Px4Shell(connection); let initialized = false;
        owned = connection; linkRef.current = connection; shellRef.current = terminal;
        connection.onChange = () => {
          if (disposed || !mounted.current) return; refresh(v=>v+1);
          if (connection.lastHeartbeat && !initialized) {
            initialized = true;
            if (source.bidirectional) { void connection.requestMessage(148).catch(e=>{if(!disposed)setError(String(e));}); void loadMetadata(connection); }
          }
        };
        connection.onError = terminal.onError = e=>{if(!disposed&&mounted.current)setError(e);};
        terminal.onChange = ()=>{if(!disposed&&mounted.current)refresh(v=>v+1);};
        setSourceState('自动接收仿真机转发数据');
        await connection.open({network:{mode:'udp',host:'',port:source.port,localHost:'0.0.0.0',localPort:source.port}});
        if (disposed) {await connection.close();return;}
        setSourceState('仿真机转发通道已就绪'); refresh(v=>v+1);
      } catch(e) { if(!disposed&&mounted.current)setSourceState(simulatorPx4AttachError(source.port, e)); }
      finally { opening=false; }
    };
    void attach(); const timer=setInterval(()=>void attach(),2500);
    return ()=>{disposed=true;clearInterval(timer);operation.current?.abort();metadataAbort.current?.abort();const terminal=shellRef.current;void (async()=>{await terminal?.close();await owned?.close();})().catch(()=>{});if(linkRef.current===owned){linkRef.current=null;shellRef.current=null;}};
  }, [sourceIdentity]);
  useEffect(()=>{
    if(tab==='nsh'&&alive&&source.bidirectional&&shell&&!shell.active)void shell.open().catch(e=>{if(mounted.current)setError(String(e));});
  },[tab,alive,shell,source.bidirectional]);
  const run = async (kind: string, task: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current && !operation.current.signal.aborted) return;
    const abort = new AbortController(); operation.current = abort; setBusy(kind); setError(''); setMessage('');
    try { await task(abort.signal); } catch (e) { if (mounted.current) { if (abort.signal.aborted) setMessage('操作已取消'); else setError(String(e)); } }
    finally { if (operation.current === abort) { operation.current = undefined; if (mounted.current) setBusy(''); } }
  };
  const readAll = () => { const current = linkRef.current; if (!current?.alive) return; setParameterComplete(false); setParameters([]); setExpected(null);
    void run('parameters', async signal => { await readParameters(current, (p,n) => { if (mounted.current && !signal.aborted && linkRef.current===current) { setParameters(p); setExpected(n); } }, signal); if (mounted.current && !signal.aborted && linkRef.current===current) { setParameterComplete(true); setMessage('参数读取完成'); } }); };
  const refreshLogs = () => { const current = linkRef.current; if (!current?.alive) return; setLogs([]); setLogExpected(null); setSelectedLogs([]);
    void run('logs', async signal => { await readLogs(current, (l,n) => { if (mounted.current && !signal.aborted && linkRef.current===current) { setLogs(l); setLogExpected(n); } }, signal); if (mounted.current && !signal.aborted && linkRef.current===current) setMessage('日志列表读取完成'); }); };
  const importMetadata = async () => {
    try { const result = await invoke<{ name:string; text:string } | null>('px4_metadata_pick'); if (!result || !mounted.current) return;
      const metadata = parseMetadata(result.text, { kind:'import', label:result.name, matched:false }); metadataAbort.current?.abort(); setMetadataBusy(false); setMetadataError(''); setCatalog(metadata);
    } catch (e) { setError(String(e)); }
  };
  const rows = useMemo(() => parameters.map(p => { const meta = catalog?.get(p.name); return { ...p, meta, changed: meta?.default !== undefined && p.value !== (p.type === 9 ? Math.fround(meta.default) : meta.default) }; }), [parameters, catalog]);
  const groups = useMemo(() => {
    if (mode === 'custom') return Object.entries(custom).map(([name,names]) => ({ key:name, name, category:'自定义分组', count:rows.filter(r => names.includes(r.name)).length }));
    const groups = new Map<string,{key:string;name:string;category:string;count:number}>();
    for (const p of rows) { const name = mode === 'prefix' ? p.name.split('_')[0] : p.meta?.group || p.name.split('_')[0]; const category = mode === 'prefix' ? '参数前缀' : p.meta?.category || '未匹配元数据'; const key = category+'::'+name;
      const g = groups.get(key) || { key,name,category,count:0 }; g.count++; groups.set(key,g); }
    return [...groups.values()].sort((a,b) => (a.category==='Standard'?0:1)-(b.category==='Standard'?0:1) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }, [rows, mode, custom]);
  const filtered = useMemo(() => rows.filter(p => {
    const query = search.trim().toLowerCase();
    if (query) { if (!(p.name+' '+(p.meta?.shortDesc||'')+' '+(p.meta?.longDesc||'')).toLowerCase().includes(query)) return false; }
    else if (group === 'favorites') { if (!favorites.includes(p.name)) return false; }
    else if (group !== 'all') {
      if (mode === 'custom') { if (!custom[group]?.includes(p.name)) return false; }
      else { const name = mode === 'prefix'?p.name.split('_')[0]:p.meta?.group||p.name.split('_')[0], category = mode === 'prefix'?'参数前缀':p.meta?.category||'未匹配元数据'; if (category+'::'+name !== group) return false; }
    }
    return filter === 'changed' ? p.changed : filter === 'favorite' ? favorites.includes(p.name) : true;
  }), [rows, search, group, mode, favorites, custom, filter]);
  const selected = rows.find(p => p.name === selectedParam) || filtered[0];
  const groupTitle = search.trim() ? '全局搜索结果' : group==='all'?'全部参数':group==='favorites'?'收藏参数':groups.find(g => g.key===group)?.name||'参数分组';
  const exportParameters = async () => {
    if (!filtered.length) return;
    try { const current = linkRef.current; const text = `# PX4 parameters\n# ${parameterComplete?'Complete read':'Partial read'}; source SYS ${current?.target.system ?? 0} / COMP ${current?.target.component ?? 0}\n# MAV ID\tCOMPONENT ID\tPARAM NAME\tVALUE\tTYPE\n`+filtered.map(p => `${current?.target.system??0}\t${current?.target.component??0}\t${p.name}\t${p.value}\t${p.type}`).join('\n')+'\n';
      const path = await invoke<string|null>('px4_parameters_save', { text }); if (path) setMessage('已导出：'+path);
    } catch (e) { setError(String(e)); }
  };
  const addGroup = () => { const name = newGroup.trim(); if (!name || name === '__proto__') return; if (Object.prototype.hasOwnProperty.call(custom,name)) { setError('分组名称已存在'); return; }
    setCustom(c => ({ ...c,[name]:[] })); setMode('custom'); setGroup(name); setAssignGroup(name); setAddingGroup(false); setNewGroup(''); };
  const deviceKey = link?.uid && link.uid !== '0' ? link.uid : `${instance}:${source.id}:${source.port}:${link?.target.system??0}:${link?.target.component??0}`;
  const stamp = (log: LogEntry) => [deviceKey,log.id,log.time,log.size].join(':');
  const localFor = (log:LogEntry) => library.find(l => l.stamp===stamp(log));
  const addLibrary = (s:UlogSummary, source:'downloaded'|'local', log?:LogEntry) => {
    const item: LibraryItem = { path:s.path,name:s.name,size:s.size,source,stamp:log?stamp(log):undefined };
    setLibrary(items => [item,...items.filter(i => i.path!==s.path)].slice(0,64)); setSummary(s); setSelectedLog('local:'+s.path); setDetailTab('overview');
  };
  const inspectLocal = async (item:LibraryItem) => {
    const generation = ++summaryGeneration.current; setSelectedLog('local:'+item.path); setSummary(undefined); setSummaryBusy(true);
    try { const s = await invoke<UlogSummary>('px4_log_inspect', { path:item.path }); if (mounted.current && generation === summaryGeneration.current) setSummary(s); }
    catch (e) { if (mounted.current && generation === summaryGeneration.current) setError(String(e)); }
    finally { if (mounted.current && generation === summaryGeneration.current) setSummaryBusy(false); }
  };
  const openLog = async () => { try { const s = await invoke<UlogSummary|null>('px4_log_pick'); if (s && mounted.current) { summaryGeneration.current++; addLibrary(s,'local'); setLogSource('local'); } } catch (e) { setError(String(e)); } };
  const download = (ids:number[]) => { const current = linkRef.current; if (!current?.alive) return; const queue = logs.filter(l => ids.includes(l.id));
    void run('download', async signal => {
      for (let i=0;i<queue.length;i++) { const l=queue[i]; setDownloadProgress({ id:l.id,received:0,total:l.size,index:i+1,count:queue.length });
        const s = await downloadLog(current,l,signal,n => { if (mounted.current) setDownloadProgress({ id:l.id,received:n,total:l.size,index:i+1,count:queue.length }); });
        if (s && mounted.current && !signal.aborted && linkRef.current===current) { summaryGeneration.current++; addLibrary(s,'downloaded',l); setSelectedLogs(ids => ids.filter(id => id!==l.id)); setMessage('日志已保存：'+s.path); }
      }
    }); };
  const visibleRemote = logs.filter(l => (`${l.id} ${logTime(l.time)}`).includes(logSearch.trim()));
  const visibleLocal = library.filter(l => l.source===logSource && l.name.toLowerCase().includes(logSearch.toLowerCase()));
  const selectedRemote = selectedLog.startsWith('remote:') ? logs.find(l => l.id===Number(selectedLog.slice(7))) : undefined;
  return <div className="px4-toolbox-overlay" role="dialog" aria-modal="true" aria-label="PX4 工具箱">
    <section className="px4-toolbox">
      <header className="px4-toolbox-head"><div><h2>PX4 工具箱</h2><small>参数 · 日志 · NSH 控制台</small></div><button type="button" aria-label="关闭 PX4 工具箱" onClick={onClose}>×</button></header>
      <div className="px4-connectbar"><span className={'px4-status '+(alive?'connected':'')}>{alive?'● 仿真机 PX4 数据在线':'◌ 等待仿真机 PX4 数据'}</span><span className="px4-muted">实例 {instance}{link?.target.system?' · SYS '+link.target.system+' / COMP '+link.target.component:''}{link?.version?' · PX4 '+link.version:''}</span><span className="px4-endpoint">{source.name} · {sourceState}</span>{sources.length>1&&<select aria-label="仿真机转发来源" value={source.key} onChange={e=>setSourceKey(e.target.value)}>{sources.map(s=><option key={s.key} value={s.key}>{s.name} · {s.id}</option>)}</select>}</div>
      {!source.bidirectional&&<div className="px4-notice">当前仿真机转发为单向，无法请求参数、日志或发送 NSH 输入。</div>}
      <nav className="px4-tabs" role="tablist" aria-label="PX4 功能">{(['parameters','logs','nsh'] as const).map(t=><button key={t} type="button" role="tab" id={'px4-tab-'+t} aria-controls={'px4-panel-'+t} aria-selected={tab===t} onClick={()=>setTab(t)}>{({parameters:'参数',logs:'日志',nsh:'NSH 控制台'})[t]}</button>)}</nav>
      {error && <div className="px4-notice error" role="alert">{error}<button aria-label="关闭错误提示" onClick={()=>setError('')}>×</button></div>}
      {message && <div className="px4-notice" role="status">{message}<button aria-label="关闭状态提示" onClick={()=>setMessage('')}>×</button></div>}
      <section role="tabpanel" id="px4-panel-parameters" aria-labelledby="px4-tab-parameters" hidden={tab!=='parameters'} className="px4-panel">
        <div className="px4-parameter-layout">
          <aside className="px4-groups"><h3>参数分组</h3><select aria-label="参数分组方式" value={mode} onChange={e=>{setMode(e.target.value as typeof mode);setGroup('all');}}><option value="metadata">QGC 元数据分组</option><option value="prefix">按参数前缀</option><option value="custom">自定义分组</option></select>
            <button aria-pressed={group==='all'} onClick={()=>setGroup('all')}><span>全部参数</span><small>{parameters.length}</small></button><button aria-pressed={group==='favorites'} onClick={()=>setGroup('favorites')}><span>☆ 收藏参数</span><small>{rows.filter(p=>favorites.includes(p.name)).length}</small></button>
            <div className="px4-group-list">{groups.map((g,i)=><div key={g.key}>{(i===0||groups[i-1].category!==g.category)&&<div className="px4-category">{g.category}</div>}<button aria-pressed={group===g.key} onClick={()=>setGroup(g.key)}><span>{g.name}</span><small>{g.count}</small></button></div>)}</div>
            <button className="px4-new-group" onClick={()=>setAddingGroup(v=>!v)}>＋ 新建自定义分组</button>{addingGroup&&<form onSubmit={e=>{e.preventDefault();addGroup();}}><input aria-label="新分组名称" value={newGroup} maxLength={40} placeholder="分组名称" onChange={e=>setNewGroup(e.target.value)}/><button type="submit">创建</button></form>}
          </aside>
          <div className="px4-list-pane"><div className="px4-list-actions"><h3>{groupTitle}</h3><div><button disabled={!filtered.length} onClick={()=>void exportParameters()}>导出当前组</button><button className="px4-primary" disabled={!alive||!source.bidirectional||!!busy} onClick={readAll}>读取全部</button>{busy==='parameters'&&<button onClick={()=>operation.current?.abort()}>取消</button>}</div></div>
            <div className="px4-filter"><input aria-label="搜索 PX4 参数" placeholder="搜索全部参数：名称或说明" value={search} onChange={e=>setSearch(e.target.value)}/><select aria-label="参数筛选" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部参数</option><option value="changed">偏离参考默认</option><option value="favorite">仅收藏</option></select></div>
            <div className="px4-table-scroll"><table className="px4-param-table"><thead><tr><th>☆</th><th>参数 / 说明</th><th>当前值</th><th>参考默认</th></tr></thead><tbody>{filtered.slice(page*60,(page+1)*60).map(p=><tr key={p.name} className={selected?.name===p.name?'selected':''}><td><button aria-label={(favorites.includes(p.name)?'取消收藏 ':'收藏 ')+p.name} aria-pressed={favorites.includes(p.name)} onClick={()=>setFavorites(f=>f.includes(p.name)?f.filter(n=>n!==p.name):[...f,p.name])}>{favorites.includes(p.name)?'★':'☆'}</button></td><td><button className="px4-param-pick" onClick={()=>setSelectedParam(p.name)}><code>{p.name}</code><small>{p.meta?.shortDesc||'暂无元数据说明'}</small></button></td><td className="px4-number">{p.changed&&<span className="px4-change-dot"/>}{valueText(p)}</td><td className="px4-number px4-muted">{p.meta?.default??'—'}</td></tr>)}</tbody></table>
              {!filtered.length&&<div className="px4-empty">{parameters.length?'没有匹配的参数':'仿真机数据就绪后，点击“读取全部”获取 PX4 参数'}</div>}
            </div><div className="px4-list-footer"><span>{parameters.length}/{expected??'?'} 项 · {busy==='parameters'?'读取中':parameterComplete?'读取完成':parameters.length?'部分数据':'尚未读取'}</span><div><button disabled={page===0} onClick={()=>setPage(p=>p-1)}>上一页</button><span>{Math.min(page+1,Math.max(1,Math.ceil(filtered.length/60)))} / {Math.max(1,Math.ceil(filtered.length/60))}</span><button disabled={(page+1)*60>=filtered.length} onClick={()=>setPage(p=>p+1)}>下一页</button></div></div>
          </div>
          <aside className="px4-details"><div className="px4-detail-heading"><h3>参数详情</h3><span>只读</span></div>{selected?<><code className="px4-detail-name">{selected.name}</code><p>{selected.meta?.shortDesc||'暂无元数据说明'}</p><div className="px4-current-value"><div><small>当前读取值</small><strong>{valueText(selected)}</strong></div><span>{typeText[selected.type]||selected.type}</span></div>
            {selected.meta?.longDesc&&<details><summary>详细说明 · 原文</summary><p>{selected.meta.longDesc}</p></details>}
            <dl><dt>参考默认</dt><dd>{selected.meta?.default??'—'}</dd><dt>单位</dt><dd>{selected.meta?.units||'—'}</dd><dt>范围</dt><dd>{selected.meta?.min??'未指定'} ～ {selected.meta?.max??'未指定'}</dd><dt>类别</dt><dd>{selected.meta?.category||'未匹配'}</dd><dt>分组</dt><dd>{selected.meta?.group||selected.name.split('_')[0]}</dd>{selected.meta?.rebootRequired&&<><dt>生效要求</dt><dd>需重启</dd></>}</dl>
            {!!selected.meta?.values.length&&<details><summary>枚举含义</summary>{selected.meta.values.map(v=><div className="px4-value-label" key={v.value}><code>{v.value}</code><span>{v.description}</span></div>)}</details>}
            {!!selected.meta?.bitmask.length&&<details open><summary>位掩码含义</summary>{selected.meta.bitmask.map(v=><div className="px4-value-label" key={v.index}><code>Bit {v.index} {((selected.value>>>v.index)&1)?'✓':''}</code><span>{v.description}</span></div>)}</details>}
            <div className="px4-detail-source"><small>分组与注释来源</small><b>{selected.meta&&catalog?metadataLabel(catalog.source):'元数据未匹配'}</b><span>{selected.meta&&catalog?catalog.source.label:'仅按参数前缀分组'}</span><span>{catalog?.source.matched&&selected.meta?(catalog.source.crc?'飞控发布 · CRC32 校验通过':'飞控发布 · 未提供 CRC32'):'固件匹配未验证'}</span></div>
            <label>加入自定义分组<div className="px4-assign"><select aria-label="加入自定义分组" value={assignGroup||Object.keys(custom)[0]||''} onChange={e=>setAssignGroup(e.target.value)}>{!Object.keys(custom).length&&<option value="">请先新建分组</option>}{Object.keys(custom).map(g=><option key={g}>{g}</option>)}</select><button disabled={!Object.keys(custom).length} onClick={()=>{const g=assignGroup||Object.keys(custom)[0];if(g)setCustom(c=>({...c,[g]:[...new Set([...(c[g]||[]),selected.name])]}));}}>加入</button></div></label>
            <small className="px4-muted">已加入：{Object.entries(custom).filter(([,names])=>names.includes(selected.name)).map(([g])=>g).join('、')||'无'}</small>
          </>:<div className="px4-empty">选择参数查看说明</div>}</aside>
        </div>
        <div className="px4-metadata-status"><span>{metadataBusy?'正在读取飞控元数据…':catalog?metadataLabel(catalog.source)+' · '+catalog.count+' 项 · '+(catalog.source.matched?'飞控匹配':'仅供参考，固件匹配未验证'):'暂无元数据'}{metadataError&&<span className="px4-metadata-error">{metadataError}</span>}</span><div><button disabled={!alive||!source.bidirectional||metadataBusy} onClick={()=>linkRef.current&&void loadMetadata(linkRef.current)}>刷新飞控元数据</button><button onClick={()=>void importMetadata()}>导入元数据</button></div></div>
      </section>
      <section role="tabpanel" id="px4-panel-logs" aria-labelledby="px4-tab-logs" hidden={tab!=='logs'} className="px4-panel">
        <div className="px4-log-layout"><aside className="px4-groups"><h3>日志来源</h3>{[['onboard','板载日志',logs.length],['downloaded','已下载',library.filter(l=>l.source==='downloaded').length],['local','本地导入',library.filter(l=>l.source==='local').length]].map(([key,label,n])=><button key={key} aria-pressed={logSource===key} onClick={()=>setLogSource(String(key))}><span>{label}</span><small>{n}</small></button>)}</aside>
          <div className="px4-list-pane"><div className="px4-list-actions"><h3>{logSource==='onboard'?'板载日志':logSource==='downloaded'?'已下载':'本地导入'}</h3><div><button onClick={()=>void openLog()}>打开本地 .ulg</button><button disabled={!alive||!source.bidirectional||!!busy} onClick={refreshLogs}>刷新板载列表</button></div></div>
            <div className="px4-filter"><input aria-label="搜索 PX4 日志" placeholder="搜索日志编号、时间或文件名" value={logSearch} onChange={e=>setLogSearch(e.target.value)}/>{logSource==='onboard'&&<button className="px4-primary" disabled={!alive||!source.bidirectional||!!busy||!selectedLogs.length} onClick={()=>download(selectedLogs)}>下载所选（{selectedLogs.length}）</button>}{busy==='logs'&&<button onClick={()=>operation.current?.abort()}>取消</button>}</div>
            <div className="px4-table-scroll"><table className="px4-log-table"><thead><tr>{logSource==='onboard'&&<th><input type="checkbox" aria-label="选择全部板载日志" checked={!!visibleRemote.length&&visibleRemote.every(l=>selectedLogs.includes(l.id))} onChange={e=>setSelectedLogs(e.target.checked?visibleRemote.map(l=>l.id):[])}/></th>}<th>日志 / 飞控报告时间</th><th>大小</th><th>状态</th></tr></thead><tbody>
              {logSource==='onboard'?visibleRemote.map(l=><tr key={l.id} className={selectedLog==='remote:'+l.id?'selected':''}><td><input type="checkbox" aria-label={'选择日志 '+l.id} checked={selectedLogs.includes(l.id)} onChange={e=>setSelectedLogs(ids=>e.target.checked?[...ids,l.id]:ids.filter(id=>id!==l.id))}/></td><td><button className="px4-log-pick" onClick={()=>{const item=localFor(l);if(item){void inspectLocal(item);}else{summaryGeneration.current++;setSummaryBusy(false);setSummary(undefined);setSelectedLog('remote:'+l.id);}}}><code>日志 #{l.id}</code><small>{logTime(l.time)}</small></button></td><td>{bytes(l.size)}</td><td>{localFor(l)?'本地可用':'待下载'}</td></tr>):visibleLocal.map(l=><tr key={l.path} className={selectedLog==='local:'+l.path?'selected':''}><td><button className="px4-log-pick" onClick={()=>void inspectLocal(l)}><code>{l.name}</code><small>{l.path}</small></button></td><td>{bytes(l.size)}</td><td>本地文件</td></tr>)}
            </tbody></table>{(logSource==='onboard'?!visibleRemote.length:!visibleLocal.length)&&<div className="px4-empty">{logSource==='onboard'?'仿真机数据就绪后刷新板载日志列表':'暂无本地日志'}</div>}</div>
            <div className="px4-list-footer"><span>{logSource==='onboard'?`${logs.length}/${logExpected??'?'} 个板载日志`:visibleLocal.length+' 个文件'}</span><span>ULog · .ulg</span></div>
            {downloadProgress&&<div className="px4-download"><div><span>日志 #{downloadProgress.id} · 队列 {downloadProgress.index}/{downloadProgress.count}{busy==='download'?' · 下载中':''}</span>{busy==='download'&&<button onClick={()=>operation.current?.abort()}>取消下载</button>}</div><progress max={downloadProgress.total} value={downloadProgress.received}/><small>{bytes(downloadProgress.received)} / {bytes(downloadProgress.total)}</small></div>}
          </div>
          <aside className="px4-details"><h3>日志详情</h3>{summaryBusy?<p>正在读取 ULog…</p>:summary?<><code className="px4-detail-name">{summary.name}</code><div className="px4-log-detail-tabs">{[['overview','概览'],['topics','主题'],['parameters','参数快照']].map(([k,label])=><button key={k} aria-pressed={detailTab===k} onClick={()=>setDetailTab(k)}>{label}</button>)}</div>
            {detailTab==='overview'&&<><dl><dt>时长</dt><dd>{summary.duration===null?'未知':summary.duration.toFixed(1)+' s'}</dd><dt>大小</dt><dd>{bytes(summary.size)}</dd><dt>主题数</dt><dd>{summary.topics.length}</dd><dt>丢失记录</dt><dd>{summary.dropoutCount} 次 / {summary.dropoutMs} ms</dd></dl>{Object.entries(summary.info).filter(([k])=>/ver_|sys_|hardware|software/.test(k)).map(([k,v])=><p className="px4-log-info" key={k}><small>{k}</small><code>{v}</code></p>)}{summary.truncated&&<p className="px4-error-text">文件尾部不完整；概览仅包含已解析部分。</p>}<small className="px4-muted">{summary.path}</small></>}
            {detailTab==='topics'&&summary.topics.map(t=><div className="px4-value-label" key={t.name+':'+t.multiId}><code>{t.name}{t.multiId?' ['+t.multiId+']':''}</code><span>{t.samples} 条{t.frequency!==null?' · '+t.frequency.toFixed(1)+' Hz':''}</span></div>)}
            {detailTab==='parameters'&&Object.entries(summary.parameters).map(([k,v])=><div className="px4-value-label" key={k}><code>{k}</code><span>{String(v)}</span></div>)}
          </>:selectedRemote?<><code className="px4-detail-name">日志 #{selectedRemote.id}</code><dl><dt>记录时间</dt><dd>{logTime(selectedRemote.time)}</dd><dt>文件大小</dt><dd>{bytes(selectedRemote.size)}</dd><dt>状态</dt><dd>尚未下载</dd></dl><button className="px4-primary" disabled={!alive||!source.bidirectional||!!busy} onClick={()=>download([selectedRemote.id])}>下载此日志</button><p className="px4-muted">下载后可查看概览、主题和日志内参数快照。</p></>:<div className="px4-empty">选择日志查看详情</div>}</aside>
        </div>
      </section>
      <section role="tabpanel" id="px4-panel-nsh" aria-labelledby="px4-tab-nsh" hidden={tab!=='nsh'} className="px4-panel px4-nsh-panel"><div className="px4-nsh-heading"><div><b>NuttX NSH 控制台</b><small>仿真机转发 · PX4 {link?.target.system?'SYS '+link.target.system+' / COMP '+link.target.component:'等待识别'} · MAVLink Shell</small></div><small>{shell?.active&&alive?'交互会话已就绪':'等待仿真机终端数据'}</small></div><NshTerminal channel={shell||EMPTY_CHANNEL} connected={!!shell?.active&&alive} historyKey={`px4-nsh-history-${link?.target.system??0}-${link?.target.component??0}`}/></section>
      <footer className="px4-toolbox-footer"><span>{alive?'仿真机 PX4 数据正常':'等待仿真机转发数据'}{link?.connected&&!alive&&link.lastHeartbeat>0?' · 心跳超时':''}</span><span>{tab==='parameters'?'参数值来自飞控；分组与注释来自元数据':tab==='logs'?'完整接收并验证后保存 .ulg 文件':'持续交互会话 · 终端输出由飞控返回'}</span></footer>
    </section>
  </div>;
}
