import assert from 'node:assert/strict';
import net from 'node:net';
import {uiBrowser} from './support/ui-browser.mjs';
const socketError=await new Promise(resolve=>{const probe=net.createServer();probe.once('error',resolve);probe.listen(0,'127.0.0.1',()=>probe.close(()=>resolve(null)));});
if(socketError){
 if(['EPERM','EACCES'].includes(socketError.code)){console.error('BLOCKED: 浏览器集成测试需要本机套接字；当前环境禁止创建监听端口。离线测试可用 npm run test:voice。');process.exit(77);}
 throw socketError;
}
const setup=`localStorage.setItem('jsbsim-language','zh-CN');window.calls=[];window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:(command,args)=>window.native(command,args)};window.change=(element,value)=>{Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};`;
const source=`import React from'react';import{createRoot}from'react-dom/client';import Voice from'./src/components/VoiceAssistant';
window.config={enabled:false,llmProtocol:'ollama',llm:{baseUrl:'http://127.0.0.1:11434',apiKey:'',model:'qwen3:4b'},jsonMode:true,asrProtocol:'openai',asr:{baseUrl:'http://127.0.0.1:8178/v1',apiKey:'',model:'small'},language:'zh',recorder:'auto',inputDevice:'',maxRecordSeconds:30,speakReplies:false,tts:{baseUrl:'http://127.0.0.1:8179/v1',apiKey:'',model:'tts-1'},ttsVoice:'default',timeoutSeconds:90};
window.sim={external:true,local:true,connected:true,running:true,paused:false,model:'ball',state:'running'};window.nextAction={type:'pause'};window.voiceId=0;
window.native=async(command,args)=>{window.calls.push({command,args});if(command==='voice_config_get')return{config:window.config,capabilities:{platform:'linux',recorders:['pw-record']}};if(command==='voice_config_save'){window.config=args.config;return args.config;}if(command==='voice_record_start'){if(window.deferRecording)return await new Promise(resolve=>{window.resolveRecording=resolve;});return{id:++window.voiceId,recorder:'pw-record',maxSeconds:30};}if(command==='voice_record_cancel'||command==='voice_cancel')return null;if(command==='voice_transcribe')return '暂停仿真';if(command==='sim_status')return {...window.sim};if(command==='simulator_network_target_get')return '127.0.0.1';if(command==='sim_list_models')return{models:[{name:'ball'},{name:'F450_PX4'}]};if(command==='sim_list_tests')return{tests:[{file:'F450_PX4_lan.xml'}]};if(command==='voice_interpret'){if(window.defer)return await new Promise(resolve=>{window.resolvePlan=resolve;});if(window.failLLM)throw Error('大模型服务不可用');return{id:args.requestId,createdAtMs:Date.now(),expiresAtMs:Date.now()+60000,reply:'准备暂停',actions:[window.nextAction]};}if(command==='sim_pause'){window.sim={...window.sim,paused:true,state:'paused'};return{running:true,paused:true};}throw Error(command);};
const host={binding:()=>({instance:'01',selectedModel:'ball',busy:false}),selectModel:async()=>{},syncModel:async()=>false,openToolbox:()=>{},showScene:()=>{window.sceneOpened=true;},showLogs:()=>{}};
createRoot(document.getElementById('root')).render(<Voice open={true} onClose={()=>{}} host={host}/>);`;
const ui=await uiBrowser(source,{setup,port:5197});const {ev,until,click}=ui;
const button=text=>`Array.from(document.querySelectorAll('button')).find(e=>e.textContent===${JSON.stringify(text)})`;
const press=async label=>{await ev(`${button(label)}.scrollIntoView({block:'center'})`);await click(button(label));};
const controlCalls=()=>ev(`window.calls.filter(c=>['sim_pause','sim_stop','sim_start'].includes(c.command)).length`);
try{
 await until(`document.querySelector('[aria-label="语音指令文字"]')`);
 assert.equal(await ev(`${button('🎙 开始录音')}.disabled`),true);
 await press('服务配置');await until(`document.querySelector('[aria-label="启用大模型语音操作"]')`);
 await click(`document.querySelector('[aria-label="启用大模型语音操作"]')`);
 await ev(`window.change(document.querySelector('[aria-label="大模型API Key"]'),'private-key')`);
 await press('保存语音配置');await until(`document.querySelector('.voice-probe')?.textContent.includes('已保存')`);
 assert.equal(await ev(`JSON.stringify(localStorage).includes('private-key')`),false);
 await press('语音操作');
 await ev(`window.change(document.querySelector('[aria-label="语音指令文字"]'),'暂停仿真')`);
 await press('解析指令');await until(`document.querySelector('[aria-label="语音操作预览"]')`);assert.equal(await controlCalls(),0);
 await ev(`window.change(document.querySelector('[aria-label="语音指令文字"]'),'先不要暂停')`);
 assert.equal(await ev(`Boolean(document.querySelector('[aria-label="语音操作预览"]'))`),false);
 await ev(`window.change(document.querySelector('[aria-label="语音指令文字"]'),'暂停仿真')`);
 await press('解析指令');await until(`document.querySelector('[aria-label="语音操作预览"]')`);
 await press('执行上述操作');await until(`document.querySelector('[aria-label="语音执行结果"]')?.textContent.includes('仿真已暂停')`);assert.equal(await controlCalls(),1);
 await press('🎙 开始录音');await until(`window.calls.some(c=>c.command==='voice_record_start')`);await until(`${button('■ 停止并识别')}`);
 await press('取消');await until(`window.calls.some(c=>c.command==='voice_record_cancel')`);assert.equal(await ev(`window.calls.some(c=>c.command==='voice_transcribe')`),false);
 await press('🎙 开始录音');await until(`${button('■ 停止并识别')}`);await press('■ 停止并识别');
 await until(`document.querySelector('[aria-label="语音操作预览"]')`);assert.equal(await ev(`document.querySelector('[aria-label="语音指令文字"]').value`),'暂停仿真');await press('放弃');
 await ev(`window.deferRecording=true`);await press('🎙 开始录音');await until(`window.resolveRecording`);await press('取消');
 await ev(`window.resolveRecording({id:999,recorder:'pw-record',maxSeconds:30});window.deferRecording=false`);
 await until(`window.calls.some(c=>c.command==='voice_record_cancel'&&c.args.id===999)`);
 await ev(`window.defer=true`);await press('解析指令');await until(`window.resolvePlan`);await press('取消');
 await ev(`window.resolvePlan({id:'late',createdAtMs:Date.now(),expiresAtMs:Date.now()+60000,reply:'late',actions:[{type:'stop'}]});window.defer=false`);
 await until(`!${button('解析指令')}.disabled`);assert.equal(await controlCalls(),1);
 await ev(`window.nextAction={type:'show_scene'}`);await press('解析指令');await until(`window.sceneOpened===true`);
 await ev(`window.failLLM=true`);await press('解析指令');await until(`document.querySelector('[role="alert"]')?.textContent.includes('服务不可用')`);assert.equal(await controlCalls(),1);
 assert.equal(ui.errors.length,0);console.log('Voice UI PASS: configuration, credential privacy, preview before control, edit/cancel invalidation, read actions, service failures');
}finally{await ui.close();}
