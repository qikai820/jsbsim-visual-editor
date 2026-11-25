import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import type { Px4Connection } from '../px4/connection';
import { copy, defaultDocument, validateDocument, type TestDocument } from './model';
import { compileTest, documentFromXml } from './xml';

export const FLIGHT_TEST_STORAGE = 'px4-flight-test-workspace-v1';
const DISPLAY_STORAGE = 'jsbsim-scene-flight-test-display-v1';
export type TestDisplay = 'compact' | 'details' | 'hidden';
export type TestSnapshot = {
  id: number; status: string; name: string; dryRun: boolean; elapsed: number; realElapsed: number;
  binding?: { sessionId: number; system: number; component: number; instance: number; model: string; peer: string } | null;
  rc: number[]; activeBlocks: string[]; values: Record<string, number>;
  logs: Array<{ time: number; level: string; message: string }>; exitResult: string;
};
export type TestWorkspace = { document: TestDocument; source: string; raw: boolean; pendingDraft: boolean; error: string };
export type TestContext = {
  link: Px4Connection | null; instance: number; bidirectional: boolean; disabled: boolean;
  beforeRun: () => Promise<void>;
};
export type RcSourceStatus = { mode?:number|null; selected: 0|1|null; actual: 0|1|null; ready: boolean; supported: boolean;
  switching: boolean; idleSending: boolean; feedbackAgeMs: number|null; reason: string };
