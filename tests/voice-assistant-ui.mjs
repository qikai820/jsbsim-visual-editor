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
import PropertyPanel from'./src/components/PropertyPanel';
import RuntimeTuningPanel from'./src/components/RuntimeTuningPanel';
import{useFlowStore}from'./src/store/flowStore';
window.config={enabled:false,llmProtocol:'ollama',llm:{baseUrl:'http://127.0.0.1:11434',apiKey:'',model:'qwen3:4b'},jsonMode:true,asrProtocol:'openai',asr:{baseUrl:'http://127.0.0.1:8178/v1',apiKey:'',model:'small'},language:'zh',recorder:'auto',inputDevice:'',maxRecordSeconds:30,speakReplies:false,tts:{baseUrl:'http://127.0.0.1:8179/v1',apiKey:'',model:'tts-1'},ttsVoice:'default',timeoutSeconds:90};
window.sim={external:true,local:true,connected:true,running:true,paused:false,model:'ball',state:'running'};window.nextAction={type:'pause'};window.voiceId=0;
window.native=async(command,args)=>{window.calls.push({command,args});if(command==='voice_config_get')return{config:window.config,capabilities:{platform:'linux',recorders:['pw-record']}};if(command==='voice_config_save'){window.config=args.config;return args.config;}if(command==='voice_record_start'){if(window.deferRecording)return await new Promise(resolve=>{window.resolveRecording=resolve;});return{id:++window.voiceId,recorder:'pw-record',maxSeconds:30};}if(command==='voice_record_cancel'||command==='voice_cancel')return null;if(command==='voice_transcribe')return '暂停仿真';if(command==='sim_status')return {...window.sim};if(command==='simulator_network_target_get')return '127.0.0.1';if(command==='sim_list_models')return{models:[{name:'ball'},{name:'F450_PX4'}]};if(command==='sim_list_tests')return{tests:[{file:'F450_PX4_lan.xml'}]};if(command==='voice_interpret'){if(window.defer)return await new Promise(resolve=>{window.resolvePlan=resolve;});if(window.failLLM)throw Error('大模型服务不可用');return{id:args.requestId,createdAtMs:Date.now(),expiresAtMs:Date.now()+60000,reply:'准备暂停',actions:[window.nextAction]};}if(command==='sim_pause'){window.sim={...window.sim,paused:true,state:'paused'};return{running:true,paused:true};}throw Error(command);};
const host={binding:()=>({instance:'01',selectedModel:'ball',busy:false}),selectModel:async()=>{},syncModel:async()=>false,openToolbox:()=>{},showScene:()=>{window.sceneOpened=true;},showLogs:()=>{}};
window.flow=useFlowStore;
const node=(id,componentType,label,params)=>({id,type:'aircraftNode',position:{x:0,y:0},data:{componentType,label,params}});
useFlowStore.getState().loadProject({aircraft:{name:'ball',version:'2.0',release:'PRODUCTION'},edges:[],nodes:[
 node('mass','fuselage','机身',{emptywt:{value:6,unit:'LBS'}}),
 node('tensor','inertia','惯量',{ixx:4,iyy:8,izz:10,ixy:0,ixz:0,iyz:0}),
 node('atmosphere','environment','环境',{wind_east_fps:2,wind_north_fps:1,wind_down_fps:0,wind_profile:{active:1}}),
 node('wing-a','wing','左机翼',{wingarea:2}),node('wing-b','wing','右机翼',{wingarea:3})
]});
const simulationNative=window.native;
window.native=async(command,args)=>{
 if(command==='sim_runtime_snapshot'||command==='sim_runtime_apply'){
  if(command==='sim_runtime_apply')window.calls.push({command,args});
  return{model:'ball',state:'running',timestamp:1,age_ms:0,tuning:{version:2,session:'0000000000000001',request:0,status:'applied',values:[],parameters:2,inertia:true}};
 }
 if(command==='voice_transcribe'&&window.transcript){window.calls.push({command,args});return window.transcript;}
 return simulationNative(command,args);
};
createRoot(document.getElementById('root')).render(<><Voice open={true} onClose={()=>{}} host={host}/><PropertyPanel/><RuntimeTuningPanel/></>);`;
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
 assert.equal(await ev(`window.calls.some(c=>['voice_interpret','sim_list_models','sim_list_tests'].includes(c.command))`),false);
 await press('🎙 开始录音');await until(`window.calls.some(c=>c.command==='voice_record_start')`);await until(`${button('■ 停止并识别')}`);
 await press('取消');await until(`window.calls.some(c=>c.command==='voice_record_cancel')`);assert.equal(await ev(`window.calls.some(c=>c.command==='voice_transcribe')`),false);
 await press('🎙 开始录音');await until(`${button('■ 停止并识别')}`);await press('■ 停止并识别');
 await until(`document.querySelector('[aria-label="语音操作预览"]')`);assert.equal(await ev(`document.querySelector('[aria-label="语音指令文字"]').value`),'暂停仿真');await press('放弃');
 await ev(`window.deferRecording=true`);await press('🎙 开始录音');await until(`window.resolveRecording`);await press('取消');
 await ev(`window.resolveRecording({id:999,recorder:'pw-record',maxSeconds:30});window.deferRecording=false`);
 await until(`window.calls.some(c=>c.command==='voice_record_cancel'&&c.args.id===999)`);
 const type=async text=>{await ev(`window.change(document.querySelector('[aria-label="语音指令文字"]'),${JSON.stringify(text)})`);await press('解析指令');};
 await ev(`window.defer=true`);await type('帮我处理一下仿真运行安排');await until(`window.resolvePlan`);await press('取消');
 await ev(`window.resolvePlan({id:'late',createdAtMs:Date.now(),expiresAtMs:Date.now()+60000,reply:'late',actions:[{type:'stop'}]});window.defer=false`);
 await until(`!${button('解析指令')}.disabled`);assert.equal(await controlCalls(),1);
 await ev(`window.failLLM=true`);await press('解析指令');await until(`document.querySelector('[role="alert"]')?.textContent.includes('服务不可用')`);assert.equal(await controlCalls(),1);
 await ev(`window.calls.length=0`);
 await type('请打开三维视景');await until(`window.sceneOpened===true`);
 assert.equal(await ev(`window.calls.length`),0);
 await type('查询当前访真状态');await until(`document.querySelector('[aria-label="语音执行结果"]')?.textContent.includes('已暂停')`);
 assert.deepEqual(await ev(`window.calls.map(c=>c.command)`),['sim_status']);
 await ev(`window.calls.splice(0,1)`);
 await type('列出当前可用的仿真模型');await until(`document.querySelector('[aria-label="语音执行结果"]')?.textContent.includes('F450_PX4')`);
 assert.deepEqual(await ev(`window.calls.map(c=>c.command)`),['sim_status','sim_list_models']);

 const speechPreview=`document.querySelector('[aria-label="参数修改预览"]')`;
 const param=(id,key)=>ev(`window.flow.getState().nodes.find(node=>node.id===${JSON.stringify(id)}).data.params[${JSON.stringify(key)}]`);
 const modelCalls=await ev(`window.calls.filter(c=>c.command==='voice_interpret').length`);
 const runtimeEdits=`window.calls.filter(call=>call.command==='sim_runtime_apply').map(call=>call.args.edits)`;
 await type('确认修改');await until(`document.querySelector('[role="alert"]')?.textContent.includes('没有待确认')`);
 await ev(`window.transcript='把空气质量改成3.2千克。'`);
 const transcribe=async()=>{await press('🎙 开始录音');await until(`${button('■ 停止并识别')}`);await press('■ 停止并识别');};
 await transcribe();await until(`document.querySelector('[role="alert"]')?.textContent.includes('先选中机身')`);
 await ev(`window.flow.getState().setSelectedNode('mass')`);
 await transcribe();await until(`${speechPreview}?.textContent.includes('将识别出的“空气质量”解析为空重')`);
 assert.deepEqual(await param('mass','emptywt'),{value:6,unit:'LBS'});
 await press('放弃');
 await type('这个模块有哪些参数');await until(`document.querySelector('.voice-reply')?.textContent.includes('空重 6 LBS')`);
 await type('把空机质量改成3.2米');await until(`document.querySelector('[role="alert"]')?.textContent.includes('不能使用单位')`);
 await type('把空机质量改成三点二千克');await until(`${speechPreview}?.textContent.includes('3.2 KG')`);
 assert.deepEqual(await param('mass','emptywt'),{value:6,unit:'LBS'});
 await press('确认修改');await until(`document.querySelector('[aria-label="语音执行结果"]')?.textContent.includes('编辑器草稿')`);
 assert.ok(Math.abs((await param('mass','emptywt')).value-3.2*2.20462)<1e-10);
 await until(`Math.abs(Number(document.querySelector('input[aria-label="空重"]')?.value)-${3.2*2.20462})<.001`);
 assert.deepEqual(await ev(runtimeEdits),[]);

 await type('把空重改成两千克');await until(speechPreview);
 await ev(`window.flow.getState().setSelectedNode('tensor')`);
 await press('确认修改');await until(`document.querySelector('[role="alert"]')?.textContent.includes('已变化')`);
 assert.ok(Math.abs((await param('mass','emptywt')).value-3.2*2.20462)<1e-10);

 await type('把翼面积改成一平方米');await until(`document.querySelector('[role="alert"]')?.textContent.includes('多个匹配模块')`);
 await ev(`window.flow.getState().setSelectedNode('wing-b')`);
 await type('把翼面积改成一平方米');await until(`${speechPreview}?.textContent.includes('右机翼')`);
 await press('放弃');assert.equal(await param('wing-b','wingarea'),3);

 await ev(`window.flow.getState().setSelectedNode('tensor')`);
 await type('把滚转惯量增加百分之十');await until(`${speechPreview}?.textContent.includes('4.4')`);
 assert.equal(await param('tensor','ixx'),4);
 await ev(`(()=>{window.flow.getState().updateNodeParams('mass',{emptywt:{value:8,unit:'LBS'}});${button('确认修改')}.click();})()`);
 await until(`${runtimeEdits}.length===1`);
 assert.equal(await param('tensor','ixx'),4.4);
 assert.deepEqual((await ev(runtimeEdits))[0],[{key:'_tuning/mass/emptywt',value:8}]);
 await ev(`window.flow.getState().updateNodeParams('tensor',{iyy:12})`);await until(`${runtimeEdits}.length===2`);
 assert.equal((await ev(runtimeEdits))[1].find(edit=>edit.key.includes('/ixx-')).value,4);
 assert.equal((await ev(runtimeEdits))[1].find(edit=>edit.key.includes('/iyy-')).value,12);

 await type('把东向风速改成每秒五米');await until(`${speechPreview}?.textContent.includes('关闭此草稿中的波形风场')`);
 assert.equal((await param('atmosphere','wind_profile')).active,1);
 await ev(`window.transcript='确认修改'`);await transcribe();
 await until(`document.querySelector('[aria-label="语音执行结果"]')?.textContent.includes('东向风')`);
 assert.ok(Math.abs(await param('atmosphere','wind_east_fps')-5*3.28084)<1e-10);
 assert.equal((await param('atmosphere','wind_profile')).active,0);
 assert.equal(await ev(`window.calls.filter(c=>c.command==='voice_interpret').length`),modelCalls);
 assert.equal(await controlCalls(),0);
 await ev(`(()=>{const {aircraft,nodes,edges,subFiles,xmlFiles,loadProject}=window.flow.getState();
   loadProject(JSON.parse(JSON.stringify({aircraft,nodes,edges,subFiles,xmlFiles})));})()`);
 assert.equal(await param('tensor','ixx'),4.4);
 assert.ok(Math.abs(await param('atmosphere','wind_east_fps')-5*3.28084)<1e-10);
 assert.equal(ui.errors.length,0);console.log('Voice UI PASS: configuration, credential privacy, preview before control, edit/cancel invalidation, read actions, service failures');
 console.log('Voice parameter UI PASS: offline queries, units, ambiguity, stale preview, project data round trip, spoken confirmation and isolated runtime batches');
}finally{await ui.close();}
