export type NshRequest = { command: string; timeoutMs?: number };
export type NshResult = { command: string; output: string; succeeded: boolean; truncated: boolean; durationMs: number; target: { system: number; component: number }; sessionId: number };
export type NshHandler = (request: NshRequest) => Promise<NshResult>;
let owner: NshHandler | null = null;
let remote: NshHandler | null = null;

export function validateNshRequest(request: NshRequest): Required<NshRequest> {
  if (typeof request.command !== 'string' || !request.command.trim() || request.command.length > 256 || /[\x00-\x1f\x7f]/.test(request.command)) throw Error('NSH 仅接受一条不超过 256 字符的非交互命令');
  const timeoutMs = request.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw Error('NSH timeoutMs 范围为 1000～30000');
  return { command: request.command.trim(), timeoutMs };
}
export function registerNshOwner(handler: NshHandler) { owner = handler; return () => { if (owner === handler) owner = null; }; }
export function setRemoteNshHandler(handler: NshHandler | null) { remote = handler; }
export function hasNshHandler() { return !!(owner || remote); }
export function runOwnerNsh(request: NshRequest) { if (!owner) return Promise.reject(Error('请先打开 PX4 工具箱并连接飞控')); return owner(validateNshRequest(request)); }
export function requestMcpNsh(request: NshRequest) { const valid = validateNshRequest(request); return owner ? owner(valid) : remote ? remote(valid) : Promise.reject(Error('请先打开 PX4 工具箱并连接飞控')); }