export const testStatusLabels: Record<string, string> = {
  idle: '就绪', preflight: '运行前检查', running: '执行中', exiting: '确认退出状态', passed: '完成', failed: '失败', stopped: '已停止',
};
export const testIsActive = (snapshot: TestSnapshot | null) => !!snapshot && ['preflight', 'running', 'exiting'].includes(snapshot.status);
export function savedTestText(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function loadTestDocument(): TestDocument {
  try { const value = JSON.parse(savedTestText(FLIGHT_TEST_STORAGE) || 'null'); validateDocument(value); return value; }
  catch { return defaultDocument(); }
}
function initialWorkspace(): TestWorkspace {
  const document = loadTestDocument(), raw = savedTestText(FLIGHT_TEST_STORAGE + ':raw');
  try { return { document, source: raw ?? compileTest(document), raw: raw !== null, pendingDraft: savedTestText(FLIGHT_TEST_STORAGE + ':draft') !== null, error: '' }; }
  catch (e) { return { document, source: '', raw: false, pendingDraft: false, error: String(e) }; }
}
function initialDisplay(): TestDisplay {
  const value = savedTestText(DISPLAY_STORAGE);
  return value === 'details' || value === 'hidden' ? value : 'compact';
}
export interface SessionState {
  snapshot: TestSnapshot | null; starting: boolean; stopping: boolean; error: string; statusError: string;
  workspace: TestWorkspace; context: TestContext | null; runDocument: TestDocument | null; runInstance: number | null;
  display: TestDisplay; toolboxVisible: boolean; toolboxVisited: boolean; toolboxTestingRequest: number; toolboxOpenRequest: number;
  runOrigin: 'ui' | 'mcp' | null;
  rcSource: RcSourceStatus|null; rcSourceSwitching: boolean; rcSourceError: string; rcSourceStatusError: string;
}
export const useFlightTestStore = create<SessionState>(() => ({
  snapshot: null, starting: false, stopping: false, error: '', statusError: '', workspace: initialWorkspace(),
  context: null, runDocument: null, runInstance: null, display: initialDisplay(),
  toolboxVisible: false, toolboxVisited: false, toolboxTestingRequest: 0, toolboxOpenRequest: 0,
  runOrigin: null,
  rcSource: null, rcSourceSwitching: false, rcSourceError: '', rcSourceStatusError: '',
}));
export const sessionIsActive = (state: SessionState) => state.starting || state.stopping || testIsActive(state.snapshot);
export function setTestDisplay(display: TestDisplay) {
  useFlightTestStore.setState({ display });
  try { localStorage.setItem(DISPLAY_STORAGE, display); } catch { /* Keep the current window usable. */ }
}
export function openTestToolbox(testing = false) {
  useFlightTestStore.setState(state => ({ toolboxVisible: true, toolboxVisited: true, toolboxOpenRequest: state.toolboxOpenRequest + 1,
    toolboxTestingRequest: state.toolboxTestingRequest + (testing ? 1 : 0) }));
}
export const hideTestToolbox = () => useFlightTestStore.setState({ toolboxVisible: false });

// The native toolbox is the sole connection owner. The main scene and MCP
// delegate commands to it; a mirrored context is only used for UI availability.
export type RemoteTestController = {
  start: (dryRun: boolean, source?: string) => Promise<TestSnapshot>;
  stop: () => Promise<void>;
};
let remoteController: RemoteTestController | null = null;
export function setRemoteTestController(controller: RemoteTestController | null) { remoteController = controller; }
async function remoteCommand<T>(kind: 'starting' | 'stopping', command: () => Promise<T>): Promise<T> {
  commandEpoch++;
  useFlightTestStore.setState({ [kind]: true, error: '' });
  try { return await command(); }
  catch (e) { useFlightTestStore.setState({ error: String(e) }); throw e; }
  finally { commandEpoch++; useFlightTestStore.setState({ [kind]: false }); }
}

// Both surfaces observe the same native runner. Visibility never owns the
// runner or transport, and removing a subscriber never sends a stop command.
let subscribers = 0, timer: ReturnType<typeof setInterval> | undefined, polling = false, commandEpoch = 0;
async function refreshStatus() {
  if (polling) return;
  polling = true;
  const epoch = commandEpoch;
  try {
    const snapshot = await invoke<TestSnapshot | null>('flight_test_status');
    if (epoch === commandEpoch && snapshot && typeof snapshot.id === 'number' && typeof snapshot.status === 'string') {
      useFlightTestStore.setState({ snapshot, statusError: '' });
    }
  } catch (e) {
    if (epoch === commandEpoch) useFlightTestStore.setState({ statusError: String(e) });
  } finally { polling = false; }
}
export function useFlightTestSession() {
  useEffect(() => {
    subscribers++;
    if (!timer) { void refreshStatus(); timer = setInterval(() => void refreshStatus(), 250); }
    return () => { if (--subscribers === 0) { clearInterval(timer); timer = undefined; } };
  }, []);
  return useFlightTestStore();
}
export function testStartReason(state = useFlightTestStore.getState(), dryRun = false): string {
  if (sessionIsActive(state)) return '已有仿真测试正在运行';
  if (state.rcSourceSwitching) return '遥控器来源切换中，请等待飞控确认';
  if (state.workspace.pendingDraft) return '请先在工具箱应用或放弃 XML 草稿';
  if (state.workspace.error || !state.workspace.source) return state.workspace.error || '请先载入测试脚本';
  if (state.context?.disabled) return '其他飞控操作进行中';
  if (!dryRun && (!state.context?.link?.alive || !state.context.link.hilEnabled || !state.context.bidirectional)) return '请先在工具箱连接双向 HIL 飞控';
  if (!dryRun) return rcSourceStartReason(state);
  return '';
}
export function rcSourceStartReason(state = useFlightTestStore.getState()): string {
  if (state.rcSourceSwitching) return '遥控器来源切换中，请等待飞控确认';
  if (!state.rcSource?.supported) return state.rcSource?.reason || '等待 COM_RC_IN_MODE 回读';
  if (state.rcSource.selected !== 1) return '请先切换至工具箱模拟遥控器';
  if (!state.rcSource.ready) return state.rcSource.reason;
  return '';
}
export function rcSourceOptions(context: TestContext) {
  return {dryRun:false,rcEmulation:false,sessionId:context.link?.transport.sessionId??null,
    system:context.link?.target.system??0,component:context.link?.target.component??1,instance:context.instance,
    rateHz:50,clock:'realtime',onFinish:'release',onAbort:'release'};
}
export async function selectRcSource() {
  const state=useFlightTestStore.getState(),context=state.context;
  if(state.rcSourceSwitching||sessionIsActive(state))throw Error('测试或来源切换进行中');
  if(!context?.link?.alive||!context.link.hilEnabled||context.link.armed!==false||!context.bidirectional||context.disabled)throw Error('需要双向 HIL 连接且飞控已上锁');
  if(!state.rcSource?.supported)throw Error('等待 COM_RC_IN_MODE 回读');
  const source=state.rcSource.selected!==1||(!state.rcSource.ready&&!state.rcSource.idleSending)?1:0;
  useFlightTestStore.setState({rcSourceSwitching:true,rcSourceError:'',rcSourceStatusError:'',runInstance:context.instance});
  try{
    await context.beforeRun();
    await context.link.ready;
    const current=useFlightTestStore.getState().context;
    if(current?.link!==context.link||current.instance!==context.instance||current.disabled)throw Error('飞控连接或实例发生变化，未切换来源');
    const rcSource=await invoke<RcSourceStatus>('flight_test_rc_source_select',{options:rcSourceOptions(context),source});
    if(useFlightTestStore.getState().context?.link===context.link)useFlightTestStore.setState({rcSource,rcSourceError:''});
  }catch(e){useFlightTestStore.setState({rcSourceError:String(e),rcSource:null});throw e;}
  finally{useFlightTestStore.setState({rcSourceSwitching:false});}
}
export async function startFlightTest(dryRun: boolean) {
  const state = useFlightTestStore.getState(), reason = testStartReason(state, dryRun);
  if (reason) throw Error(reason);
  if (remoteController) return remoteCommand('starting', () => remoteController!.start(dryRun));
  const workspace = state.workspace;
  return startSource(workspace.source, dryRun, copy(workspace.document), 'ui', workspace.raw ? null : copy(workspace.document));
}
// MCP enters through the same UI reservation and beforeRun handover as a click.
// The editor's workspace/draft is never overwritten by an external script.
export async function startMcpFlightTest(source: string, dryRun: boolean) {
  const state = useFlightTestStore.getState();
  if (sessionIsActive(state)) throw Error('已有仿真测试正在运行');
  if (state.rcSourceSwitching) throw Error('遥控器来源切换中，请等待飞控确认');
  if (state.context?.disabled) throw Error('其他飞控操作进行中');
  if (!dryRun && (!state.context?.link?.alive || !state.context.link.hilEnabled || !state.context.bidirectional)) throw Error('请先在工具箱连接双向 HIL 飞控');
  if (!dryRun) { const reason=rcSourceStartReason(state);if(reason)throw Error(reason); }
  if (!source) throw Error('测试脚本为空');
  if (remoteController) return remoteCommand('starting', () => remoteController!.start(dryRun, source));
  const metadata=documentFromXml(source);
  return startSource(source, dryRun, metadata, 'mcp',metadata);
}
async function startSource(source: string, dryRun: boolean, document: TestDocument | null, origin: 'ui' | 'mcp', runDocument = document) {
  const context = useFlightTestStore.getState().context;
  if (!context) throw Error('请先打开 PX4 工具箱选择测试实例');
  commandEpoch++;
  useFlightTestStore.setState({ starting: true, error: '', runInstance: context.instance,
    runDocument, runOrigin: origin });
  try {
    await context.beforeRun();
    const current = useFlightTestStore.getState().context;
    if (current?.link !== context.link || current?.instance !== context.instance || current?.disabled) throw Error('飞控连接或实例在启动前发生变化，请重新查询');
    const snapshot = await invoke<TestSnapshot>('flight_test_start', { source, options: {
      dryRun, rcEmulation: false, sessionId: context.link?.transport.sessionId ?? null, system: context.link?.target.system ?? 0,
      component: context.link?.target.component ?? 1, instance: context.instance, rateHz: document?.rateHz ?? 50,
      clock: document?.clock ?? 'realtime', onFinish: document?.onFinish ?? 'land', onAbort: document?.onAbort ?? 'land',
    } });
    commandEpoch++;
    useFlightTestStore.setState({ snapshot, statusError: '' });
    return snapshot;
  } catch (e) {
    commandEpoch++;
    useFlightTestStore.setState({ error: String(e) });
    throw e;
  } finally { useFlightTestStore.setState({ starting: false }); }
}
export async function stopFlightTest() {
  const state = useFlightTestStore.getState();
  if (state.stopping || state.starting || !testIsActive(state.snapshot)) return;
  if (remoteController) {
    try { await remoteCommand('stopping', () => remoteController!.stop()); } catch { /* Keep the existing visible error and retry action. */ }
    return;
  }
  commandEpoch++;
  useFlightTestStore.setState({ stopping: true, error: '' });
  try {
    const snapshot = await invoke<TestSnapshot>('flight_test_stop', { id: state.snapshot?.id ?? null });
    commandEpoch++;
    useFlightTestStore.setState({ snapshot, statusError: '' });
  } catch (e) {
    commandEpoch++;
    useFlightTestStore.setState({ error: String(e) });
  } finally { useFlightTestStore.setState({ stopping: false }); }
}
