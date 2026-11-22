import { activeTestActions, testTime } from '../../flight-test/scene';
import { openTestToolbox, sessionIsActive, setTestDisplay, startFlightTest, stopFlightTest, testStartReason, testStatusLabels, useFlightTestSession } from '../../flight-test/session';
import { SceneIcon } from './SceneInstruments';
import './sceneFlightTest.css';

function StopTest({ disabled, stopping }: { disabled: boolean; stopping: boolean }) {
  return <button type="button" className="scene-test-stop" disabled={disabled} onClick={() => void stopFlightTest()}>{stopping ? '确认退出中…' : '■ 终止'}</button>;
}
export function SceneFlightTestPanel({ hidden, selected, model, onSelectInstance }: {
  hidden: boolean; selected: string; model: string; onSelectInstance: (id: string) => void;
}) {
  const session = useFlightTestSession();
  if (hidden) return null;
  const { snapshot, workspace, runDocument, context, starting, stopping } = session;
  const active = sessionIsActive(session), expanded = session.display === 'details';
  const status = stopping ? 'exiting' : starting ? 'preflight' : snapshot?.status ?? 'idle';
  const hasRun = !!snapshot?.id && !starting;
  const instance = active ? starting ? session.runInstance : snapshot?.binding?.instance ?? session.runInstance : context?.instance;
  const id = instance === undefined || instance === null ? '' : String(instance).padStart(2, '0');
  const mismatch = !!id && Number(selected) !== Number(id);
  const name = hasRun && active ? snapshot.name : workspace.document.name;
  const dryRun = hasRun ? snapshot.dryRun : false;
  const actions = active && !starting ? activeTestActions(snapshot, runDocument) : [];
  const values = snapshot?.values ?? {};
  const attitude = values['test/attitude/active'] === 1 && active && !starting;
  const heading = values['test/heading/active'] === 1 && active && !starting;
  const altitude = values['test/altitude/active'] === 1 && active && !starting;
  const hold = actions.find(action => action.block && ['attitude', 'attitude_delta','heading'].includes(action.block.type))?.block?.p.hold;
  const held = values[heading?'test/heading/held-s':'test/attitude/held-s'];
  const reading = (key: string, digits = 1) => Number.isFinite(values[key]) ? values[key].toFixed(digits) : '—';
  const reason = mismatch ? `工具箱当前选择实例 ${id}，请先切换到该实例或在工具箱选择测试实例` : testStartReason(session);
  const previewReason = testStartReason(session, true);
  const start = (preview: boolean) => { void startFlightTest(preview).catch(() => {}); };
  return <section className="scene-test-panel" data-display={expanded ? 'details' : 'compact'} aria-label="视景仿真测试">
    <header><strong><SceneIcon name="test" />仿真测试</strong><span className="scene-test-state" data-state={status} role="status">● {testStatusLabels[status] ?? status}</span>
      <button type="button" className="scene-test-quiet" onClick={() => setTestDisplay('hidden')} aria-label="隐藏仿真测试">隐藏</button></header>
    <div className="scene-test-body"><div className="scene-test-content">
      <strong className="scene-test-name">{name || '未命名测试'}</strong>
      <div className="scene-test-binding"><span>{id ? `实例 ${id}` : '尚未选择实例'}{hasRun && active && snapshot.binding?.model ? ` · ${snapshot.binding.model}` : !mismatch && model ? ` · ${model}` : ''}</span><span>{active ? dryRun ? '离线预演' : '飞控测试' : '待执行'}</span></div>
      {mismatch && active && <div className="scene-test-notice">测试绑定实例 {id}，当前观察 {selected}。<button type="button" onClick={() => onSelectInstance(id)}>查看 {id}</button></div>}
      <div className="scene-test-current"><span>{active ? '当前动作' : hasRun ? '上次结果' : '待执行'}</span><strong>{starting ? '准备运行前检查' : stopping ? '等待飞控退出确认' : active ? actions[0]?.label ?? '等待执行反馈' : hasRun ? snapshot.exitResult || testStatusLabels[status] : '脚本已载入'}</strong></div>
      {actions.length > 1 && <div className="scene-test-parallel">并行 · {actions.slice(1).map(action => action.label).join('；')}</div>}
      {(attitude||heading) && <div className="scene-test-hold"><span>连续保持 <output>{held === undefined ? '—' : held.toFixed(1)}{hold !== undefined ? ` / ${hold}` : ''} s</output></span>
        {hold !== undefined && held !== undefined && <progress aria-label="当前姿态连续保持时间" value={held} max={Number(hold)} />}</div>}
      {expanded && <div className="scene-test-details">
        <div className="scene-test-detail-heading">正在执行{actions.length > 1 ? ' · 并行任务' : ''}</div>
        {actions.length ? <ul>{actions.map(action => <li key={action.id}>{action.label}</li>)}</ul> : <p>{active ? '等待执行反馈' : '当前没有执行中的动作'}</p>}
        {(attitude || heading || altitude) && <><div className="scene-test-detail-heading">目标与反馈</div><table><thead><tr><th>项目</th><th>目标</th><th>实测</th></tr></thead><tbody>
          {attitude && <><tr><th>横滚角</th><td>{reading('test/attitude/roll-target-deg')}°</td><td>{reading('test/fc/roll-deg')}°</td></tr><tr><th>俯仰角</th><td>{reading('test/attitude/pitch-target-deg')}°</td><td>{reading('test/fc/pitch-deg')}°</td></tr><tr><th>姿态误差</th><td>—</td><td>{reading('test/attitude/error-deg')}°</td></tr></>}
          {heading && <><tr><th>相对航向目标</th><td>{reading('test/heading/relative-target-deg')}°</td><td>—</td></tr><tr><th>绝对航向</th><td>{reading('test/heading/target-deg')}°</td><td>{reading('test/fc/yaw-deg')}°</td></tr><tr><th>航向误差</th><td>≤3°</td><td>{reading('test/heading/error-deg')}°</td></tr></>}
          {altitude && <tr><th>相对高度</th><td>{reading('test/altitude/target-m', 2)} m</td><td>{reading('test/fc/relative-alt-m', 2)} m</td></tr>}
        </tbody></table></>}
        <div className="scene-test-detail-heading">{dryRun ? '预演杆量' : '发送杆量'}</div><div className="scene-test-rc">{['横滚', '俯仰', '偏航', '油门'].map((axis, i) => <span key={axis}>{axis}<output>{snapshot?.rc[i] === undefined ? '—' : (snapshot.rc[i] * 100).toFixed(0)}%</output></span>)}</div>
        <div className="scene-test-detail-heading">最近事件</div><div className="scene-test-events" role="log">{snapshot?.logs.slice(-4).map((event, i) => <p key={i} className={event.level === 'error' ? 'error' : ''}><time>{testTime(event.time)}</time><span>{event.message}</span></p>) ?? <p>尚无执行事件</p>}</div>
        <button type="button" className="scene-test-quiet" onClick={() => openTestToolbox(true)}>在工具箱中查看与编辑</button>
      </div>}
      {(session.error || (session.statusError && hasRun)) && <p className="scene-test-error" role="alert">{session.error || `测试状态暂不可用：${session.statusError}`}</p>}
      </div><footer><span>已运行 <time>{testTime(starting ? 0 : snapshot?.elapsed)}</time></span><div>
        <button type="button" className="scene-test-quiet" aria-expanded={expanded} onClick={() => setTestDisplay(expanded ? 'compact' : 'details')}>{expanded ? '收起' : '详情'}<SceneIcon name="chevron" /></button>
        {active ? <StopTest disabled={starting || stopping} stopping={stopping} /> : <>
          {context ? <><button type="button" disabled={!!previewReason} title={previewReason} onClick={() => start(true)}>预演</button><button type="button" className="scene-test-run" disabled={!!reason} title={reason} onClick={() => start(false)}>执行</button></> : <button type="button" className="scene-test-run" onClick={() => openTestToolbox(true)}>打开工具箱</button>}
        </>}
      </div></footer>
      {!active && reason && <p className="scene-test-hint">{reason}</p>}
    </div>
  </section>;
}
export function SceneFlightTestStatus({ hidden, onRestore }: { hidden: boolean; onRestore: () => void }) {
  const session = useFlightTestSession();
  if (!hidden) return null;
  const active = sessionIsActive(session), { snapshot, starting, stopping } = session;
  const status = stopping ? 'exiting' : starting ? 'preflight' : snapshot?.status ?? 'idle';
  return <div className="scene-test-status" aria-label="隐藏的仿真测试状态">
    <button type="button" className="scene-test-status-open" onClick={onRestore}><span className="scene-test-state" data-state={status} role="status">● {snapshot?.dryRun && snapshot.id ? '预演' : '测试'}{testStatusLabels[status] ?? status}</span><time>{testTime(starting ? 0 : snapshot?.elapsed)}</time><SceneIcon name="chevron" /></button>
    {active && <StopTest disabled={starting || stopping} stopping={stopping} />}
    {(session.error || (session.statusError && active)) && <span className="scene-test-error" role="alert">{session.error || '测试状态读取失败，请检查连接'}</span>}
  </div>;
}
