import { invoke } from '@tauri-apps/api/core';
import { ftpDownloadScript, getSimulatorNetworkTarget, getSimulatorTransportMode, simGetStatus, simInstanceSnapshot, simListModels, simListTests, simPause, simRestart, simResume, simStart, simStop } from '../utils/tauriApi';
import { sessionIsActive, startFlightTest, stopFlightTest, useFlightTestStore } from '../flight-test/session';
import type { LocalVoiceReadAction, VoiceAction, VoiceBinding, VoiceContext } from './model';
import {controllerIdentity} from './model';
export type VoiceHost = {
  binding: () => VoiceBinding;
  selectModel: (model:string) => Promise<void>;
  syncModel: (model:string) => Promise<unknown>;
  openToolbox: () => void; showScene: () => void; showLogs: () => void;
};
export type Catalog = {models:string[];scripts:string[];errors:string[]};
function names(items:any[],key:'model'|'script'):string[]{
  return [...new Set(items.map(item=>key==='model'?item.name:(item.file||item.path?.split('/').pop())).filter((s):s is string=>typeof s==='string'&&s.length<=128))].sort().slice(0,256);
}
export async function readVoiceCatalog():Promise<Catalog>{
  const [models,scripts]=await Promise.allSettled([simListModels(),simListTests()]);
  return {models:models.status==='fulfilled'?names(models.value,'model'):[],scripts:scripts.status==='fulfilled'?names(scripts.value,'script'):[],errors:[models.status==='rejected'?`模型目录：${String(models.reason)}`:'',scripts.status==='rejected'?`脚本目录：${String(scripts.reason)}`:''].filter(Boolean)};
}
export async function readVoiceContext(host:VoiceHost,catalog:Catalog):Promise<VoiceContext>{
  const status=await simGetStatus(),test=useFlightTestStore.getState();
  const simulatorTarget=status.external&&status.connected?await currentTarget():null;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(test.workspace.source));
  const sourceHash=Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
  let px4Config:unknown=null;try{px4Config=JSON.parse(localStorage.getItem('px4-sitl-config-v1')||'null');}catch{/* Show the normal saved-config error on execution. */}
  return {binding:host.binding(),simulatorTarget,simulation:{external:status.external,local:status.local,connected:status.connected,running:status.running,paused:status.paused,state:status.state,model:status.model,script:status.script,fdmRunMs:status.fdmRunMs,flightController:status.flightController?{...status.flightController}:null},px4Config,models:catalog.models,scripts:catalog.scripts,catalogErrors:catalog.errors,capturedAtMs:Date.now(),test:{id:test.snapshot?.id??null,status:test.snapshot?.status??'idle',name:test.workspace.document.name,sourceHash,pendingDraft:test.workspace.pendingDraft,sourceError:test.workspace.error,sessionId:test.context?.link?.transport.sessionId??null}};
}
const currentTarget=()=>getSimulatorTransportMode()==='usb'?Promise.resolve('usb'):getSimulatorNetworkTarget();
export async function collectVoiceContext(host:VoiceHost):Promise<VoiceContext>{
  // A disconnected status query must not wait on FTP discovery and retries.
  const context=await readVoiceContext(host,{models:[],scripts:[],errors:[]});
  if(context.simulation.external===true&&context.simulation.connected!==true){
    context.catalogErrors=['仿真链路未连接，未读取模型和脚本目录'];return context;
  }
  const catalog=await readVoiceCatalog();
  return {...context,models:catalog.models,scripts:catalog.scripts,catalogErrors:catalog.errors};
}

const simulationStateLabel: Record<string, string> = {
  running: '运行中', paused: '已暂停', stopped: '已停止', idle: '空闲', loading: '正在加载', starting: '正在启动',
  stopping: '正在停止', crashed: '进程异常', disconnected: '未连接', error: '异常',
};

export async function executeVoiceReadAction(action: LocalVoiceReadAction, host: VoiceHost,
  checkpoint: () => void, context?: VoiceContext): Promise<string> {
  checkpoint();
  switch (action) {
    case 'status': {
      const instance = host.binding().instance;
      if (instance !== '01') {
        const snapshot = await simInstanceSnapshot(instance);
        checkpoint();
        if (instance !== host.binding().instance) throw Error('当前实例已变化，请重新查询');
        if (!snapshot || snapshot.age_ms == null || snapshot.age_ms > 3000) return `实例 ${instance} 暂无有效仿真状态。`;
        return `实例 ${instance}：${simulationStateLabel[snapshot.state || ''] || '状态未知'}，运行模型 ${snapshot.model || '未选择'}。`;
      }
      const status = await simGetStatus();
      checkpoint();
      if (instance !== host.binding().instance) throw Error('当前实例已变化，请重新查询');
      if (status.external && !status.connected) return '外部仿真未连接，无法读取当前运行状态。';
      const state = status.state || (status.running ? status.paused ? 'paused' : 'running' : 'stopped');
      return `${status.local || status.external === false ? '本机' : '外部'}仿真：${simulationStateLabel[state] || '状态未知'}，运行模型 ${status.model || '未选择'}。`;
    }
    case 'list_models':
    case 'list_scripts': {
      const models = action === 'list_models';
      const kind = models ? '模型' : '脚本';
      let entries = context && (models ? context.models : context.scripts);
      if (!entries) {
        const status = await simGetStatus();
        checkpoint();
        if (status.external && !status.connected) return `仿真链路未连接，无法读取${kind}目录。`;
        entries = models ? names(await simListModels(), 'model') : names(await simListTests(), 'script');
        checkpoint();
      }
      return entries.length ? `可用${kind}：${entries.join('、')}` : `${kind}目录不可用：${context?.catalogErrors.join('；') || '目录为空'}`;
    }
    case 'open_toolbox': host.openToolbox(); return 'PX4 工具箱已打开';
    case 'show_scene': host.showScene(); return '三维视景已打开';
    case 'show_logs': host.showLogs(); return '日志中心已打开';
  }
}

