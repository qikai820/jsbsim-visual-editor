import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getLocalSimulator, type LocalSimulatorStatus } from '../utils/tauriApi';
import './Px4Sitl.css';

type Config = { directory:string; airframe:number; instance:number; mode:string; host:string; localPort:number; remotePort:number; speed:number; latitude:number; longitude:number; altitude:number };
type Build = { directory:string; executable:string; ready:boolean; issues:string[]; airframes:{id:number; model:string; name:string}[] };
type Plan = { executable:string; args:string[]; environment:Record<string,string>; workDirectory:string; notes:string[] };
type Snapshot = { running:boolean; pid:number|null; exitCode:number|null; config:Config|null; plan:Plan|null; external?:boolean; logs:{sequence:number;stream:string;text:string}[] };
const defaults:Config = {directory:'/home/qikai820/src/PX4-Autopilot/build/px4_sitl_default',airframe:10016,instance:0,mode:'hil-udp',host:'',localPort:14560,remotePort:14560,speed:1,latitude:34.157,longitude:108.953,altitude:400};
function initial():Config {
  try { const saved=JSON.parse(localStorage.getItem('px4-sitl-config-v1')||'{}'); return Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,typeof saved?.[key]===typeof value?saved[key]:value])) as Config; } catch { return defaults; }
}
const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
export default function Px4Sitl({disabled=false}:{disabled?:boolean}) {
  const [config,setConfig]=useState(initial), [build,setBuild]=useState<Build>(), [plan,setPlan]=useState<Plan>(), [snapshot,setSnapshot]=useState<Snapshot>();
  const [localSimulator,setLocalSimulator]=useState<LocalSimulatorStatus>();
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[previewError,setPreviewError]=useState(''),[statusError,setStatusError]=useState(''),[following,setFollowing]=useState(true);
  const log=useRef<HTMLPreElement>(null), mounted=useRef(true), request=useRef(0), configRef=useRef(config); configRef.current=config;
  const running=!!snapshot?.running, locked=running||!!busy||disabled;
  const update=(patch:Partial<Config>)=>setConfig(c=>({...c,...patch}));
  const receiveStatus=(value:Snapshot)=>{
    setSnapshot(value);setStatusError('');
    if(value.running){
      setError('');
      if(value.config)setConfig(current=>JSON.stringify(current)===JSON.stringify(value.config)?current:value.config!);
    }
  };
  useEffect(()=>{try{localStorage.setItem('px4-sitl-config-v1',JSON.stringify(config));}catch{/* Keep the working form usable if preferences are full. */}},[config]);
  useEffect(()=>{
    mounted.current=true; let polling=false;
    const poll=async()=>{if(polling)return;polling=true;const epoch=request.current;try{
      const [px4,local]=await Promise.allSettled([invoke<Snapshot>('px4_sitl_status',{config:configRef.current}),getLocalSimulator()]);
      if(!mounted.current||epoch!==request.current)return;
      if(px4.status==='fulfilled'&&px4.value)receiveStatus(px4.value);
      else if(px4.status==='rejected')setStatusError(String(px4.reason));
      if(local.status==='fulfilled'&&local.value)setLocalSimulator(local.value);
    }finally{polling=false;}};
    void poll();const timer=setInterval(()=>void poll(),1000);
    return()=>{mounted.current=false;clearInterval(timer);};
  },[]);
  useEffect(()=>{if(following&&log.current)log.current.scrollTop=log.current.scrollHeight;},[snapshot?.logs[snapshot.logs.length-1]?.sequence,following]);
  useEffect(()=>{
    let disposed=false;setBuild(undefined);setError('');
    const timer=setTimeout(()=>{void invoke<Build>('px4_sitl_inspect',{directory:config.directory}).then(value=>{if(!disposed&&value)setBuild(value);}).catch(e=>{if(!disposed)setError(String(e));});},300);
    return()=>{disposed=true;clearTimeout(timer);};
  },[config.directory]);
  useEffect(()=>{
    let disposed=false;setPlan(undefined);setPreviewError('');
    if(!build?.ready)return;
    const timer=setTimeout(()=>{void invoke<Plan>('px4_sitl_preview',{config}).then(value=>{if(!disposed)setPlan(value);}).catch(e=>{if(!disposed)setPreviewError(String(e));});},250);
    return()=>{disposed=true;clearTimeout(timer);};
  },[config,build]);
  const act=async(kind:string,fn:()=>Promise<void>)=>{if(busy)return;setBusy(kind);setError('');request.current++;try{await fn();}catch(e){if(mounted.current)setError(String(e));}finally{if(mounted.current)setBusy('');}};
  const inspect=()=>act('inspect',async()=>{const value=await invoke<Build>('px4_sitl_inspect',{directory:config.directory});if(mounted.current){setBuild(value);update({directory:value.directory});}});
  const pick=()=>act('pick',async()=>{const value=await invoke<Build|null>('px4_sitl_pick',{initialDirectory:config.directory});if(mounted.current&&value){setBuild(value);update({directory:value.directory});}});
  const start=()=>act('start',async()=>{const value=await invoke<Snapshot>('px4_sitl_start',{config});if(mounted.current)receiveStatus(value);});
  const stop=()=>act('stop',async()=>{const value=await invoke<Snapshot>('px4_sitl_stop');if(mounted.current)receiveStatus(value);});
  // Resolve the active backend first so board discovery cannot override local HIL.
  useEffect(()=>{
    let disposed=false;
    void (async()=>{
      const local=await getLocalSimulator().catch(()=>undefined);
      if(disposed)return;
      if(local)setLocalSimulator(local);
      if(configRef.current.mode!=='hil-udp'||configRef.current.host)return;
      if(local?.active){
        const active=local.activeConfig;
        if(active?.hilHost==='127.0.0.1')update({host:'127.0.0.1',localPort:active.hilPort,remotePort:14560,speed:1});
        return;
      }
      const host=await invoke<string|null>('simulator_network_target_get').catch(()=>null);
      if(!disposed&&configRef.current.mode==='hil-udp'&&!configRef.current.host)update(host?{host}:{host:'127.0.0.1',localPort:14561,remotePort:14560});
    })();
    return()=>{disposed=true;};
  },[config.mode]);
  const localConfig=localSimulator?.activeConfig;
  const activePlan=running?snapshot?.plan:plan;
  return <div className="px4-sitl">
    <header><div><h2>软件飞控</h2><p>选择已编译的 PX4 SITL 目录，在本机启动飞控。</p></div><span className={'sitl-badge'+(running?' running':'')}>{running?'● 运行中 · PID '+snapshot?.pid:snapshot?.config?'已停止'+(snapshot.exitCode!==null?' · 退出码 '+snapshot.exitCode:''):'未启动'}</span></header>
    {statusError&&<div role="alert" className="px4-notice error">无法获取软件飞控状态：{statusError}</div>}
    {error&&<div role="alert" className="px4-notice error">{error}</div>}
    {running&&snapshot?.external&&<div className="px4-notice">检测到已有软件飞控（PID {snapshot.pid}），已同步运行状态，可使用下方按钮停止。该进程的历史日志不可读取，退出上位机时保留运行。</div>}
    {localSimulator?.active&&<div className="px4-notice">电脑端模型服务{localSimulator.ready?'已就绪':'尚未就绪'}。同机运行时，PX4 和模型使用不同的 HIL 端口。<button disabled={locked||localConfig?.hilHost!=='127.0.0.1'} onClick={()=>update({mode:'hil-udp',host:'127.0.0.1',localPort:localConfig!.hilPort,remotePort:14560,speed:1})}>使用本机模型连接</button>{localConfig?.hilHost!=='127.0.0.1'&&<span>当前模型 HIL 目标为外部飞控，请在本地配置中修改后重启。</span>}</div>}
    <div className="sitl-columns"><div className="sitl-settings">
      <section><h3>PX4 构建目录</h3><div className="sitl-directory"><input aria-label="PX4 构建目录" disabled={locked} value={config.directory} onChange={e=>update({directory:e.target.value})}/><button disabled={locked} onClick={()=>void pick()}>选择文件夹</button><button disabled={locked} onClick={()=>void inspect()}>重新检测</button></div>
        {build&&<div className="sitl-build-status" role="status">{build.ready?'✓ 构建目录可用':'构建目录尚不能启动'} · {build.airframes.length} 个机型{build.issues.map(issue=><p key={issue}>{issue}</p>)}</div>}
      </section>
      <fieldset disabled={locked}><legend>机型与连接</legend>
        <label>启动模式<select aria-label="软件飞控启动模式" value={config.mode} onChange={e=>{const mode=e.target.value;update({mode,airframe:mode==='sih'?10040:10016,speed:1,host:mode==='hil-udp'?'':mode==='sitl-tcp'?'127.0.0.1':''});}}><option value="hil-udp">JSBSim（本机 / 仿真机）· UDP HIL</option><option value="sitl-tcp">外部仿真器 · SITL TCP</option><option value="sih">PX4 内置动力学 · SIH</option></select></label>
        <label>飞控机型<select aria-label="软件飞控机型" value={config.airframe} onChange={e=>update({airframe:Number(e.target.value)})}>{!build?.airframes.some(f=>f.id===config.airframe)&&<option value={config.airframe}>机型 {config.airframe}（待检测）</option>}{build?.airframes.map(f=><option key={f.id+'-'+f.model} value={f.id}>{f.id} · {f.name} ({f.model})</option>)}</select></label>
        <div className="sitl-fields"><label>实例编号<input aria-label="PX4 实例编号" type="number" min="0" max="9" value={config.instance} onChange={e=>update({instance:e.target.valueAsNumber})}/></label><label>仿真倍率<input aria-label="PX4 仿真倍率" disabled={config.mode==='hil-udp'} type="number" min="0.1" max="10" step="0.1" value={config.speed} onChange={e=>update({speed:e.target.valueAsNumber})}/></label></div>
        {config.mode!=='sih'&&<label>{config.mode==='hil-udp'?'模型所在 IPv4（留空使用本机）':'外部仿真器 IPv4（留空使用本机）'}<input aria-label="PX4 仿真机地址" value={config.host} placeholder="127.0.0.1（本机）或仿真机 IPv4" onChange={e=>update({host:e.target.value.trim()})}/></label>}
        {config.mode==='hil-udp'&&<><div className="sitl-fields"><label>PX4 HIL 监听端口<input aria-label="PX4 HIL 本地端口" type="number" min="1" max="65535" value={config.localPort} onChange={e=>update({localPort:e.target.valueAsNumber})}/></label><label>模型 HIL 接收端口<input aria-label="PX4 HIL 远端端口" type="number" min="1" max="65535" value={config.remotePort} onChange={e=>update({remotePort:e.target.valueAsNumber})}/></label></div><p className="px4-muted">模型可运行在本电脑或外部仿真机。同机建议 PX4 监听 14561、模型接收 14560；模型的飞控 HIL 目标设为 127.0.0.1:14561。</p></>}
        <p className="px4-muted">飞控机型决定控制器与电机布局；JSBSim 模型需在仿真菜单中单独选择，例如 F450_PX4。</p>
      </fieldset>
      <details><summary>起始位置</summary><fieldset disabled={locked}><div className="sitl-fields"><label>纬度 °<input aria-label="PX4 起始纬度" type="number" step="0.000001" value={config.latitude} onChange={e=>update({latitude:e.target.valueAsNumber})}/></label><label>经度 °<input aria-label="PX4 起始经度" type="number" step="0.000001" value={config.longitude} onChange={e=>update({longitude:e.target.valueAsNumber})}/></label><label>海拔 m<input aria-label="PX4 起始海拔" type="number" value={config.altitude} onChange={e=>update({altitude:e.target.valueAsNumber})}/></label></div><p className="px4-muted">传给 PX4_HOME_*；使用外部模型时，实际位置由其传感器输入决定。</p></fieldset></details>
      {previewError&&<div className="px4-notice error" role="alert">{previewError}</div>}
      <div className="sitl-actions"><button className={running?'':'px4-primary'} disabled={!snapshot||!!busy||disabled||(!running&&(!plan||!!statusError))} aria-busy={!snapshot||busy==='start'||busy==='stop'} onClick={()=>void (running?stop():start())}>{busy==='start'?'正在启动…':busy==='stop'?'正在停止…':!snapshot?'正在检测…':running?'停止软件飞控':'启动软件飞控'}</button></div>
      {running&&snapshot?.config&&<p className="px4-muted">当前运行：机型 {snapshot.config.airframe} · 实例 {snapshot.config.instance} · {snapshot.config.mode}。停止后可修改配置。</p>}
      <p className="px4-muted">关闭工具箱后继续运行；退出上位机时停止由本次上位机启动的软件飞控。</p>
    </div><div className="sitl-output">
      <section className="sitl-plan"><h3>启动预览</h3>{activePlan?<><pre>{Object.entries(activePlan.environment).map(([key,value])=>key+'='+quote(value)).join(' \\\n')}<br/>{[activePlan.executable,...activePlan.args].map(quote).join(' ')}</pre><p className="px4-muted">工作目录：{activePlan.workDirectory}</p>{activePlan.notes.map(note=><p key={note} className="px4-muted">{note}</p>)}</>:<p className="px4-muted">目录检测和参数校验通过后显示启动命令。</p>}</section>
      <section className="sitl-log"><div><h3>运行日志</h3><label><input type="checkbox" checked={following} onChange={e=>setFollowing(e.target.checked)}/>自动滚动</label></div><pre ref={log} aria-label="软件飞控运行日志" tabIndex={0}>{snapshot?.logs.map(line=>`[${line.stream}] ${line.text}`).join('\n')||'等待启动软件飞控…'}</pre><small className="px4-muted">保留最近 1500 条 · stdout / stderr</small></section>
    </div></div>
  </div>;
}
