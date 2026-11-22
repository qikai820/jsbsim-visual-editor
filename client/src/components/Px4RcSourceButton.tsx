import {useEffect} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {rcSourceOptions,selectRcSource,sessionIsActive,useFlightTestStore,type RcSourceStatus} from '../flight-test/session';

export default function Px4RcSourceButton(){
  const state=useFlightTestStore(),context=state.context,link=context?.link;
  const alive=link?.alive,hil=link?.hilEnabled,sessionId=link?.transport.sessionId;
  const generation=link?.bootGeneration,heartbeatGeneration=link?.heartbeatGeneration;
  const source=state.rcSource,switching=state.rcSourceSwitching||source?.switching;
  const needsStart=source?.selected===1&&!source.ready&&!source.idleSending&&!sessionIsActive(state);
  useEffect(()=>{
    let disposed=false,polling=false;
    useFlightTestStore.setState({rcSource:null,rcSourceError:'',rcSourceStatusError:''});
    if(!context||!alive||!hil||!context.bidirectional)return;
    const poll=async()=>{
      if(polling||useFlightTestStore.getState().rcSourceSwitching)return;
      polling=true;
      const previous=useFlightTestStore.getState().rcSource;
      try{
        await link.ready;
        const before=useFlightTestStore.getState();
        if(disposed||before.rcSourceSwitching||before.context?.link!==link||!link.alive)return;
        const result=await invoke<RcSourceStatus>('flight_test_rc_source_status',{options:rcSourceOptions(context)});
        const current=useFlightTestStore.getState();
        if(!disposed&&!current.rcSourceSwitching&&current.rcSource===previous&&current.context?.link===link)useFlightTestStore.setState({rcSource:result,rcSourceStatusError:''});
      }catch(e){if(!disposed&&!useFlightTestStore.getState().rcSourceSwitching)useFlightTestStore.setState({rcSource:null,rcSourceStatusError:String(e)});}
      finally{polling=false;}
    };
    void poll();const timer=setInterval(()=>void poll(),500);
    return()=>{disposed=true;clearInterval(timer);};
  },[link,alive,hil,sessionId,generation,heartbeatGeneration,context?.instance,context?.bidirectional]);
  const name=source?.selected===0?'实体遥控器':source?.selected===1?'工具箱模拟':source?.supported?'自动／混合输入':'遥控器来源';
  const feedback=switching?'正在切换…':!alive?'未连接':!hil?'非 HIL':!source?'读取中':!source.supported?'读取中':needsStart?'待启用':source.ready?'已确认':(source.feedbackAgeMs??0)>=1200?'反馈过期':'未就绪';
  const locked=sessionIsActive(state)||context?.disabled||link?.armed!==false;
  const reason=state.rcSourceError||state.rcSourceStatusError||(!alive?'请先连接飞控':!hil?'仅在 HIL 仿真中切换':switching?'等待飞控参数及实际来源确认':locked?(link?.armed?'飞控已解锁，请上锁后切换':'测试或其他飞控操作进行中'):!source?.supported?(source?.reason||'正在读取输入来源'):source.selected!==1?'COM_RC_IN_MODE → 1：选择工具箱 MANUAL_CONTROL 主杆':needsStart?'点击启用工具箱模拟输入（零油门待机）':'COM_RC_IN_MODE → 0：选择实体主输入');
  return <button type="button" className="ft-rc-source" data-state={switching?'switching':source?.ready?'ready':'waiting'}
    aria-label={`${name} · ${feedback}`} title={reason} aria-busy={!!switching}
    disabled={!!switching||!!locked||!alive||!hil||!context?.bidirectional||!source?.supported}
    onClick={()=>void selectRcSource().catch(()=>{})}><span aria-hidden="true">⊕</span><span>{name}</span><small>{feedback}</small><span aria-hidden="true">{switching?'…':locked?'▣':needsStart?'▶':'⇄'}</span></button>;
}