function noActiveTest(){if(sessionIsActive(useFlightTestStore.getState()))throw Error('当前仿真测试正在运行或退出，请先结束测试');}
export async function executeVoiceAction(action:VoiceAction,context:VoiceContext,host:VoiceHost,continueOperation=()=>true):Promise<string>{
  const checkpoint=()=>{if(!continueOperation())throw Error('已取消后续操作');};checkpoint();
  const guardTarget=async()=>{
    checkpoint();
    if(host.binding().instance!==context.binding.instance)throw Error('当前实例已变化，操作未提交');
    if(context.simulation.external===true){
      const target=await currentTarget();checkpoint();
      if(target!==context.simulatorTarget)throw Error('仿真机地址已变化，操作未提交');
    }
    const expectedController=controllerIdentity(context.simulation);
    if(expectedController){
      const latest=await simGetStatus();checkpoint();
      if(controllerIdentity({flightController:latest.flightController})!==expectedController)throw Error('飞控标识已变化，操作未提交');
    }
    noActiveTest();
  };
  switch(action.type){
    case 'status':case 'list_models':case 'list_scripts':case 'open_toolbox':case 'show_scene':case 'show_logs':
      return executeVoiceReadAction(action.type, host, checkpoint, context);
    case 'select_model':await guardTarget();await host.selectModel(action.model);return `已在编辑器载入 ${action.model}`;
    case 'start_model':case 'start_script':{
      await guardTarget();const current=await simGetStatus();checkpoint();if(current.running)throw Error('已有模型运行，请先停止当前仿真');
      if(action.type==='start_script'){
        const {xml}=await ftpDownloadScript(action.script);checkpoint();const doc=new DOMParser().parseFromString(xml,'application/xml');
        if(doc.querySelector('parsererror')||doc.querySelector('use')?.getAttribute('aircraft')!==action.model)throw Error('脚本关联机型与预览不一致，未启动');
      }
      await host.syncModel(action.model);checkpoint();
      await guardTarget();const latest=await simGetStatus();checkpoint();if(latest.running)throw Error('准备期间另一个模型已启动，操作未提交');
      const result=await simStart({model:action.model,...(action.type==='start_script'?{script:action.script}:{})});
      if(!result?.running)throw Error('仿真未确认启动');return `仿真已启动：${action.model}${action.type==='start_script'?' / '+action.script:''}`;
    }
    case 'pause':{await guardTarget();const result=await simPause();if(!result?.paused)throw Error('仿真未确认暂停');return '仿真已暂停';}
    case 'resume':{await guardTarget();const result=await simResume();if(!result?.running||result?.paused)throw Error('仿真未确认继续');return '仿真已继续';}
    case 'stop':{await guardTarget();const result=await simStop();if(result?.running!==false)throw Error('仿真未确认停止');return '仿真已停止';}
    case 'restart':{
      await guardTarget();const state=await simGetStatus();checkpoint();if(!state.model)throw Error('没有可重载的运行模型');await host.syncModel(state.model);await guardTarget();const result=await simRestart();if(!result?.running)throw Error('仿真未确认重新加载');return `仿真已重新加载：${state.model}`;
    }
    case 'start_px4':{
      noActiveTest();const raw=localStorage.getItem('px4-sitl-config-v1');if(!raw)throw Error('请先在软件飞控页保存并检查启动配置');
      const config=JSON.parse(raw);await invoke('px4_sitl_preview',{config});checkpoint();noActiveTest();if(raw!==localStorage.getItem('px4-sitl-config-v1'))throw Error('软件飞控配置已变化，未启动');const result=await invoke<{running:boolean}>('px4_sitl_start',{config});
      if(!result.running)throw Error('软件飞控进程未运行');return '软件飞控进程已启动，HIL 就绪状态仍需查看心跳';
    }
    case 'stop_px4':noActiveTest();await invoke('px4_sitl_stop');return '上位机管理的软件飞控已停止';
    case 'start_test':{
      const state=useFlightTestStore.getState();if(state.workspace.pendingDraft||state.workspace.error)throw Error('请先应用或修正当前测试脚本');
      const snapshot=await startFlightTest(action.dryRun);
      return `${action.dryRun?'干跑':'HIL 测试'}已请求启动：${snapshot.name}（${snapshot.id}）`;
    }
    case 'stop_test':{
      const state=useFlightTestStore.getState();if(state.snapshot?.id!==context.test.id)throw Error('测试标识已变化，请重新解析');
      if(!sessionIsActive(state))return '当前没有运行中的测试';await stopFlightTest();const result=useFlightTestStore.getState();if(result.error)throw Error(result.error);return result.snapshot?.exitResult||'测试已结束';
    }
  }
}
