import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { sessionIsActive, startMcpFlightTest, stopFlightTest, useFlightTestStore } from './session';

type Request = { name: string; arguments: { source?: string; dryRun?: boolean; id?: number } };
export type McpStatus = { enabled: boolean; endpointFile: string | null; audit: Array<{ tool: string; ok: boolean; unixMs: number }> };
export async function executeMcpRequest(request: Request) {
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
