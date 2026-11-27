import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { testStatusLabels, type TestReportArchive, type TestSnapshot } from '../flight-test/session';

type ReportEntry = TestReportArchive & {
  name: string;
  status: string;
  startedAtUnixMs: number;
  dryRun: boolean;
  model: string | null;
};

const openReport = (id: string) => invoke<void>('flight_test_report_open', { id });
const retryReport = (id: string) => invoke<ReportEntry>('flight_test_report_retry', { id });

export function LatestFlightTestReport({ snapshot, running, onError }: {
  snapshot: TestSnapshot | null; running: boolean; onError: (message: string) => void;
}) {
  const archive = snapshot?.archive;
  const [busy, setBusy] = useState(false);
  if (running || !archive) return null;

  const ready = archive.state === 'ready';
  const saving = archive.state === 'saving' || busy;
  async function act() {
    if (!archive) return;
    setBusy(true);
    onError('');
    try {
      if (ready) await openReport(archive.id);
      else await retryReport(archive.id);
    } catch (error) {
      onError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return <>
    <button type="button" disabled={saving} onClick={() => void act()}>
      {ready ? '查看报告' : saving ? '报告生成中…' : '重试保存报告'}
    </button>
    {archive.error && <span className="ft-report-error" role="status">{archive.error}</span>}
  </>;
}

export function FlightTestReportHistory({ snapshot, onClose }: {
  snapshot: TestSnapshot | null; onClose: () => void;
}) {
  const [entries, setEntries] = useState<ReportEntry[] | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [result, setResult] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = entries?.some(entry => entry.state === 'saving') ?? false;
  const archiveId = snapshot?.archive?.id;
  const archiveState = snapshot?.archive?.state;

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function load() {
      try {
        const reports = await invoke<ReportEntry[]>('flight_test_report_list');
        if (!active) return;
        setEntries(reports);
        if (reports.some(report => report.state === 'saving')) timer = window.setTimeout(() => void load(), 800);
      } catch (cause) {
        if (active) setError(String(cause));
      }
    }
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [archiveId, archiveState, refresh]);

  async function act(entry: ReportEntry) {
    setBusy(entry.id);
    setError('');
    try {
      if (entry.state === 'ready') await openReport(entry.id);
      else {
        await retryReport(entry.id);
        setRefresh(value => value + 1);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }

  const query = search.trim().toLowerCase();
  const visible = entries?.filter(entry => (!result || result === entry.status)
    && (!query || [entry.name, entry.model].some(value => value?.toLowerCase().includes(query)))) ?? [];
  return <section className="ft-popover ft-report-history" role="dialog" aria-modal="false" aria-label="历史报告">
    <header><b>历史报告</b><button type="button" aria-label="关闭历史报告" onClick={onClose}>×</button></header>
    <div className="ft-report-filters">
      <input type="search" aria-label="按测试名称或机型查找" placeholder="测试名称或机型" value={search}
        onChange={event => setSearch(event.target.value)}/>
      <select aria-label="按测试结果筛选" value={result} onChange={event => setResult(event.target.value)}>
        <option value="">全部结果</option><option value="passed">通过</option>
        <option value="failed">失败</option><option value="stopped">已终止</option>
      </select>
      <button type="button" onClick={() => { setError(''); setRefresh(value => value + 1); }}>刷新</button>
    </div>
    {error && <p className="ft-error" role="alert">{error}</p>}
    {entries == null ? (!error && <p role="status">读取历史报告…</p>)
      : visible.length === 0 ? <p>{entries.length ? '没有符合筛选条件的报告。' : '暂无测试报告。'}</p>
        : <ul className="ft-report-list">{visible.map(entry => <li key={entry.id}>
          <div>
            <b>{entry.name}</b>
            <small>{[entry.startedAtUnixMs > 0 ? new Date(entry.startedAtUnixMs).toLocaleString() : '',
              entry.dryRun ? '离线预演' : 'HIL', entry.model,
              entry.status === 'passed' ? '通过' : testStatusLabels[entry.status] ?? entry.status].filter(Boolean).join(' · ')}</small>
            {entry.error && <small className="ft-error">{entry.error}</small>}
          </div>
          <button type="button" disabled={busy !== null || entry.state === 'saving'} onClick={() => void act(entry)}>
            {entry.state === 'ready' ? '打开报告' : entry.state === 'saving' ? '生成中…'
              : entry.state === 'failed' ? '重试保存' : '生成报告'}
          </button>
        </li>)}</ul>}
    {pending && <p className="ft-report-pending" role="status">报告正在生成。</p>}
  </section>;
}
