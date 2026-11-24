export type VoiceAction =
  | { type: 'status' | 'list_models' | 'list_scripts' | 'pause' | 'resume' | 'stop' | 'restart' | 'open_toolbox' | 'show_scene' | 'show_logs' | 'stop_test' | 'start_px4' | 'stop_px4' }
  | { type: 'select_model' | 'start_model'; model: string }
  | { type: 'start_script'; script: string; model: string }
  | { type: 'start_test'; dryRun: boolean };
export type VoicePlan = { id: string; createdAtMs: number; expiresAtMs: number; reply: string; actions: VoiceAction[] };
export type VoiceApi = { baseUrl: string; apiKey: string; model: string };
export type VoiceConfig = {
  enabled: boolean; llmProtocol: 'ollama' | 'openai'; llm: VoiceApi; jsonMode: boolean;
  asrProtocol: 'openai' | 'whispercpp'; asr: VoiceApi; language: string;
  recorder: 'auto' | 'pw-record' | 'arecord'; inputDevice: string; maxRecordSeconds: number;
  speakReplies: boolean; tts: VoiceApi; ttsVoice: string; timeoutSeconds: number;
};
export type VoiceBinding = { instance: string; selectedModel: string; busy: boolean };
export type VoiceContext = {
  binding: VoiceBinding; simulation: Record<string, unknown>; models: string[]; scripts: string[];
  simulatorTarget?: string | null;
  test: { id: number | null; status: string; name: string; sourceHash: string; pendingDraft: boolean; sourceError: string; sessionId: number | null };
  px4Config: unknown;
  catalogErrors: string[]; capturedAtMs: number;
};

export function voiceInterpretationContext(context: VoiceContext) {
  const { external, local, connected, running, paused, state, model, script } = context.simulation;
  const { name, status, pendingDraft, sourceError } = context.test;
  return {
    binding: context.binding,
    simulation: { external, local, connected, running, paused, state, model, script },
    models: context.models, scripts: context.scripts, catalogErrors: context.catalogErrors,
    test: { name, status, pendingDraft, hasSourceError: Boolean(sourceError) },
    px4Configured: Boolean(context.px4Config),
  };
}

const localReadCommands = {
  status: /^(?:(?:查询|查看|查|看|看看)?(?:一下)?(?:(?:现在|当前|目前)的?)?(?:仿真|模拟)?(?:运行)?状态|(?:查询|查看|看看|看一下)?(?:当前|现在)?(?:仿真|模拟)(?:还在运行吗|运行了吗|有没有在运行|运行情况|状态如何|状态怎么样|是什么状态))$/,
  list_models: /^(?:(?:当前|现在)?有哪些(?:可用的?)?(?:仿真)?模型|(?:列出|查看|查询|显示)(?:当前|所有)?(?:可用的?)?(?:仿真)?模型(?:列表|目录)?)$/,
  list_scripts: /^(?:(?:当前|现在)?有哪些(?:可用的?)?(?:仿真)?脚本|(?:列出|查看|查询|显示)(?:当前|所有)?(?:可用的?)?(?:仿真)?脚本(?:列表|目录)?)$/,
  show_scene: /^(?:打开|显示)(?:三维|3d)?(?:仿真)?视景$/,
  show_logs: /^(?:打开|显示)(?:日志中心|仿真日志|日志)$/,
  open_toolbox: /^(?:打开|显示)px4工具箱$/,
};
export type LocalVoiceReadAction = keyof typeof localReadCommands;

const localControlCommands = {
  pause: /^(?:暂停(?:当前)?仿真|(?:把|将)(?:当前)?仿真暂停)$/,
  resume: /^(?:(?:继续|恢复)(?:当前)?仿真|(?:把|将)(?:当前)?仿真恢复)$/,
  stop: /^(?:停止(?:当前)?仿真|(?:把|将)(?:当前)?仿真停掉)$/,
  restart: /^(?:重新加载|重启)(?:当前)?仿真$/,
};
export type LocalVoiceAction = LocalVoiceReadAction | keyof typeof localControlCommands;
const localCommands = { ...localReadCommands, ...localControlCommands };

