import { useMemo } from 'react';
import {
  previewTestEstimate, runningTestEstimate, testStepLabel, testTimingKey, waitingForBlock, type TestEstimate,
} from '../flight-test/progress';
import { activeTestActions, testTime } from '../flight-test/scene';
import { testStatusLabels, type SessionState } from '../flight-test/session';
import './FlightTestProgress.css';

function useNextEstimate(session: SessionState, dryRun: boolean) {
  const { workspace, context, timingHistory } = session;
  const document = workspace.raw || workspace.pendingDraft || workspace.error || !workspace.source ? null : workspace.document;
  const link = context?.link;
  return useMemo(() => {
    const key = document ? testTimingKey(document, dryRun, context) : '';
    return previewTestEstimate(document, timingHistory[key] ?? []);
  }, [document, timingHistory, dryRun, context?.instance, link?.expectedHost, link?.target.system,
    link?.target.component, link?.version, link?.uid]);
}

export function useTestProgress(session: SessionState) {
  const { starting, stopping, snapshot, runDocument, runProgress, timingHistory, workspace } = session;
  const run = snapshot?.id && !starting ? snapshot : null;
  const status = stopping ? 'exiting' : starting ? 'preflight' : run?.status ?? 'idle';
  const nextEstimate = useNextEstimate(session, run?.dryRun ?? false);
  const progress = run?.progress;
  const actions = status === 'running' ? activeTestActions(run, runDocument, runProgress) : [];
  const beforeRun = !run && !workspace.raw && !workspace.pendingDraft && !workspace.error && !!workspace.source;
  const total = progress?.total ?? (beforeRun ? workspace.document.blocks.length : null);
  const completed = progress?.completedAt.length ?? 0;
  const percent = total === null ? null : total === 0
    ? (progress?.scriptFinishedAt != null ? 100 : 0)
    : Math.min(100, Math.floor(completed * 100 / total));
  const terminal = ['passed', 'failed', 'stopped'].includes(status);
  const estimateSamples = runProgress && runProgress.runId === run?.id ? timingHistory[runProgress.timingKey] ?? [] : [];
  const current = actions[0]?.block;
  const holding = current?.type === 'heading'
    ? run?.values['test/heading/held-s'] : run?.values['test/attitude/held-s'];
  const waiting = holding && ['heading', 'attitude', 'attitude_delta'].includes(current?.type ?? '')
    ? undefined : waitingForBlock(current);
  let estimate: TestEstimate = nextEstimate;
  if (status === 'running' && run) {
    estimate = runningTestEstimate(run, runDocument, estimateSamples, waiting);
  } else if (status === 'preflight' || status === 'exiting') {
    estimate = { label: '预计剩余', value: '等待确认' };
  } else if (terminal) {
    const canEstimate = !['—', '待估算'].includes(nextEstimate.value);
    const label = nextEstimate.label === '脚本估算' ? '下次脚本估算' : run?.dryRun ? '下次预演估时' : '下次飞控估时';
    estimate = canEstimate ? { ...nextEstimate, label }
      : { label: '预计剩余', value: '—' };
  }
  if (session.statusError && run && !terminal) estimate = { label: '预计剩余', value: '状态暂不可用' };

  const elapsed = run ? testTime(run.runElapsed ?? run.realElapsed) : '—';
  const scriptTime = run && (progress ? progress.scriptStartedAt != null : status !== 'preflight')
    ? testTime(run.elapsed) : '—';
  const action = status === 'running' ? actions[0]?.label ?? (runDocument ? '等待执行反馈' : '原始 XML · 执行中')
    : status === 'preflight' ? (starting ? '准备运行前检查' : '等待运行前检查确认')
    : status === 'exiting' ? '等待飞控退出确认'
    : status === 'failed' ? run?.logs.slice().reverse().find(log => log.level === 'error')?.message || run?.exitResult
    : terminal ? run?.exitResult || testStatusLabels[status] : '';
  const steps = progress && runDocument && total === runDocument.blocks.length ? runDocument.blocks.map((block, index) => {
    const done = index < completed;
    const started = progress?.scriptStartedAt != null && index === completed;
    const stepStatus = done ? '已完成' : started && status === 'failed' ? '失败'
      : started && status === 'stopped' ? '已中止' : started && status === 'running' ? '执行中' : '待执行';
    return { id: block.id, label: testStepLabel(block), status: stepStatus };
  }) : [];

  return { actions, action, status, terminal, elapsed, scriptTime, estimate, total, completed, percent, steps };
}

export type TestProgressView = ReturnType<typeof useTestProgress>;

export function TestProgressMetrics({ view }: { view: TestProgressView }) {
  const { completed, total, percent, status, estimate, elapsed, terminal } = view;
  const count = total === null || total === 0 ? '' : `${completed} / ${total} 步`;
  return <div className="test-progress-metrics" data-status={status}>
    <dl>
      <div><dt>脚本进度</dt><dd><strong>{percent === null ? '—' : percent + '%'}</strong>{count && <small>{count}</small>}</dd></div>
      <div><dt>{terminal ? '实际耗时' : '已用时间'}</dt><dd><strong>{elapsed}</strong></dd></div>
      <div><dt>{estimate.label}</dt><dd title={estimate.note}><strong>{estimate.value}</strong></dd></div>
    </dl>
    {percent !== null && <div className="test-progress-track" role="progressbar" aria-label="脚本进度"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={count ? '已完成 ' + count : undefined}>
      <div className="test-progress-fill" style={{ width: percent + '%' }} />
    </div>}
  </div>;
}
