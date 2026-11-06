// Real XML backend + Chromium: comment, save, reopen and restore complete modules.
// No simulator, USB, FTP or flight controller is contacted.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), 'module-comments-'));
const name = `.module-comments-${process.pid}`;
const entry = path.join(root, 'client', `${name}.html`), module = path.join(root, 'client', `${name}.tsx`);
const rust = fileURLToPath(new URL('support/model-sync-backend.rs', import.meta.url));
await writeFile(path.join(work, 'Cargo.toml'), `[package]\nname="module-comments-backend"\nversion="0.0.0"\nedition="2021"\n[[bin]]\nname="module-comments-backend"\npath=${JSON.stringify(rust)}\n[dependencies]\nserde_json="1"\nserde={version="1",features=["derive"]}\nquick-xml={version="0.41",features=["serialize","overlapped-lists","escape-html"]}\n`);
const built = spawnSync('cargo', ['build', '--offline', '--quiet', '--manifest-path', path.join(work, 'Cargo.toml')], { encoding: 'utf8' });
assert.equal(built.status, 0, built.stderr);
const backend = (command, args) => {
  const result = spawnSync(path.join(work, 'target/debug/module-comments-backend'), { input: JSON.stringify({ command, args }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout); if (value.error) throw new Error(value.error); return value;
};
const gain = `<pure_gain name='fcs/gain' vendor='保留'><input>fcs/cmd</input><!-- 原有注释 --><gain>2</gain><vendor note='keep'>unchanged</vendor><output>fcs/scaled</output></pure_gain>`;
const source = `<?xml version="1.0"?>\r\n<fdm_config name="CommentTest"><flight_control name="Pitch"><channel name="Pitch" execute="1">\r\n  ${gain}\r\n  <fcs_function name="fcs/calc"><function><product><property>fcs/scaled</property><value>3</value></product></function></fcs_function>\r\n  <pure_gain name="fcs/servo"><input>fcs/scaled</input><gain>1</gain></pure_gain>\r\n</channel></flight_control></fdm_config>\r\n`;
const graph = backend('parse_xml', { xml: source, files: [] });
const model = graph.nodes.find(node => node.data.componentType === 'flight_control');
assert.deepEqual(JSON.parse(model.data.params.channels)[0].items.map(item => item.name), ['fcs/gain', 'fcs/calc', 'fcs/servo'], 'XML execution order is retained');
graph.xmlFiles = [{ id: 'main:test', path: 'aircraft/CommentTest/CommentTest.xml', category: 'main', originalXml: source, currentXml: source, dirty: false }];
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (request.method === 'OPTIONS') { response.end(); return; }
  let text = ''; for await (const chunk of request) text += chunk;
  try { const { command, args } = JSON.parse(text); response.end(JSON.stringify(backend(command, args))); }
  catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
await writeFile(entry, `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`);
await writeFile(module, `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import Canvas from './src/components/Canvas';import Module from './src/components/expression/ModuleExpressionCanvas';
import PropertyPanel from './src/components/PropertyPanel';import{useFlowStore}from'./src/store/flowStore';
import './src/App.css';
const graph=${JSON.stringify(graph)};window.__baseline=structuredClone(graph);useFlowStore.getState().loadProject(graph);
window.__store=useFlowStore;window.__backend=async(command,args)=>{const r=await fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})});const v=await r.json();if(v.error)throw Error(v.error);return v;};
function Harness(){const[mode,setMode]=useState('main');const[version,setVersion]=useState(0);const nodes=useFlowStore(s=>s.nodes);const node=nodes.find(n=>n.data.componentType==='flight_control');
window.__mode=m=>{setMode(m);setVersion(v=>v+1)};window.__reopen=async xml=>{const parsed=await window.__backend('parse_xml',{xml,files:[]});useFlowStore.getState().loadProject(parsed);setVersion(v=>v+1);};
return <div className="app">{mode==='main'?<div className="main-content"><Canvas dragType={null} onDragStart={()=>{}}/><PropertyPanel/></div>:<Module key={version} embedded mode="signal" title="俯仰控制 · CommentTest" modelId="comment-test"
channels={JSON.parse(node.data.params.channels)} baselineChannels={JSON.parse(window.__baseline.nodes.find(n=>n.id===node.id)?.data.params.channels||'[]')}
moduleDisabled={!!node.data.params.disabled} onChannelsChange={channels=>useFlowStore.getState().updateNodeParams(node.id,{channels:JSON.stringify(channels)})} onBack={()=>setMode('main')}/>}</div>;}
createRoot(document.getElementById('root')).render(<Harness/>);`);
const vite = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5197', '--strictPort'], { cwd: root, stdio: 'ignore' });
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${work}/chrome`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const ws = await new Promise((resolve, reject) => {
    let output=''; const timeout=setTimeout(()=>reject(Error('Chrome startup timed out')),15000);
    chrome.stderr.on('data', data=>{output+=data;const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
  });
  for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:5197/${name}.html`)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  const page=(await fetch(`http://${new URL(ws).host}/json/list`).then(r=>r.json())).find(page=>page.type==='page');
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  let sequence=0;const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data),item=pending.get(message.id);if(!item)return;clearTimeout(item.timer);pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error(`CDP timeout ${method}`)),30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async expression=>{for(let i=0;i<200;i++){if(await evaluate(`Boolean(${expression})`))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error(`UI timeout ${expression}: ${await evaluate('document.body.innerText')}`);};
  const clickMenu=label=>evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.startsWith(${JSON.stringify(label)})).click()`);
  const context=async selector=>{
    await until(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().width > 0 && ![...document.querySelectorAll('button')].some(b=>b.textContent.includes('整理中'))`);
    const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',buttons:2,clickCount:1,...point});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',buttons:0,clickCount:1,...point});
    await until('document.querySelector("[role=menu]")');
  };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,invoke:async()=>({})};`});
  await send('Emulation.setDeviceMetricsOverride',{width:1500,height:900,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:5197/${name}.html`});await until('window.__mode && document.querySelector(".aircraft-node")');
  await context('.aircraft-node');await until('document.querySelector("[role=menu]")');await clickMenu('注释模块');
  await until('document.querySelector(".aircraft-node.module-commented")');
  assert.equal(await evaluate('window.__store.getState().nodes.find(n=>n.data.componentType==="flight_control").data.params.disabled'),true);
  await context('.aircraft-node');await clickMenu('取消注释');await until('!document.querySelector(".aircraft-node.module-commented")');
  await evaluate('window.__mode("module")');await until('document.querySelectorAll(".diagram-block").length===3');
  const first='.react-flow__node[data-id="c-0-0"]';
  await context(first);await until('document.querySelector("[role=menu]")');
  await writeFile('/tmp/jsbsim-module-comment-menu.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await clickMenu('注释模块');await until('document.querySelector(".module-commented") && document.querySelector(".module-dependency-notice")');
  assert.equal(await evaluate('!!document.querySelector(".module-readonly-fields") && !document.querySelector(".module-readonly-fields input:not(:disabled)")'),true,'disabled module properties are read-only');
  assert.equal(await evaluate('[...document.querySelectorAll(".react-flow__edge-path")].some(p=>getComputedStyle(p).strokeDasharray!=="none")'),true,'disabled wires are dashed');
  const workflow=await evaluate(`(async()=>{
    const {prepareModelXml}=await import('/src/utils/modelXmlSync.ts');const {applyXmlDelta}=await import('/src/utils/xmlDelta.ts');const {commentOutXml,decodeDisabledComment}=await import('/src/utils/disabledXml.ts');const {xmlContentEqual}=await import('/src/utils/xmlContentEqual.ts');
    const baseline=window.__baseline,current=structuredClone({...baseline,nodes:window.__store.getState().nodes});
    const generators={generateXml:async data=>(await window.__backend('generate_xml',{data})).xml,generateSubfile:async(type,name,params)=>(await window.__backend('generate_subfile',{req:{type,name,params}})).xml};
    const docs=await prepareModelXml(current,baseline,'CommentTest',generators);const saved=docs.find(d=>d.category==='main').content;
    const doc=new DOMParser().parseFromString(saved,'application/xml');
    const walker=doc.createTreeWalker(doc,NodeFilter.SHOW_COMMENT);let c,payload;while(c=walker.nextNode()){const raw=decodeDisabledComment(c.nodeValue);if(raw!==null)payload=raw;}
    window.__saved=saved;window.__generators=generators;window.__disabled=current;
    const imported=await window.__backend('parse_xml',{xml:saved,files:[]});const module=imported.nodes.find(n=>n.data.componentType==='flight_control');const channels=JSON.parse(module.data.params.channels);
    const restored=structuredClone(imported);const n=restored.nodes.find(n=>n.id===module.id);const ch=JSON.parse(n.data.params.channels);ch[0].items[0].disabled=false;n.data.params.channels=JSON.stringify(ch);
    const before=await generators.generateXml(imported),after=await generators.generateXml(restored);const enabled=applyXmlDelta(saved,before,after);
    const plain=commentOutXml('<pure_gain name="x"><gain>2</gain></pure_gain>');
    return {dirty:docs.find(d=>d.category==='main').dirty,activeNames:[...doc.querySelectorAll('channel > pure_gain')].map(n=>n.getAttribute('name')),payload,disabled:channels[0].items[0].disabled,restoredExact:enabled===${JSON.stringify(source)},ordinaryCommentsEqual:xmlContentEqual('<system><!--one--></system>','<system><!--two--></system>'),disabledPayloadDiffers:!xmlContentEqual('<system>'+plain+'</system>','<system>'+commentOutXml('<pure_gain name="x"><gain>3</gain></pure_gain>')+'</system>')};
  })()`);
  assert.equal(workflow.dirty,true);assert.deepEqual(workflow.activeNames,['fcs/servo']);assert.equal(workflow.payload,gain);assert.equal(workflow.disabled,true);assert.equal(workflow.restoredExact,true);assert.equal(workflow.ordinaryCommentsEqual,true);assert.equal(workflow.disabledPayloadDiffers,true);
  const boundaries=await evaluate(`(async()=>{
    const {applyXmlDelta}=await import('/src/utils/xmlDelta.ts');const {prepareModelXml}=await import('/src/utils/modelXmlSync.ts');const {commentOutXml,decodeDisabledComment}=await import('/src/utils/disabledXml.ts');const {projectParameterChanges}=await import('/src/sim/runtimeParameters.ts');const {disabledDependencies}=await import('/src/utils/disabledGraph.ts');
    const generate=window.__generators.generateXml,base=window.__baseline;
    const nested=structuredClone(window.__disabled),n=nested.nodes.find(n=>n.data.componentType==='flight_control'),chs=JSON.parse(n.data.params.channels);chs[0].disabled=true;n.data.params.channels=JSON.stringify(chs);
    const nestedXml=applyXmlDelta(window.__saved,await generate(window.__disabled),await generate(nested));
    const nestedParsed=await window.__backend('parse_xml',{xml:nestedXml,files:[]});const nc=JSON.parse(nestedParsed.nodes.find(n=>n.data.componentType==='flight_control').data.params.channels);
    const nestedRestored=applyXmlDelta(nestedXml,await generate(nested),await generate(base));
    const main='<fdm_config name="External"><system file="Shared"/><system file="Shared"/></fdm_config>';
    const shared='<system name="Shared"><!-- keep shared bytes --><channel name="c"><pure_gain name="shared/out"><input>fcs/cmd</input><gain>2</gain></pure_gain></channel></system>';
    const original=await window.__backend('load_model',{model:'External',documents:{'aircraft/External/External.xml':main,'systems/Shared.xml':shared}});
    const changed=structuredClone(original);changed.nodes.find(n=>n.data.componentType==='system').data.params.disabled=true;
    const docs=await prepareModelXml(changed,original,'External',window.__generators);const saved=docs.find(d=>d.category==='main').content;
    const remote=await window.__backend('load_model',{model:'External',documents:{'aircraft/External/External.xml':saved,'systems/Shared.xml':shared}});
    const systems=remote.nodes.filter(n=>n.data.componentType==='system');
    const optional=await window.__backend('load_model',{model:'Missing',documents:{'aircraft/Missing/Missing.xml':'<fdm_config>'+commentOutXml('<system file="Absent"/>')+'</fdm_config>'}});
    const malformed=await fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command:'parse_xml',args:{xml:'<fdm_config><!-- jsbve-disabled:v1 encoding="base64"\\n???\\n--></fdm_config>',files:[]}})}).then(r=>r.json());
    const active=structuredClone(base),activeNode=active.nodes.find(n=>n.data.componentType==='flight_control');const ac=JSON.parse(activeNode.data.params.channels);ac[0].items[0].componentProps.gain.value='8';activeNode.data.params.channels=JSON.stringify(ac);
    const disabledNumeric=structuredClone(active);disabledNumeric.nodes.find(n=>n.id===activeNode.id).data.params.disabled=true;
    const itemNumeric=structuredClone(active),ic=JSON.parse(itemNumeric.nodes.find(n=>n.id===activeNode.id).data.params.channels);ic[0].items[0].disabled=true;itemNumeric.nodes.find(n=>n.id===activeNode.id).data.params.channels=JSON.stringify(ic);
    const channelNumeric=structuredClone(active),cc=JSON.parse(channelNumeric.nodes.find(n=>n.id===activeNode.id).data.params.channels);cc[0].disabled=true;channelNumeric.nodes.find(n=>n.id===activeNode.id).data.params.channels=JSON.stringify(cc);
    const aeroSource='<fdm_config name="Aero"><aerodynamics><axis name="LIFT"><function name="aero/k"><description>保留</description><value>2</value></function></axis></aerodynamics></fdm_config>';
    const aero=await window.__backend('parse_xml',{xml:aeroSource,files:[]}),ad=structuredClone(aero),an=ad.nodes.find(n=>n.data.componentType==='aero_coefficients'),coeff=JSON.parse(an.data.params.coefficients);coeff[0].disabled=true;an.data.params.coefficients=JSON.stringify(coeff);
    const aeroSaved=applyXmlDelta(aeroSource,await generate(aero),await generate(ad));const ar=await window.__backend('parse_xml',{xml:aeroSaved,files:[]});
    const emptySource='<fdm_config name="Empty"><flight_control name="empty"/></fdm_config>',empty=await window.__backend('parse_xml',{xml:emptySource,files:[]}),ed=structuredClone(empty);ed.nodes.find(n=>n.data.componentType==='flight_control').data.params.disabled=true;
    const emptySaved=applyXmlDelta(emptySource,await generate(empty),await generate(ed));
    let invalidSaveRejected=false;const bad=structuredClone(base);bad.xmlFiles[0].currentXml='<fdm_config><!-- jsbve-disabled:v1 encoding="base64"\\n???\\n--></fdm_config>';try{await prepareModelXml(bad,base,'CommentTest',window.__generators);}catch{invalidSaveRejected=true;}
    return {nestedChannel:nc[0].disabled,nestedItem:nc[0].items[0].disabled,nestedRestored:nestedRestored===${JSON.stringify(source)},sharedUnchanged:docs.find(d=>d.path==='systems/Shared.xml').content===shared&&!docs.find(d=>d.path==='systems/Shared.xml').dirty,activeRefs:new DOMParser().parseFromString(saved,'application/xml').querySelectorAll('system[file]').length,externalRestored:systems.length===2&&systems[0].data.params.disabled===true&&!systems[1].data.params.disabled&&JSON.parse(systems[0].data.params.channels)[0].items.length===1,optionalRestored:optional.nodes.find(n=>n.data.componentType==='system').data.params.disabled,malformedRejected:!!malformed.error,invalidSaveRejected,liveExcluded:[disabledNumeric,itemNumeric,channelNumeric].every(p=>projectParameterChanges(base,p,base).length===0),dependencies:disabledDependencies(window.__disabled.nodes).length,aeroDisabled:JSON.parse(ar.nodes.find(n=>n.data.componentType==='aero_coefficients').data.params.coefficients)[0].disabled,aeroRestored:applyXmlDelta(aeroSaved,await generate(ad),await generate(aero))===aeroSource,emptyDisabled:!new DOMParser().parseFromString(emptySaved,'application/xml').querySelector('flight_control')};
  })()`);
  assert.equal(boundaries.nestedChannel,true);assert.equal(boundaries.nestedItem,true);assert.equal(boundaries.nestedRestored,true);assert.equal(boundaries.sharedUnchanged,true);assert.equal(boundaries.activeRefs,1);assert.equal(boundaries.externalRestored,true);assert.equal(boundaries.optionalRestored,true);assert.equal(boundaries.malformedRejected,true);assert.equal(boundaries.liveExcluded,true);assert.equal(boundaries.dependencies,2);
  assert.equal(boundaries.aeroDisabled,true);assert.equal(boundaries.aeroRestored,true);assert.equal(boundaries.emptyDisabled,true);assert.equal(boundaries.invalidSaveRejected,true);
  await context(first);await writeFile('/tmp/jsbsim-module-commented.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await clickMenu('取消注释');await until('!document.querySelector(".module-commented")');
  await context(first);await clickMenu('注释所在通道');await until('document.querySelectorAll(".module-commented").length===3');
  await context(first);assert.equal(await evaluate('[...document.querySelectorAll("[role=menuitem]")].find(b=>b.textContent.startsWith("注释模块")).disabled'),true);
  await clickMenu('取消所在通道');await until('!document.querySelector(".module-commented")');
  await evaluate('window.__reopen(window.__saved)');await until('document.querySelector(".module-commented")');
  await context(first);await clickMenu('取消注释');await until('!document.querySelector(".module-commented")');
  console.log('PASS: main/module context menus, gray nodes and wires, dependency notices, channel disable/restore, real Rust XML import/generation, UTF-8/nested comments, exact source restoration, marked-comment comparison and reopen/restore');
} finally {
  socket?.close();chrome.kill('SIGTERM');vite.kill('SIGTERM');server.close();
  await Promise.all([rm(entry,{force:true}),rm(module,{force:true}),rm(work,{recursive:true,force:true,maxRetries:10,retryDelay:100})]);
}