export function isLocalVoiceRead(action: LocalVoiceAction): action is LocalVoiceReadAction {
  return Object.prototype.hasOwnProperty.call(localReadCommands, action);
}

export function matchLocalVoiceAction(text: string): LocalVoiceAction | undefined {
  const command = text.normalize('NFKC').toLowerCase().replace(/\s/g, '').replace(/[。.!?！？]+$/, '')
    .replace(/^(?:请你帮我|请帮我|请你|麻烦你|麻烦|帮我|给我|请)/, '').replace(/一下$/, '').replace(/访真/g, '仿真');
  return (Object.keys(localCommands) as LocalVoiceAction[]).find(action => localCommands[action].test(command));
}

const simple = ['status','list_models','list_scripts','pause','resume','stop','restart','open_toolbox','show_scene','show_logs','stop_test','start_px4','stop_px4'];
const identifier = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 128 && !s.startsWith('.') && !s.includes('..') && /^[\w.-]+$/.test(s);
export function validateAction(value: unknown): asserts value is VoiceAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('操作格式无效');
  const a = value as Record<string, unknown>; let keys = ['type'];
  if (simple.includes(String(a.type))) { /* No arguments. */ }
  else if (a.type === 'start_model' || a.type === 'select_model') { keys.push('model'); if (!identifier(a.model)) throw Error('模型标识无效'); }
  else if (a.type === 'start_script') { keys.push('model','script'); if (!identifier(a.model) || !identifier(a.script) || !a.script.endsWith('.xml')) throw Error('脚本或关联模型无效'); }
  else if (a.type === 'start_test') { keys.push('dryRun'); if (typeof a.dryRun !== 'boolean') throw Error('测试必须明确是否干跑'); }
  else throw Error('不支持的语音操作');
  if (Object.keys(a).some(key => !keys.includes(key)) || keys.some(key => !(key in a))) throw Error('语音操作包含未知参数');
}
export function validatePlan(value: unknown): asserts value is VoicePlan {
  const p = value as VoicePlan;
  if (!p || typeof p.id !== 'string' || !Number.isFinite(p.createdAtMs) || !Number.isFinite(p.expiresAtMs) || p.expiresAtMs <= p.createdAtMs || p.expiresAtMs - p.createdAtMs > 60_000 || typeof p.reply !== 'string' || p.reply.length > 3000 || !Array.isArray(p.actions) || p.actions.length > 4) throw Error('大模型返回的计划无效');
  p.actions.forEach(validateAction);
}
export function isReadOnly(action: VoiceAction): boolean { return ['status','list_models','list_scripts','open_toolbox','show_scene','show_logs'].includes(action.type); }
export function describeAction(a: VoiceAction): string {
  if (a.type === 'start_model') return `启动模型 ${a.model}`;
  if (a.type === 'select_model') return `在编辑器载入模型 ${a.model}`;
  if (a.type === 'start_script') return `运行脚本 ${a.script} · 模型 ${a.model}`;
  if (a.type === 'start_test') return a.dryRun ? '干跑当前测试脚本（不控制飞控）' : '运行当前仿真测试脚本（会控制 HIL 飞控）';
  return ({ status:'查询当前仿真状态', list_models:'列出模型', list_scripts:'列出脚本', pause:'暂停当前仿真', resume:'继续当前仿真', stop:'停止当前仿真', restart:'重新加载当前仿真', open_toolbox:'打开 PX4 工具箱', show_scene:'打开三维视景', show_logs:'打开日志中心', stop_test:'结束当前仿真测试', start_px4:'使用软件飞控页已保存配置启动 PX4', stop_px4:'停止上位机启动的软件飞控' } as Record<string,string>)[a.type];
}
export function contextFingerprint(c: VoiceContext): string {
  const s=c.simulation;
  const fc=s.flightController as Record<string,unknown>|undefined|null;
  return JSON.stringify([c.binding.instance,c.binding.selectedModel,c.simulatorTarget,s.local,s.external,s.connected,s.model,s.script,s.state,s.running,s.paused,
    fc?.network_peer,fc?.network_local_port,fc?.device_path,fc?.board_id,fc?.usb_vendor_id,fc?.usb_product_id,fc?.heartbeat_alive,fc?.armed,
    c.test.id,c.test.status,c.test.sessionId,c.test.sourceHash,c.test.pendingDraft,c.test.sourceError,c.px4Config]);
}
export function controllerIdentity(simulation:Record<string,unknown>):string|undefined {
  const fc=simulation.flightController as Record<string,unknown>|undefined|null;
  if(!fc)return;
  const fields=[fc.network_peer,fc.device_path,fc.board_id,fc.usb_vendor_id,fc.usb_product_id];
  return fields.some(value=>value!==undefined&&value!==null&&value!=='')?JSON.stringify(fields):undefined;
}
export function checkPlan(plan: VoicePlan, context: VoiceContext, now = Date.now()) {
  validatePlan(plan);
  if (now > plan.expiresAtMs || now < plan.createdAtMs - 5000) throw Error('操作预览已过期，请重新解析');
  if (plan.actions.some(a=>!isReadOnly(a)) && context.binding.busy) throw Error('上位机正在处理其他操作，请稍后重试');
  for (const a of plan.actions) {
    if (['start_model','start_script','pause','resume','stop','restart'].includes(a.type) && context.simulation.external === true && context.simulation.connected !== true) throw Error('仿真链路未连接，请先恢复连接并重新解析');
    if (['select_model','start_model','start_script','pause','resume','stop','restart'].includes(a.type) && context.binding.instance !== '01') throw Error('当前语音模型控制仅支持实例 01，请先切换实例');
    if ('model' in a && !context.models.includes(a.model)) throw Error(`模型目录中不存在 ${a.model}，请刷新上下文`);
    if (a.type === 'start_script' && !context.scripts.includes(a.script)) throw Error(`脚本目录中不存在 ${a.script}`);
    if (a.type === 'start_model' && a.model === 'F450_PX4') throw Error('F450_PX4 请使用 F450_PX4_lan.xml 地面脚本');
  }
}
export type StepResult = { action: string; ok: boolean; message: string };
export async function runVoicePlan(plan: VoicePlan, prepared: VoiceContext, services: {
  current: () => Promise<VoiceContext>;
  binding: () => VoiceBinding;
  execute: (action: VoiceAction, context: VoiceContext) => Promise<string>;
  cancelled: () => boolean;
  onStep: (result: StepResult) => void;
}): Promise<void> {
  let current=await services.current(); checkPlan(plan,current);
  if (plan.actions.some(a=>!isReadOnly(a)) && contextFingerprint(prepared)!==contextFingerprint(current)) throw Error('实例、模型、飞控连接或运行状态已变化，请重新解析');
  for (const [index,action] of plan.actions.entries()) {
    if (Date.now()>plan.expiresAtMs) throw Error('操作预览已过期，后续步骤未执行');
    if (services.cancelled()) throw Error('已取消后续操作；已经完成的操作不会回滚');
    const binding=services.binding();
    if (!isReadOnly(action) && (binding.instance!==prepared.binding.instance || binding.busy)) throw Error('当前实例或操作状态已变化，后续操作未执行');
    if (!isReadOnly(action) && (current.simulatorTarget!==prepared.simulatorTarget || current.test.sourceHash!==prepared.test.sourceHash || JSON.stringify(current.px4Config)!==JSON.stringify(prepared.px4Config))) throw Error('仿真机地址、测试脚本或软件飞控配置已变化，后续操作未执行');
    if(!isReadOnly(action)&&controllerIdentity(prepared.simulation)&&controllerIdentity(prepared.simulation)!==controllerIdentity(current.simulation))throw Error('飞控标识已变化，后续操作未执行');
    try { const message=await services.execute(action,current); services.onStep({action:describeAction(action),ok:true,message}); }
    catch(e) { services.onStep({action:describeAction(action),ok:false,message:String(e)}); throw e; }
    if(index<plan.actions.length-1&&!services.cancelled())current=await services.current();
  }
}
