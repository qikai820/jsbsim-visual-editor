import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceCancel,voiceGetConfig,voiceInterpret,voiceProbe,voiceRecordCancel,voiceRecordStart,voiceSaveConfig,voiceSynthesize,voiceTranscribe,type VoiceConfiguration } from '../voice/api';
import { checkPlan,describeAction,isReadOnly,runVoicePlan,validatePlan,type StepResult,type VoiceConfig,type VoiceContext,type VoicePlan } from '../voice/model';
import { collectVoiceContext,executeVoiceAction,readVoiceContext,type VoiceHost } from '../voice/runtime';
import VoiceSettingsForm from './VoiceSettingsForm';
import './VoiceAssistant.css';

type Phase='idle'|'starting_recording'|'recording'|'transcribing'|'context'|'thinking'|'executing'|'speaking'|'saving'|'probing';
const phaseLabels:Record<Phase,string>={idle:'就绪',starting_recording:'打开麦克风',recording:'正在录音',transcribing:'识别语音',context:'读取当前上下文',thinking:'大模型解析中',executing:'执行操作中',speaking:'语音播报中',saving:'保存配置',probing:'检查服务连接'};
type Pending={plan:VoicePlan;context:VoiceContext};
export default function VoiceAssistant({open,onClose,host,onExecutingChange}:{open:boolean;onClose:()=>void;host:VoiceHost;onExecutingChange?:(busy:boolean)=>void}){
  const hostRef=useRef(host);hostRef.current=host;
  const [tab,setTab]=useState<'operation'|'settings'>('operation'),[settings,setSettings]=useState<VoiceConfiguration>(),[draft,setDraft]=useState<VoiceConfig>();
  const [phase,setPhase]=useState<Phase>('idle'),[text,setText]=useState(''),[reply,setReply]=useState(''),[error,setError]=useState(''),[speechError,setSpeechError]=useState('');
  const [configLoading,setConfigLoading]=useState(false);
  const [pending,setPending]=useState<Pending>(),[steps,setSteps]=useState<StepResult[]>([]),[probe,setProbe]=useState(''),[elapsed,setElapsed]=useState(0),[executionBusy,setExecutionBusy]=useState(false);
  const epoch=useRef(0),request=useRef(''),recording=useRef<{id:number;maxSeconds:number;started:number}>(),autoStop=useRef<ReturnType<typeof setTimeout>>(),player=useRef<HTMLAudioElement>(),audioUrl=useRef(''),executing=useRef(false);
  const stopAudio=()=>{player.current?.pause();player.current=undefined;if(audioUrl.current){URL.revokeObjectURL(audioUrl.current);audioUrl.current='';}};
  const cancel=useCallback(()=>{
    epoch.current++;if(request.current){void voiceCancel(request.current).catch(()=>{});request.current='';}
    if(recording.current){void voiceRecordCancel(recording.current.id).catch(()=>{});recording.current=undefined;}
    clearTimeout(autoStop.current);stopAudio();setPending(undefined);setPhase('idle');
  },[]);
  useEffect(()=>()=>{cancel();},[cancel]);
  useEffect(()=>{onExecutingChange?.(executionBusy);return()=>onExecutingChange?.(false);},[executionBusy,onExecutingChange]);
  useEffect(()=>{if(!open){cancel();return;}let disposed=false;setConfigLoading(true);void voiceGetConfig().then(async value=>{if(!disposed&&value.recordingId&&!recording.current)await voiceRecordCancel(value.recordingId);if(!disposed){setSettings(value);setDraft(value.config);}}).catch(e=>{if(!disposed){setSettings(undefined);setDraft(undefined);setError(String(e));}}).finally(()=>{if(!disposed)setConfigLoading(false);});return()=>{disposed=true;};},[open,cancel]);
  useEffect(()=>{const show=(event:Event)=>{if((event as CustomEvent).detail==='settings'){cancel();setTab('settings');}};window.addEventListener('jsbsim-voice-open',show);return()=>window.removeEventListener('jsbsim-voice-open',show);},[cancel]);
  useEffect(()=>{if(phase!=='recording')return;const timer=setInterval(()=>setElapsed(recording.current?(Date.now()-recording.current.started)/1000:0),200);return()=>clearInterval(timer);},[phase]);
  const speak=async(message:string,token:number)=>{
    if(!settings?.config.speakReplies||token!==epoch.current)return;
    setSpeechError('');setPhase('speaking');const id=crypto.randomUUID();request.current=id;
    try{const audio=await voiceSynthesize(message.slice(0,400),id);if(token!==epoch.current)return;request.current='';
      const bytes=Uint8Array.from(atob(audio.data),char=>char.charCodeAt(0));audioUrl.current=URL.createObjectURL(new Blob([bytes],{type:audio.mime}));
      const element=new Audio(audioUrl.current);player.current=element;element.onended=()=>{if(token===epoch.current){stopAudio();setPhase('idle');}};element.onerror=()=>{if(token===epoch.current){stopAudio();setSpeechError('语音播放失败；文字结果仍可查看');setPhase('idle');}};await element.play();
    }catch(e){if(token===epoch.current){setSpeechError(`播报失败：${String(e)}`);setPhase('idle');}}
  };
  const execute=async(value:Pending,token:number)=>{
    if(executing.current)return;executing.current=true;setExecutionBusy(true);setPending(undefined);setSteps([]);setError('');setPhase('executing');const results:StepResult[]=[];
    try{
      await runVoicePlan(value.plan,value.context,{
        current:()=>readVoiceContext(hostRef.current,{models:value.context.models,scripts:value.context.scripts,errors:value.context.catalogErrors}),
        binding:()=>hostRef.current.binding(),cancelled:()=>epoch.current!==token,
        execute:(action,context)=>executeVoiceAction(action,context,hostRef.current,()=>epoch.current===token&&Date.now()<=value.plan.expiresAtMs),
        onStep:result=>{results.push(result);setSteps([...results]);},
      });
      if(token===epoch.current){setPhase('idle');await speak(results[results.length-1]?.message||'操作已完成',token);}
    }catch(e){if(token===epoch.current){setError(String(e));setPhase('idle');}}
    finally{executing.current=false;setExecutionBusy(false);}
  };
  const analyze=async(input=text)=>{
    if(executing.current||!input.trim())return;cancel();const token=epoch.current;setError('');setSpeechError('');setReply('');setSteps([]);setPhase('context');
    try{
      const context=await collectVoiceContext(hostRef.current);if(token!==epoch.current)return;
      setPhase('thinking');const id=crypto.randomUUID();request.current=id;const plan=await voiceInterpret(input,context,id);
      if(token!==epoch.current)return;request.current='';validatePlan(plan);checkPlan(plan,context);setReply(plan.reply);setPhase('idle');
      if(plan.actions.length&&plan.actions.every(isReadOnly))await execute({plan,context},token);
      else if(plan.actions.length)setPending({plan,context});else await speak(plan.reply,token);
    }catch(e){if(token===epoch.current){setError(String(e));setPhase('idle');}}
  };
  const finishRecording=async()=>{
    const session=recording.current;if(!session)return;recording.current=undefined;clearTimeout(autoStop.current);setPhase('transcribing');const token=epoch.current,id=crypto.randomUUID();request.current=id;
    try{const transcript=await voiceTranscribe(session.id,id);if(token!==epoch.current)return;request.current='';setText(transcript);await analyze(transcript);}
    catch(e){void voiceRecordCancel(session.id).catch(()=>{});if(token===epoch.current){setError(String(e));setPhase('idle');}}
  };
  const startRecording=async()=>{
    if(executing.current)return;cancel();const token=epoch.current;setError('');setReply('');setSteps([]);setElapsed(0);setPhase('starting_recording');
    try{const session=await voiceRecordStart();if(token!==epoch.current){void voiceRecordCancel(session.id);return;}recording.current={...session,started:Date.now()};setPhase('recording');autoStop.current=setTimeout(()=>void finishRecording(),session.maxSeconds*1000);}
    catch(e){if(token===epoch.current){setError(String(e));setPhase('idle');}}
  };
  const save=async()=>{if(!draft)return;setPhase('saving');setError('');const token=epoch.current;try{const config=await voiceSaveConfig(draft);if(token===epoch.current){setSettings(s=>s&&({...s,config}));setDraft(config);setProbe('语音配置已保存，立即生效');setPending(undefined);}}catch(e){if(token===epoch.current)setError(String(e));}finally{if(token===epoch.current)setPhase('idle');}};
  const check=async()=>{if(!draft)return;setPhase('probing');setError('');const token=epoch.current,id=crypto.randomUUID();request.current=id;try{const result=await voiceProbe(draft,id);if(token===epoch.current)setProbe(`大模型：${result.llm.ok?'✓':'×'} ${result.llm.message}\n语音识别：${result.asr.ok?'✓':'×'} ${result.asr.message}${result.llm.models.length?'\n可用模型：'+result.llm.models.join('、'):''}`);}catch(e){if(token===epoch.current)setError(String(e));}finally{if(token===epoch.current){request.current='';setPhase('idle');}}};
  if(!open)return null;
  const busy=configLoading||phase!=='idle'&&phase!=='speaking',enabled=!!settings?.config.enabled;
  return <aside className="voice-assistant" role="dialog" aria-label="大模型语音操作">
    <header><div><b>🎙 大模型语音操作</b><small>实例 {host.binding().instance} · {phaseLabels[phase]}{phase==='recording'?` ${elapsed.toFixed(1)} s`:''}</small></div><button aria-label="关闭语音助手" onClick={onClose}>×</button></header>
    <nav><button className={tab==='operation'?'active':''} onClick={()=>setTab('operation')}>语音操作</button><button className={tab==='settings'?'active':''} onClick={()=>{cancel();setTab('settings');}}>服务配置</button></nav>
    <div className="voice-content">
      {error&&<p className="voice-error" role="alert">{error}</p>}
      {tab==='settings'?(draft?<><VoiceSettingsForm value={draft} onChange={setDraft} onSave={()=>void save()} onProbe={()=>void check()} busy={busy||executionBusy} recorders={settings?.capabilities.recorders||[]}/>{probe&&<pre className="voice-probe" role="status">{probe}</pre>}</>:<p>正在读取语音配置…</p>):<>
        {!enabled&&<p className="voice-notice">尚未启用。请在“服务配置”中填写已部署的大模型和语音识别地址，启用并保存。</p>}
        <div className="voice-buttons"><button className={'voice-record'+(phase==='recording'?' recording':'')} disabled={!enabled||busy&&phase!=='recording'||executionBusy} onClick={()=>void(phase==='recording'?finishRecording():startRecording())}>{phase==='recording'?'■ 停止并识别':'🎙 开始录音'}</button>{phase!=='idle'&&<button onClick={cancel}>{phase==='executing'?'取消后续操作':'取消'}</button>}</div>
        <label className="voice-instruction">识别文字 / 文字指令<textarea aria-label="语音指令文字" rows={4} disabled={busy} value={text} placeholder="例如：查询当前状态；用 F450_PX4_lan.xml 启动 F450；暂停仿真；打开三维视景" onChange={e=>{cancel();setText(e.target.value);setReply('');}}/></label>
        <div className="voice-buttons"><button className="voice-primary" disabled={!enabled||busy||!text.trim()||executionBusy} onClick={()=>void analyze()}>解析指令</button><small>改变运行状态的操作会先预览。</small></div>
        {reply&&<div className="voice-reply"><b>模型理解</b><p>{reply}</p></div>}
        {pending&&<section className="voice-preview" aria-label="语音操作预览"><b>待执行操作</b><ol>{pending.plan.actions.map((a,i)=><li key={i}>{describeAction(a)}</li>)}</ol><small>实例 {pending.context.binding.instance} · 有效 60 秒。预览后改变连接或运行状态，需要重新解析。</small>{pending.plan.actions.some(a=>a.type==='start_test')&&<p>当前测试脚本：{pending.context.test.name}</p>}{pending.plan.actions.some(a=>a.type==='start_px4')&&<pre className="voice-probe">{JSON.stringify(pending.context.px4Config,null,2)||'尚未保存软件飞控配置'}</pre>}<div className="voice-buttons"><button className="voice-primary" disabled={busy||executionBusy} onClick={()=>void execute(pending,epoch.current)}>执行上述操作</button><button onClick={cancel}>放弃</button></div></section>}
        {!!steps.length&&<section className="voice-results" aria-label="语音执行结果"><b>执行结果</b>{steps.map((s,i)=><div key={i} className={s.ok?'':'voice-error'}><strong>{s.ok?'✓':'×'} {s.action}</strong><p>{s.message}</p></div>)}</section>}
        {speechError&&<div className="voice-notice"><p>{speechError}</p>{player.current&&<button onClick={()=>{setSpeechError('');setPhase('speaking');void player.current?.play().catch(e=>{setSpeechError(String(e));setPhase('idle');});}}>播放播报</button>}</div>}
        {executionBusy&&<p className="voice-notice">已提交的操作可能继续完成；取消只阻止后续步骤。</p>}
        <p className="voice-scope">支持仿真启停、模型选择、视景、日志、软件飞控和当前测试脚本。录音只在点击后启动，不后台监听。</p>
      </>}
    </div>
  </aside>;
}
