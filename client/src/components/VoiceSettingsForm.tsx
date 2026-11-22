import type { VoiceConfig } from '../voice/model';
export default function VoiceSettingsForm({value,onChange,onSave,onProbe,busy,recorders}:{
  value:VoiceConfig;onChange:(value:VoiceConfig)=>void;onSave:()=>void;onProbe:()=>void;busy:boolean;recorders:string[];
}) {
  const set=(patch:Partial<VoiceConfig>)=>onChange({...value,...patch});
  const api=(key:'llm'|'asr'|'tts',label:string)=> <div className="voice-api-fields">
    <label>{label}地址<input aria-label={`${label}地址`} value={value[key].baseUrl} onChange={e=>set({[key]:{...value[key],baseUrl:e.target.value}})}/></label>
    <label>模型名称<input aria-label={`${label}模型`} value={value[key].model} onChange={e=>set({[key]:{...value[key],model:e.target.value}})}/></label>
    <label>API Key（本机服务可留空）<input aria-label={`${label}API Key`} type="password" autoComplete="off" value={value[key].apiKey} onChange={e=>set({[key]:{...value[key],apiKey:e.target.value}})}/></label>
  </div>;
  return <div className="voice-settings"><fieldset disabled={busy}>
    <label className="voice-check"><input aria-label="启用大模型语音操作" type="checkbox" checked={value.enabled} onChange={e=>set({enabled:e.target.checked})}/>启用大模型语音操作</label>
    <p>按键录音，也可输入文字。只在你发出指令后访问配置的服务。</p>
    <h3>指令大模型</h3>
    <label>接口协议<select aria-label="大模型接口协议" value={value.llmProtocol} onChange={e=>{const llmProtocol=e.target.value as VoiceConfig['llmProtocol'];set({llmProtocol,llm:{...value.llm,baseUrl:llmProtocol==='ollama'?'http://127.0.0.1:11434':'http://127.0.0.1:8000/v1'}});}}><option value="ollama">Ollama</option><option value="openai">OpenAI 兼容（本机 / 局域网 / 云端）</option></select></label>
    {api('llm','大模型')}
    <label className="voice-check"><input type="checkbox" checked={value.jsonMode} onChange={e=>set({jsonMode:e.target.checked})}/>使用结构化 JSON 输出</label>
    <h3>语音识别</h3>
    <label>接口协议<select aria-label="语音识别接口协议" value={value.asrProtocol} onChange={e=>{const asrProtocol=e.target.value as VoiceConfig['asrProtocol'];set({asrProtocol,asr:{...value.asr,baseUrl:asrProtocol==='openai'?'http://127.0.0.1:8178/v1':'http://127.0.0.1:8080'}});}}><option value="openai">OpenAI 兼容转写</option><option value="whispercpp">whisper.cpp server</option></select></label>
    {api('asr','语音识别')}
    <div className="voice-field-pair"><label>语言<input aria-label="语音语言" value={value.language} onChange={e=>set({language:e.target.value})}/></label><label>录音上限（秒）<input aria-label="录音时长上限" type="number" min="5" max="60" value={value.maxRecordSeconds} onChange={e=>set({maxRecordSeconds:e.target.valueAsNumber})}/></label></div>
    <label>录音程序<select aria-label="录音程序" value={value.recorder} onChange={e=>set({recorder:e.target.value as VoiceConfig['recorder']})}><option value="auto">自动（优先 PipeWire）</option><option value="pw-record">pw-record</option><option value="arecord">arecord</option></select></label>
    <label>输入设备（留空使用系统默认麦克风）<input aria-label="麦克风设备" value={value.inputDevice} onChange={e=>set({inputDevice:e.target.value})}/></label>
    <small>已检测录音程序：{recorders.join('、')||'无；仍可使用文字指令'}</small>
    <h3>语音播报</h3>
    <label className="voice-check"><input aria-label="启用语音播报" type="checkbox" checked={value.speakReplies} onChange={e=>set({speakReplies:e.target.checked})}/>播报操作结果（需要兼容语音合成服务）</label>
    {value.speakReplies&&<>{api('tts','语音合成')}<label>音色<input aria-label="播报音色" value={value.ttsVoice} onChange={e=>set({ttsVoice:e.target.value})}/></label></>}
    <label>服务请求超时（秒）<input aria-label="语音请求超时" type="number" min="5" max="180" value={value.timeoutSeconds} onChange={e=>set({timeoutSeconds:e.target.valueAsNumber})}/></label>
    <p>填写基础地址：兼容接口通常以 /v1 结尾；Ollama 和 whisper.cpp 填服务根地址。模型需已在对应服务中部署。</p>
    <div className="voice-buttons"><button onClick={onProbe}>检查服务连接</button><button className="voice-primary" onClick={onSave}>保存语音配置</button></div>
  </fieldset></div>;
}
