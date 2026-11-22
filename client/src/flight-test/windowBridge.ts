import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Px4Connection } from '../px4/connection';
import { useSignalMonitorStore } from '../store/signalMonitorStore';
import { hideTestToolbox, setRemoteTestController, startFlightTest, startMcpFlightTest, stopFlightTest, useFlightTestStore, type SessionState, type TestSnapshot } from './session';

export const TOOLBOX_WINDOW = 'px4-toolbox';
const EVENT = 'px4-toolbox-bridge';
type ContextSummary = { instance: number; disabled: boolean; bidirectional: boolean; link: { alive: boolean; hilEnabled: boolean | undefined; target: { system: number; component: number }; transport: { sessionId: number | null } } | null };
export type SessionMirror = Pick<SessionState, 'snapshot'|'starting'|'stopping'|'error'|'statusError'|'runInstance'|'runOrigin'|'rcSource'|'rcSourceSwitching'|'rcSourceError'|'rcSourceStatusError'> & Partial<Pick<SessionState,'workspace'|'runDocument'>> & { context: ContextSummary | null };
type WindowView = { visible: boolean; instance: string; display: SessionState['display']; testingRequest: number };
type Message = { kind: 'ready'|'hidden'|'scene' } | { kind: 'view'; view: WindowView } | { kind: 'state'; state: SessionMirror } |
  { kind: 'command'; id: string; deadline: number; action: 'start'|'stop'; dryRun?: boolean; source?: string } |
  { kind: 'result'; id: string; state: SessionMirror; result?: TestSnapshot; error?: string };

export function sessionMirror(): SessionMirror {
  const s = useFlightTestStore.getState(), c = s.context;
  return { snapshot:s.snapshot, starting:s.starting, stopping:s.stopping, error:s.error, statusError:s.statusError,
    rcSource:s.rcSource,rcSourceSwitching:s.rcSourceSwitching,rcSourceError:s.rcSourceError,rcSourceStatusError:s.rcSourceStatusError,
    workspace:s.workspace, runDocument:s.runDocument, runInstance:s.runInstance, runOrigin:s.runOrigin,
    context:c ? { instance:c.instance, disabled:c.disabled, bidirectional:c.bidirectional,
      link:c.link ? { alive:c.link.alive, hilEnabled:c.link.hilEnabled, target:c.link.target, transport:{sessionId:c.link.transport.sessionId} } : null } : null };
}
function applyMirror(s: SessionMirror) {
  // This context never sends packets. Commands always execute in the owner webview.
  useFlightTestStore.setState({ ...s, context:s.context ? { ...s.context, link:s.context.link as Px4Connection | null, beforeRun:async()=>{} } : null });
}
const send = (label: string, message: Message) => emitTo(label, EVENT, message);
export function sendToolboxView() {
  const s = useFlightTestStore.getState();
  return send(TOOLBOX_WINDOW, { kind:'view', view:{visible:s.toolboxVisible, instance:useSignalMonitorStore.getState().instance, display:s.display, testingRequest:s.toolboxTestingRequest} });
}

