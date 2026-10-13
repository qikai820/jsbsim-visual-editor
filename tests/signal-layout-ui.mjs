// Real React Flow component regression using H7 XML signal dependencies.
// Desktop IPC is not involved; no model files or application profile are written.
// Usage: node --experimental-websocket tests/signal-layout-ui.mjs [Vite URL]
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const baseUrl = process.argv[2] || 'http://127.0.0.1:5179';
const xml = await readFile(new URL('../../jsbsim_realtime/data/aviation/aircraft/H7/H7_Viztra.xml', import.meta.url), 'utf8');
const entry = new URL('../client/.signal-layout-test.html', import.meta.url);
const module = new URL('../client/.signal-layout-test.tsx', import.meta.url);
const galleryModule = new URL('../client/.signal-symbol-gallery.tsx', import.meta.url);
const galleryEntry = new URL('../client/.signal-symbol-gallery.html', import.meta.url);
await writeFile(entry, '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/.signal-layout-test.tsx"></script></body></html>');
await writeFile(module, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ModuleExpressionCanvas from './src/components/expression/ModuleExpressionCanvas';
import { buildSignalGraph } from './src/utils/signalGraph';
import './src/App.css';
const doc = new DOMParser().parseFromString(${JSON.stringify(xml)}, 'application/xml');
// Layout uses the operator symbol and property references; keep every reference
// in XML order, including duplicates, without evaluating or rewriting the XML.
const item = e => e.tagName === 'function' ? {
  type: 'function', name: e.getAttribute('name'), expression: {
    kind: [...e.children].find(c => c.tagName !== 'description')?.tagName,
    children: [...e.querySelectorAll('property')].map(p => ({kind: 'property', name: p.textContent.trim()}))
  }
} : {type: e.tagName, name: e.getAttribute('name'), componentProps: Object.fromEntries([...e.children].map(c => [c.tagName, {value: c.textContent.trim(), attrs: {}}]))};
const channels = [...doc.documentElement.children].filter(e => e.tagName === 'channel').map(c => ({name: c.getAttribute('name'), items: [...c.children].map(item)}));
channels.push({name: 'System functions', items: [...doc.documentElement.children].filter(e => e.tagName === 'function').map(item)});
const original = buildSignalGraph(channels);
window.__graph = original;
window.__changes = 0;
window.__saved = Object.fromEntries(original.nodes.map(n => [n.id, n.position]));
window.__mount = () => createRoot(document.getElementById('root')).render(<ModuleExpressionCanvas mode="signal" embedded title="H7_Viztra.xml · 系统信号流" channels={channels} initialLayout={window.__saved} onBack={() => {}} onChannelsChange={() => window.__changes++} onLayoutChange={layout => {window.__saved=layout; window.__saveCount=(window.__saveCount||0)+1;}} />);
window.__mount();
`);
const profile = await mkdtemp(path.join(tmpdir(), 'jsbsim-import-ui-'));
const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
    let output = '';
    chrome.stderr.on('data', data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}`)); });
  });
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    const targets = await fetch(`http://${new URL(endpoint).host}/json/list`).then(response => response.json());
    page = targets.find(target => target.type === 'page');
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Chrome page target is available');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if(message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') console.error(message.params.args.map(a => a.description || a.value));
    if(message.method === 'Runtime.exceptionThrown') console.error(message.params.exceptionDetails);
    if (pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer); pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
    }
  });
  function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression) {
    for (let i = 0; i < 100; i++) {
      try {
        const result = await evaluate(`Boolean(${expression})`);
        if (result) return result;
      } catch (error) {
        // Vite can finish its fixture reload just after Page.reload. Retry
        // read-only readiness checks while that execution context changes.
        if (!/Inspected target navigated|Execution context was destroyed|Cannot find context/.test(String(error))) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI timeout: ${expression}\nAlerts: ${JSON.stringify(await evaluate('window.__alerts'))}\nCalls: ${JSON.stringify(await evaluate('window.__calls || []'))}\n${await evaluate('document.body.innerText')}`);
  }
  await send('Page.enable');
  await send('Runtime.enable');

  await send('Emulation.setDeviceMetricsOverride', {width:1920,height:1200,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate', {url:baseUrl+'/.signal-layout-test.html'});
  await until('document.querySelectorAll(".react-flow__node").length > 50');
  await new Promise(r=>setTimeout(r,700));
  const screenshot = async name => { const {data}=await send('Page.captureScreenshot',{format:'png'}); await writeFile('/tmp/'+name,Buffer.from(data,'base64')); };
  const metrics = () => evaluate(`(() => {
    const ns = [...document.querySelectorAll('.react-flow__node')].map(n=>({id:n.dataset.id,w:n.offsetWidth,h:n.offsetHeight,...window.__saved[n.dataset.id]}));
    const bounds={w:Math.max(...ns.map(n=>n.x+n.w))-Math.min(...ns.map(n=>n.x)),h:Math.max(...ns.map(n=>n.y+n.h))-Math.min(...ns.map(n=>n.y))};
    const overlaps=[];
    for(let i=0;i<ns.length;i++)for(let j=i+1;j<ns.length;j++){const a=ns[i],b=ns[j];if(a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h)overlaps.push([a.id,b.id]);}
    return {nodes:ns,bounds,overlaps,edgeCount:document.querySelectorAll('.react-flow__edge').length,routes:window.__saved.__elkRoutes,changes:window.__changes};
  })()`);
  const before = await metrics();
  await screenshot('signal-layout-before.png');
  await evaluate('document.querySelector(".expr-layout-btn").click()');
  await until('window.__saved.__elkRoutes && !document.querySelector(".expr-layout-btn").disabled');
  await until('!document.querySelector("[role=status]")');
  await new Promise(r=>setTimeout(r,700));
  const after = await metrics();
  assert.equal(await evaluate('[...document.querySelectorAll(".react-flow__edge-path")].filter(p => p.getAttribute("d").includes(",")).length'),0,'Renderer uses computed routes');
  await screenshot('signal-layout-after.png');
  assert.equal(after.nodes.length,before.nodes.length);
  assert.equal(after.edgeCount,before.edgeCount);
  assert.equal(after.changes,0,'Layout must not edit model data');
  assert.deepEqual(after.overlaps,[],'No node overlaps');
  assert.equal(Object.keys(after.routes).length,after.edgeCount,'All wires routed');
  const graph = await evaluate('window.__graph');
  const checkInputCoverage = ()=>evaluate(`(() => {
    const missing=[];
    for(const node of window.__graph.nodes)for(const [i,signal] of (node.data.inputs||[]).entries()){
      if(!signal)continue;
      const edges=window.__graph.edges.filter(e=>e.target===node.id&&e.targetHandle==='in-'+i);
      if(edges.length!==1||edges[0].data.signal!==signal||
        ![...document.querySelectorAll('.react-flow__edge')].some(el=>el.dataset.id===edges[0].id&&el.querySelector('.react-flow__edge-path')))missing.push([node.id,i,signal]);
    }
    return missing;
  })()`);
  assert.deepEqual(await checkInputCoverage(),[],'Every declared input occurrence has a visible terminal wire, including repeated signals');
  const pitch=graph.nodes.find(n=>n.data.name==='px4/viztra/camera-pitch-rad');
  assert.equal(pitch.data.inputs.length,4);
  assert.equal(graph.edges.filter(e=>e.target===pitch.id).length,4,'Camera pitch has four connected inputs although it only uses three distinct signals');
  const fanout = await evaluate(`(async()=>{
    const {mergeSignalBranches}=await import('/src/utils/mergeSignalBranches.ts');
    const {signalRouteIsClear,signalObstacles}=await import('/src/utils/signalClearance.ts');
    const nodes=[{id:'src',position:{x:0,y:300},width:64,height:48},...[0,1,2].map(i=>({id:'dst'+i,position:{x:300,y:i*100},width:64,height:48}))];
    const edges=[0,1,2].map(i=>({id:'branch'+i,source:'src',sourceHandle:'out',target:'dst'+i,data:{elkRoute:{points:[{x:70,y:324},{x:100+i*16,y:324},{x:100+i*16,y:24+i*100},{x:294,y:24+i*100}],junctions:[]}}}));
    const before=structuredClone(edges);
    mergeSignalBranches(edges,nodes);
    const vertical=new Set(edges.flatMap(e=>e.data.elkRoute.points.slice(1).flatMap((p,i)=>{
      const a=e.data.elkRoute.points[i];return Math.abs(a.x-p.x)<.05&&Math.abs(a.y-p.y)>50?[p.x]:[];
    })));
    return {tracks:[...vertical],clear:edges.every(e=>signalRouteIsClear(e.data.elkRoute.points,e,signalObstacles(nodes))),
      endpoints:edges.every((e,i)=>JSON.stringify([e.data.elkRoute.points[0],e.data.elkRoute.points.at(-1)])===JSON.stringify([before[i].data.elkRoute.points[0],before[i].data.elkRoute.points.at(-1)]))};
  })()`);
  assert.deepEqual(fanout.tracks,[100],'Three parallel copies of the same signal collapse to one trunk');
  assert.ok(fanout.clear&&fanout.endpoints,'Merged fanout preserves keepouts and exact endpoints');
  await writeFile('/tmp/signal-routes.json',JSON.stringify({graph,after}));
  const obstacles=[];
  for(const [id,route] of Object.entries(after.routes)){
    const edge=graph.edges.find(e=>e.id===id);
    for(let i=1;i<route.points.length;i++){
      const a=route.points[i-1],b=route.points[i];
      assert.ok(Math.abs(a.x-b.x)<0.01||Math.abs(a.y-b.y)<0.01,'Orthogonal wire '+id);
      for(const n of after.nodes){
        if(n.id===edge.source||n.id===edge.target)continue;
        if(Math.abs(a.x-b.x)<0.01 ? a.x>n.x+1&&a.x<n.x+n.w-1&&Math.max(a.y,b.y)>n.y+1&&Math.min(a.y,b.y)<n.y+n.h-1 : a.y>n.y+1&&a.y<n.y+n.h-1&&Math.max(a.x,b.x)>n.x+1&&Math.min(a.x,b.x)<n.x+n.w-1)obstacles.push([id,n.id]);
      }
    }
  }
  assert.deepEqual(obstacles,[],'Wires avoid unrelated nodes');
  const checkClearance = ()=>evaluate(`(async()=>{
    const {signalRouteIsClear}=await import('/src/utils/signalClearance.ts');
    const obstacles=[...document.querySelectorAll('.react-flow__node')].map(n=>({id:n.dataset.id,width:n.offsetWidth,height:n.offsetHeight,...window.__saved[n.dataset.id]}));
    return window.__graph.edges.filter(e=>!signalRouteIsClear(window.__saved.__elkRoutes[e.id].points,e,obstacles)).map(e=>e.id);
  })()`);
  assert.deepEqual(await checkClearance(),[],'12-unit keepout excludes all wires except their own terminal leads');
  assert.equal(await evaluate('document.querySelectorAll(".react-flow__edge-path").length'),after.edgeCount,'Every routed wire remains visible');
  const keepoutCases=await evaluate(`(async()=>{
    const {signalRouteIsClear:clear}=await import('/src/utils/signalClearance.ts');
    const source={id:'a',x:0,y:0,width:64,height:48},target={id:'b',x:160,y:0,width:64,height:48};
    const edge={source:'a',target:'b'}, direct=[{x:70,y:24},{x:154,y:24}];
    return [clear(direct,edge,[source,target]),
      clear(direct,edge,[source,target,{id:'foreign',x:100,y:30,width:24,height:24}]),
      clear([{x:70,y:24},{x:90,y:24},{x:90,y:-6},{x:50,y:-6},{x:50,y:-20},{x:142,y:-20},{x:142,y:24},{x:154,y:24}],edge,[source,target]),
      clear([{x:70,y:24},{x:90,y:24},{x:90,y:-12},{x:142,y:-12},{x:142,y:24},{x:154,y:24}],edge,[source,target])];
  })()`);
  assert.deepEqual(keepoutCases,[true,false,false,true],'Only own terminal leads are exempt; the clearance boundary is allowed');
  const overlaps=[];
  const routed=Object.entries(after.routes);
  for(let i=0;i<routed.length;i++)for(let j=i+1;j<routed.length;j++){
    const [idA,ra]=routed[i],[idB,rb]=routed[j];
    const ea=graph.edges.find(e=>e.id===idA),eb=graph.edges.find(e=>e.id===idB);
    if(ea.source===eb.source&&ea.sourceHandle===eb.sourceHandle)continue;
    for(let k=1;k<ra.points.length;k++)for(let l=1;l<rb.points.length;l++){
      const a=ra.points[k-1],b=ra.points[k],c=rb.points[l-1],d=rb.points[l];
      const vertical=Math.abs(a.x-b.x)<.01&&Math.abs(c.x-d.x)<.01&&Math.abs(a.x-c.x)<.01;
      const horizontal=Math.abs(a.y-b.y)<.01&&Math.abs(c.y-d.y)<.01&&Math.abs(a.y-c.y)<.01;
      const axis=vertical?'y':'x';
      if((vertical||horizontal)&&Math.min(Math.max(a[axis],b[axis]),Math.max(c[axis],d[axis]))-Math.max(Math.min(a[axis],b[axis]),Math.min(c[axis],d[axis]))>0.1)overlaps.push([idA,idB]);
    }
  }
  assert.deepEqual(overlaps,[],'Distinct signals never share a line segment');
  const duplicateTrunks=[];
  for(let i=0;i<routed.length;i++)for(let j=i+1;j<routed.length;j++){
    const [idA,ra]=routed[i],[idB,rb]=routed[j];
    const ea=graph.edges.find(e=>e.id===idA),eb=graph.edges.find(e=>e.id===idB);
    if(ea.source!==eb.source||ea.sourceHandle!==eb.sourceHandle)continue;
    for(let k=1;k<ra.points.length;k++)for(let l=1;l<rb.points.length;l++){
      // Distinct input ports on one block require separate terminal leads;
      // these short branches are not duplicate trunks.
      if(ea.target===eb.target&&ea.targetHandle!==eb.targetHandle&&k===ra.points.length-1&&l===rb.points.length-1)continue;
      const a=ra.points[k-1],b=ra.points[k],c=rb.points[l-1],d=rb.points[l];
      for(const [axis,along] of [['x','y'],['y','x']]){
        const gap=Math.abs(a[axis]-c[axis]);
        if(Math.abs(a[axis]-b[axis])<.05&&Math.abs(c[axis]-d[axis])<.05&&gap>.05&&gap<40&&
          Math.min(Math.max(a[along],b[along]),Math.max(c[along],d[along]))-Math.max(Math.min(a[along],b[along]),Math.min(c[along],d[along]))>48)duplicateTrunks.push([idA,idB]);
      }
    }
  }
  assert.deepEqual(duplicateTrunks,[],'H7 has no adjacent duplicate trunks for the same signal');
  const checkAlignment=()=>evaluate(`(() => {
    const errors=[];
    const root=document.querySelector('.react-flow').getBoundingClientRect();
    const matrix=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
    for(const edge of window.__graph.edges){
      const route=window.__saved.__elkRoutes[edge.id];
      for(const side of ['source','target']){
        const n=[...document.querySelectorAll('.react-flow__node')].find(n=>n.dataset.id===edge[side]);
        const h=[...n.querySelectorAll('.react-flow__handle')].find(h=>h.dataset.handleid===edge[side+'Handle']);
        const r=h.getBoundingClientRect(),p=side==='source'?route.points[0]:route.points.at(-1);
        const x=((side==='source'?r.right:r.left)-root.x-matrix.e)/matrix.a;
        const y=(r.y+r.height/2-root.y-matrix.f)/matrix.d;
        if(Math.hypot(p.x-x,p.y-y)>.2)errors.push([edge.id,side,p,{x,y}]);
      }
    }
    for(const n of document.querySelectorAll('.diagram-block')){
      const r=n.getBoundingClientRect(),c=n.querySelector('.diagram-symbol-center').getBoundingClientRect();
      if(Math.hypot(r.x+r.width/2-c.x-c.width/2,r.y+r.height/2-c.y-c.height/2)>.1)errors.push('symbol off centre');
    }
    return errors;
  })()`);
  const alignment=await checkAlignment();
  assert.deepEqual(alignment,[],'Wire ends match visible ports and symbols are centered');
  assert.ok(after.bounds.w*after.bounds.h < before.bounds.w*before.bounds.h*0.6,'Materially smaller diagram');
  // Reload with the exact persisted positions and automatic paths.
  const saved=await evaluate('window.__saved');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.__restore='+JSON.stringify(saved)});
  await writeFile(module,(await readFile(module,'utf8')).replace('window.__mount();','window.__saved = window.__restore || window.__saved; window.__mount();'));
  await send('Page.reload');
  await until('window.__saved?.__elkRoutes && document.querySelectorAll(".react-flow__node").length > 50');
  await new Promise(r=>setTimeout(r,700));
  const restored=await metrics();
  assert.deepEqual(restored.nodes,after.nodes,'All block and endpoint positions survive reload');
  assert.deepEqual(restored.routes,after.routes,'Automatic paths survive reload');
  // Resize an actual five-input block, persist it, then restore automatic size.
  const resizeId='c-1-0';
  const nodeRect=async()=>evaluate(`(() => {const n=[...document.querySelectorAll('.react-flow__node')].find(n=>n.dataset.id===${JSON.stringify(resizeId)}); const r=n.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,width:n.offsetWidth,height:n.offsetHeight};})()`);
  const click=async p=>{await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});};
  const originalSize=await nodeRect();
  await click({x:originalSize.x+originalSize.w/2,y:originalSize.y+originalSize.h/2});
  await until('document.querySelector(".react-flow__resize-control.bottom.right.handle")');
  const grip=await evaluate(`(() => {const r=document.querySelector('.react-flow__resize-control.bottom.right.handle').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...grip,button:'left',clickCount:1});
  for(let i=1;i<=5;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:grip.x+i*12,y:grip.y+i*10,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:grip.x+60,y:grip.y+50,button:'left',clickCount:1});
  await until('window.__saved.__sizes?.["c-1-0"] && !document.querySelector("[role=status]")');
  const resized=await nodeRect();
  assert.deepEqual(await checkAlignment(),[],'Resized block ports remain connected');
  assert.deepEqual(await checkClearance(),[],'Resizing updates the keepout');
  // NodeResizer snaps in flow units. At the restored 1.4x zoom, a 50px
  // screen drag can legitimately produce one 20-unit grid step in height.
  assert.ok(resized.width>=originalSize.width+20 && resized.height>=originalSize.height+20,'Drag grows both dimensions by at least one grid step '+JSON.stringify({originalSize,resized}));
  const resizeSaved=await evaluate('window.__saved');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.__restore='+JSON.stringify(resizeSaved)});
  await send('Page.reload');
  await until('document.querySelectorAll(".diagram-block").length > 30 && !document.querySelector("[role=status]")');
  await new Promise(r=>setTimeout(r,700));
  const reloadedSize=await nodeRect();
  assert.equal(reloadedSize.width,resized.width,'Manual width survives reload');
  assert.equal(reloadedSize.height,resized.height,'Manual height survives reload');
  await click({x:reloadedSize.x+reloadedSize.w/2,y:reloadedSize.y+reloadedSize.h/2});
  await until('document.querySelector(".diagram-auto-size")');
  await screenshot('signal-block-resized.png');
  await evaluate('document.querySelector(".diagram-auto-size").click()');
  await until('!window.__saved.__sizes?.["c-1-0"] && !document.querySelector("[role=status]")');
  const automaticSize=await nodeRect();
  assert.deepEqual(await checkAlignment(),[],'Automatic size keeps ports connected');
  assert.equal(automaticSize.width,originalSize.width,'Automatic width restored');
  assert.equal(automaticSize.height,originalSize.height,'Automatic port spacing restored');
  const signalEndpoint=after.nodes.find(n=>n.id.startsWith('src-'));
  const point=await evaluate(`(() => {const n=[...document.querySelectorAll('.react-flow__node')].find(n=>n.dataset.id===${JSON.stringify(signalEndpoint.id)});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+50,y:point.y+40,button:'left',buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+50,y:point.y+40,button:'left',clickCount:1});
  await until(`window.__saved[${JSON.stringify(signalEndpoint.id)}].x !== ${signalEndpoint.x}`);
  await until('window.__saved.__elkRoutes && !document.querySelector("[role=status]")');
  assert.equal(await evaluate('Object.keys(window.__saved.__elkRoutes).length'),after.edgeCount,'Dragging automatically reroutes every wire');
  assert.deepEqual(await checkClearance(),[],'Dragging updates the keepout');
  assert.deepEqual(await checkInputCoverage(),[],'Graph rebuild after dragging preserves every repeated input terminal');
  await evaluate('document.querySelector(".expr-layout-btn").click()');
  await until('window.__saved.__elkRoutes && !document.querySelector(".expr-layout-btn").disabled');
  // A new canvas waits for DOM measurements before automatic layout.
  await writeFile(module,(await readFile(module,'utf8')).replace('initialLayout={window.__saved}','initialLayout={undefined}'));
  await send('Page.reload');
  await until('window.__saveCount > 0 && window.__saved.__elkRoutes && !document.querySelector(".expr-layout-btn").disabled');
  assert.equal(await evaluate('Boolean(document.querySelector("[role=status]"))'),false,'Fresh canvas automatically arranges');
  console.log(JSON.stringify({before:before.bounds,after:after.bounds,nodes:after.nodes.length,edges:after.edgeCount,overlaps:after.overlaps.length,obstacles:obstacles.length,restored:true,dragged:true,automatic:true,resized:true,distinctSignalOverlaps:overlaps.length,portAlignmentErrors:alignment.length},null,2));
  const gallery = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlow,ReactFlowProvider,Background} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './src/App.css';
import SignalBlockNode from './src/components/expression/SignalBlockNode';
import SignalEndNode from './src/components/expression/SignalEndNode';
import SignalEdge from './src/components/expression/SignalEdge';
const entries=[['sum','求和'],['difference','减法'],['product','乘法'],['quotient','除法'],['pow','幂运算'],['sqrt','平方根'],['abs','绝对值'],
['integrator','积分'],['lag_filter','一阶滤波'],['lead_lag_filter','超前滞后'],['washout_filter','洗出滤波'],['pid','PID 控制'],['pure_gain','增益'],['table','查表'],
['sin','正弦'],['cos','余弦'],['tan','正切'],['atan2','反正切'],['exp','指数'],['min','最小值'],['max','最大值'],
['gt','大于'],['le','小于等于'],['eq','相等'],['and','逻辑与'],['or','逻辑或'],['not','逻辑非'],['switch','开关'],
['toradians','角度转弧度'],['todegrees','弧度转角度'],['deadband','死区'],['aerosurface_scale','限幅映射'],['sensor','传感器'],['gyro','陀螺仪'],['constant','常量']];
const nodes=entries.flatMap(([kind,label],i)=>{
const x=140+(i%7)*175,y=330+Math.floor(i/7)*132;
const direct=['integrator','lag_filter','lead_lag_filter','washout_filter','pid','pure_gain','deadband','aerosurface_scale','sensor','gyro','constant'].includes(kind);
return [{id:'sample-'+kind,type:'signalBlock',position:{x,y},data:{itemType:direct?kind:'function',expression:{kind},inputs:Array.from({length:kind==='constant'?0:kind==='switch'?3:['sum','difference','product','quotient','pow','atan2','min','max','gt','le','eq','and','or','table'].includes(kind)?2:1},(_,i)=>String(i)),compProps:{gain:{value:'2.5'},constant:{value:'10'}},name:label}},
{id:'label-'+kind,type:'legend',position:{x:x-18,y:y+70},data:{label}}];});
nodes.push({id:'source-a',type:'signalEnd',position:{x:195,y:104},data:{signalRole:'source',signalName:'signal-a'}},
{id:'source-b',type:'signalEnd',position:{x:195,y:166},data:{signalRole:'source',signalName:'signal-b'}},
{id:'minus',type:'signalBlock',position:{x:405,y:110},data:{itemType:'difference',inputs:['a','b'],name:'减法'}},
{id:'high-arity',type:'signalBlock',position:{x:720,y:70},data:{itemType:'function',expression:{kind:'sum'},inputs:['1','2','3','4','5','6'],name:'六输入求和'}},
{id:'single',type:'signalBlock',position:{x:1020,y:114},data:{itemType:'integrator',inputs:['u'],name:'积分'}});
const edges=[{id:'a',source:'source-a',sourceHandle:'out',target:'minus',targetHandle:'in-0',type:'signal'},
{id:'b',source:'source-b',sourceHandle:'out',target:'minus',targetHandle:'in-1',type:'signal'},
{id:'out',source:'minus',sourceHandle:'out',target:'high-arity',targetHandle:'in-2',type:'signal'},
{id:'sum',source:'high-arity',sourceHandle:'out',target:'single',targetHandle:'in-0',type:'signal'}];
createRoot(document.getElementById('root')).render(<div style={{height:'100%',display:'flex',flexDirection:'column'}}>
<header style={{padding:'24px 44px',background:'white',borderBottom:'1px solid #e2e8f0'}}><h2 style={{fontSize:22,fontWeight:600}}>运算组件 · 实际样式预览</h2><p style={{marginTop:8,color:'#64748b'}}>符号居中　·　端口数量决定高度　·　选中后拖边框调整大小　·　自动尺寸一键恢复</p></header>
<div style={{flex:1}}><ReactFlowProvider><ReactFlow onInit={rf=>window.__galleryFlow=rf} defaultNodes={nodes} defaultEdges={edges} nodeTypes={{signalBlock:SignalBlockNode,signalEnd:SignalEndNode,legend:({data})=><div style={{width:100,textAlign:'center',fontSize:12,color:'#64748b'}}>{data.label}</div>}} edgeTypes={{signal:SignalEdge}} defaultViewport={{x:25,y:0,zoom:1.12}} nodesDraggable={false}><Background gap={20} size={1}/></ReactFlow></ReactFlowProvider></div></div>);
`;
  await writeFile(galleryModule,gallery);
  await writeFile(galleryEntry,'<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/.signal-symbol-gallery.tsx"></script></body></html>');
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1200,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:baseUrl+'/.signal-symbol-gallery.html'});
  await until('document.querySelectorAll(".diagram-block").length === 38');
  await new Promise(r=>setTimeout(r,400));
  await screenshot('signal-operators-preview.png');
  assert.equal(await evaluate('document.querySelectorAll(".react-flow__edge-path").length'),4,'Gallery wires are visible');
  await evaluate(`window.__galleryFlow.addNodes({id:'routing-obstacle',type:'legend',position:{x:580,y:120},style:{width:40,height:48},data:{label:''}})`);
  await until('document.querySelectorAll(".react-flow__edge[data-id=out] .react-flow__edge-path").length === 0');
  await evaluate(`window.__galleryFlow.updateNode('routing-obstacle',{position:{x:580,y:300}})`);
  await until('document.querySelectorAll(".react-flow__edge[data-id=out] .react-flow__edge-path").length === 1');
  await send('Emulation.setDeviceMetricsOverride',{width:1000,height:760,deviceScaleFactor:1,mobile:false});
  await evaluate(`(() => {
    document.querySelector('header h2').textContent='同一信号 · 共享主干、按需分支';
    document.querySelector('header p').textContent='同一输出端口只引出一根主干，实心点表示真实分支连接';
    const rf=window.__galleryFlow;
    rf.setEdges([]);
    rf.setViewport({x:30,y:30,zoom:1});
    rf.setNodes([{id:'fan-source',type:'signalBlock',position:{x:100,y:430},data:{itemType:'constant',compProps:{constant:{value:'u'}},inputs:[]}},
      ...[0,1,2].map(i=>({id:'fan-target'+i,type:'signalBlock',position:{x:600,y:50+i*130},data:{itemType:'integrator',inputs:['u']}}))]);
  })()`);
  await until('window.__galleryFlow.getInternalNode("fan-target2")?.internals.handleBounds?.target?.length');
  await evaluate(`(async()=>{
    const rf=window.__galleryFlow;
    const anchor=(id,side)=>{const n=rf.getInternalNode(id),h=n.internals.handleBounds[side][0];return {x:n.position.x+h.x+(side==='source'?h.width:0),y:n.position.y+h.y+h.height/2};};
    const source=anchor('fan-source','source');
    const edges=[0,1,2].map(i=>{const target=anchor('fan-target'+i,'target');return {id:'fan'+i,type:'signal',source:'fan-source',sourceHandle:'out',target:'fan-target'+i,targetHandle:'in-0',data:{elkRoute:{points:[source,{x:280+i*20,y:source.y},{x:280+i*20,y:target.y},target],junctions:[]}}};});
    rf.setEdges(edges);
    window.__fanoutEdges=edges;
  })()`);
  await until('document.querySelectorAll(".react-flow__edge-path").length === 3');
  await screenshot('signal-shared-trunk-before.png');
  await evaluate(`(async()=>{
    const {routeSignalGraph}=await import('/src/utils/signalRouting.ts');
    const rf=window.__galleryFlow;
    rf.setEdges(await routeSignalGraph(rf.getNodes(),window.__fanoutEdges,rf.getInternalNode));
  })()`);
  await until('document.querySelectorAll(".react-flow__edge circle").length > 0');
  assert.equal(await evaluate('document.querySelectorAll(".react-flow__edge-path").length'),3,'Shared trunk preserves all three destinations');
  await screenshot('signal-shared-trunk.png');
  await evaluate(`(() => {
    document.querySelector('header h2').textContent='重复引用同一信号 · 每个输入端口都连接';
    document.querySelector('header p').textContent='camera-pitch-min-deg 在公式中使用两次：共用主干，分别连接第 1、4 个输入';
    const graph=${JSON.stringify(graph)},pitch=${JSON.stringify(pitch)},rf=window.__galleryFlow;
    const edges=graph.edges.filter(e=>e.target===pitch.id);
    const sources=[...new Set(edges.map(e=>e.source))];
    window.__pitchEdges=edges;
    rf.setEdges([]);
    rf.setViewport({x:35,y:40,zoom:1.15});
    rf.setNodes([{...pitch,position:{x:580,y:160}},...sources.map((id,i)=>({...graph.nodes.find(n=>n.id===id),position:{x:80,y:80+i*130}}))]);
  })()`);
  await until(`window.__galleryFlow.getInternalNode(${JSON.stringify(pitch.id)})?.internals.handleBounds?.target?.length === 4`);
  await evaluate(`(async()=>{
    const {routeSignalGraph}=await import('/src/utils/signalRouting.ts');
    const rf=window.__galleryFlow;
    rf.setEdges(await routeSignalGraph(rf.getNodes(),window.__pitchEdges,rf.getInternalNode));
  })()`);
  await until('document.querySelectorAll(".react-flow__edge-path").length === 4');
  await screenshot('signal-repeated-inputs.png');

} finally {
  ws?.close(); chrome.kill();
  await new Promise(r=>setTimeout(r,200));
  await Promise.all([rm(profile,{recursive:true,force:true}),rm(entry,{force:true}),rm(module,{force:true}),rm(galleryModule,{force:true}),rm(galleryEntry,{force:true})]);
}
