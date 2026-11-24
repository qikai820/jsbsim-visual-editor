import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openTestToolbox, sessionIsActive, startMcpFlightTest, stopFlightTest, useFlightTestStore } from './session';
import { hasLogHandler, requestMcpLog, type LogRequest } from './mcpLogs';
import { hasNshHandler, requestMcpNsh, validateNshRequest } from './mcpNsh';

type Request = { name: string; arguments: { source?: string; dryRun?: boolean; id?: number; command?: string; timeoutMs?: number } };
export type McpStatus = { enabled: boolean; endpointFile: string | null; audit: Array<{ tool: string; ok: boolean; unixMs: number }> };
let modelControlBusy=false;
export async function executeMcpRequest(request: Request) {
  if(modelControlBusy)throw Error('模型启停正在处理中；请先查询状态，不要重复控制请求');
  if(request.name==='upper_sim_start'||request.name==='upper_sim_stop') {
    const state=useFlightTestStore.getState();
    if(sessionIsActive(state)||state.rcSourceSwitching||state.context?.disabled)throw Error('飞控操作进行中，未启停模型');
    modelControlBusy=true;
    try {
      const args=request.arguments as Record<string,any>;
      if(request.name==='upper_sim_stop')await invoke('sim_instance_control',{instanceId:'01',action:'stop'});
      else if(args.latitudeDeg!==undefined) {
        const caps=await invoke<string>('nsh_execute',{command:'jsbsim --hil-capabilities'});
        if(!caps.split(/\s+/).includes('moving_platform_version=1'))throw Error('显式平台初始姿态需要移动平台固件 v1');
        await invoke('sim_instance_control',{instanceId:'01',action:'start',model:args.model,
          initial:{latitudeDeg:args.latitudeDeg,longitudeDeg:args.longitudeDeg,altitudeM:args.terrainAltitudeM,rollDeg:args.rollDeg??0,pitchDeg:args.pitchDeg??0,yawDeg:args.yawDeg??0}});
      } else await invoke('sim_start',{model:args.model,script:args.script});
      const deadline=performance.now()+20000;
      while(performance.now()<deadline) {
        const snapshot=await invoke<any>('sim_instance_snapshot',{instanceId:'01'});
        if(snapshot && snapshot.age_ms<3000 && (request.name==='upper_sim_stop'?snapshot.state==='stopped':snapshot.state==='running'&&snapshot.model===args.model))
          return {snapshot,simulation:await invoke('sim_status')};
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw Error('未确认模型状态；已发送一次控制，未自动重试。请查询状态');
    } finally {modelControlBusy=false;}
  }
  if(['upper_list_logs','upper_download_log','upper_cancel_log_download'].includes(request.name)){
    openTestToolbox();const deadline=performance.now()+5000;while(!hasLogHandler()||!useFlightTestStore.getState().context?.link?.alive){if(performance.now()>=deadline)throw Error('工具箱日志拥有者未就绪，未执行');await new Promise(r=>setTimeout(r,50));}
    const args=request.arguments as Record<string,any>;const logRequest:LogRequest=request.name==='upper_list_logs'?{action:'list'}:request.name==='upper_cancel_log_download'?{action:'cancel',jobId:args.jobId}:{action:'download',id:args.id,expectedSize:args.expectedSize,expectedTime:args.expectedTime};return requestMcpLog(logRequest);
  }
  if (request.name === 'upper_nsh_command') {
    if (typeof request.arguments.command !== 'string') throw Error('NSH command 必须是字符串');
    const valid=validateNshRequest({ command: request.arguments.command, timeoutMs: request.arguments.timeoutMs });
    const before=useFlightTestStore.getState();
    if(sessionIsActive(before)||before.rcSourceSwitching||before.context?.disabled)throw Error('其他飞控操作进行中，未发送 NSH 命令');
    // Opening a view and waiting for the existing owner is not a command retry.
    openTestToolbox();
    const deadline=performance.now()+5000;
    while(!hasNshHandler()||!useFlightTestStore.getState().context?.link?.alive){
      if(performance.now()>=deadline)throw Error('工具箱连接未就绪，未发送 NSH 命令');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return requestMcpNsh(valid);
  }
  if (request.name === 'upper_start_test') {
    if (typeof request.arguments.source !== 'string' || typeof request.arguments.dryRun !== 'boolean') throw Error('MCP 测试请求无效');
    return startMcpFlightTest(request.arguments.source, request.arguments.dryRun);
  }
  if (request.name === 'upper_stop_test') {
    const state = useFlightTestStore.getState();
    if (state.snapshot?.id !== request.arguments.id) throw Error('测试运行标识已变化');
    if (state.starting || state.stopping) throw Error('测试启动或退出处理中，请查询状态');
    if (!sessionIsActive(state)) return state.snapshot;
    await stopFlightTest();
    const result = useFlightTestStore.getState();
    if (result.error) throw Error(result.error);
    return result.snapshot;
  }
  throw Error('未知 MCP 控制请求');
}
// Mounted once with Toolbar; toolbox visibility and MCP process lifetime do
// not own the runner or the device connection.
export function useUpperMcp() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined;
    void listen<{ id: number }>('upper-mcp-request', async event => {
      if (disposed) return;
      let request: Request;
      try { request = await invoke<Request>('mcp_claim_request', { id: event.payload.id }); }
      catch { return; } // Expired requests must never execute later.
      let result: unknown = null, error: string | null = null;
      try { result = await executeMcpRequest(request); }
      catch (e) { error = String(e); }
      await invoke('mcp_complete_request', { id: event.payload.id, result, error }).catch(() => {});
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    const refresh = () => void invoke<McpStatus>('mcp_bridge_status').then(value => { if (!disposed) setStatus(value); }).catch(() => {});
    refresh(); const timer = setInterval(refresh, 2000);
    return () => { disposed = true; unlisten?.(); clearInterval(timer); };
  }, []);
  return status;
}