export async function installToolboxHost(onReady: () => void, onScene: () => void) {
  let disposed = false;
  const pending = new Map<string, { resolve:(value:TestSnapshot|undefined)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> }>();
  const command = (action:'start'|'stop', dryRun?:boolean, source?:string) => new Promise<TestSnapshot|undefined>((resolve,reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(Error('工具箱未及时完成操作，请先查询当前状态')); }, 150000);
    pending.set(id,{resolve,reject,timer});
    // No retries. A queued start expires before it can execute in a suspended window.
    void send(TOOLBOX_WINDOW,{kind:'command',id,deadline:Date.now()+5000,action,dryRun,source}).catch(error=>{
      const item=pending.get(id);if(item){pending.delete(id);clearTimeout(timer);reject(error);}
    });
  });
  const unlisten = await listen<Message>(EVENT, ({payload:m}) => {
    if(disposed)return;
    if(m.kind==='ready'||m.kind==='state') {
      setRemoteTestController({start:async(dryRun,source)=>{const result=await command('start',dryRun,source);if(!result)throw Error('工具箱未返回测试状态');return result;},stop:async()=>{await command('stop');}});
      if(m.kind==='ready'){onReady();void sendToolboxView();}
    }
    if(m.kind==='state')applyMirror(m.state);
    if(m.kind==='hidden')hideTestToolbox();
    if(m.kind==='scene')onScene();
    if(m.kind==='result'){
      const item=pending.get(m.id);if(!item)return;
      pending.delete(m.id);clearTimeout(item.timer);applyMirror(m.state);
      if(m.error)item.reject(Error(m.error));else item.resolve(m.result);
    }
  });
  const sync=()=>{void sendToolboxView().catch(()=>{});};
  const stopSession=useFlightTestStore.subscribe((s,p)=>{if(s.toolboxVisible!==p.toolboxVisible||s.toolboxTestingRequest!==p.toolboxTestingRequest||s.display!==p.display)sync();});
  const stopInstance=useSignalMonitorStore.subscribe((s,p)=>{if(s.instance!==p.instance)sync();});
  return()=>{disposed=true;unlisten();stopSession();stopInstance();setRemoteTestController(null);for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('工具箱会话已关闭'));}pending.clear();};
}

export async function installToolboxOwner(onView:(view:WindowView)=>void) {
  let disposed=false;
  const seen=new Set<string>();
  const unlisten=await listen<Message>(EVENT,async({payload:m})=>{
    if(disposed)return;
    if(m.kind==='view'){
      useSignalMonitorStore.setState({instance:m.view.instance});
      useFlightTestStore.setState({display:m.view.display,toolboxTestingRequest:m.view.testingRequest});
      onView(m.view);
      void send('main',{kind:'state',state:sessionMirror()});
    }
    if(m.kind==='command'){
      if(seen.has(m.id))return;
      seen.add(m.id);if(seen.size>256)seen.delete(seen.values().next().value!);
      let result:TestSnapshot|undefined,error:string|undefined;
      try{
        if(Date.now()>m.deadline)throw Error('操作请求已过期，未执行，请先查询当前状态');
        if(m.action==='start'){
          if(typeof m.dryRun!=='boolean')throw Error('测试请求无效');
          result=m.source===undefined?await startFlightTest(m.dryRun):await startMcpFlightTest(m.source,m.dryRun);
        }else{
          await stopFlightTest();const state=useFlightTestStore.getState();if(state.error)throw Error(state.error);
        }
      }catch(e){error=String(e);}
      await send('main',{kind:'result',id:m.id,state:sessionMirror(),result,error}).catch(()=>{});
    }
  });
  let scheduled=false,lastWorkspace:SessionState['workspace']|undefined,lastRunDocument:SessionState['runDocument']|undefined;
  const publish=()=>{if(scheduled||disposed)return;scheduled=true;queueMicrotask(()=>{
    scheduled=false;if(disposed)return;
    const state=sessionMirror();
    // Complete MorphQuad XML can exceed 3 MiB. Send it on edits, never on every
    // 250 ms telemetry tick. The scene retains the last received workspace.
    if(state.workspace===lastWorkspace)delete state.workspace;else lastWorkspace=state.workspace;
    if(state.runDocument===lastRunDocument)delete state.runDocument;else lastRunDocument=state.runDocument;
    void send('main',{kind:'state',state}).catch(()=>{});
  });};
  const unsubscribe=useFlightTestStore.subscribe(publish);
  await send('main',{kind:'ready'});
  publish();
  return()=>{disposed=true;unlisten();unsubscribe();};
}
export const notifyToolboxHidden=()=>send('main',{kind:'hidden'});
export const notifyToolboxScene=()=>send('main',{kind:'scene'});
