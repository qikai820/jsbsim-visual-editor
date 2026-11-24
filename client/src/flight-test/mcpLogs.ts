export type LogRequest = { action: 'list' } | { action: 'download'; id: number; expectedSize: number; expectedTime: number } | { action: 'cancel'; jobId: number };
export type LogHandler = (request: LogRequest) => Promise<unknown>;
let owner: LogHandler | null = null, remote: LogHandler | null = null;
export function validateLogRequest(request: LogRequest): LogRequest {
  const integer=(v:number,min:number,max:number)=>Number.isInteger(v)&&v>=min&&v<=max;
  if(request.action==='list')return request;
  if(request.action==='cancel'&&integer(request.jobId,1,Number.MAX_SAFE_INTEGER))return request;
  if(request.action==='download'&&integer(request.id,0,65534)&&integer(request.expectedSize,16,512*1024*1024)&&integer(request.expectedTime,0,4294967295))return request;
  throw Error('日志请求参数无效');
}
export function registerLogOwner(handler:LogHandler){owner=handler;return()=>{if(owner===handler)owner=null;};}
export function setRemoteLogHandler(handler:LogHandler|null){remote=handler;}
export function hasLogHandler(){return !!(owner||remote);}
export function runOwnerLog(request:LogRequest){return owner?owner(validateLogRequest(request)):Promise.reject(Error('PX4 日志连接拥有者未就绪'));}
export function requestMcpLog(request:LogRequest){const valid=validateLogRequest(request);return owner?owner(valid):remote?remote(valid):Promise.reject(Error('请先打开 PX4 工具箱并连接飞控'));}
