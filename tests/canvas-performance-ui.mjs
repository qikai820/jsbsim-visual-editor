// Large operator canvas: startup, responsive background solving and cancellation.
// Usage: node --experimental-websocket tests/canvas-performance-ui.mjs [Vite URL | --production]
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

let base = process.argv[2] || 'http://127.0.0.1:5179';
let productionServer, productionDir;
const html = new URL('../client/.canvas-performance-test.html', import.meta.url);
const module = new URL('../client/.canvas-performance-test.tsx', import.meta.url);
const c130Xml = await readFile(new URL('../../jsbsim_realtime/data/aviation/aircraft/C130/C130.xml', import.meta.url),'utf8');
await writeFile(html, '<html><body style="margin:0"><div id="root" style="height:100%;display:flex;flex-direction:column"></div><script type="module" src="/.canvas-performance-test.tsx"></script></body></html>');
await writeFile(module, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import ModuleExpressionCanvas from './src/components/expression/ModuleExpressionCanvas';
import { buildSignalGraph, graphToChannels } from './src/utils/signalGraph';
import { pendingOperatorIds } from './src/components/expression/pendingOperators';
import { parseXmlText } from './src/utils/expressionXml';
import './src/App.css';
const channels = Array.from({length:12}, (_, group) => ({ name:'Group '+group,
  items:Array.from({length:20}, (_, i) => ({ type:'summer', name:'test/g'+group+'/n'+i,
    componentProps:{inputs:[i ? 'test/g'+group+'/n'+(i-1) : 'test/input'+group, 'test/common'+group]} })) }));
window.__channels = channels;
window.__saves = 0; window.__edits = 0; window.__ticks = 0; window.__maxGap = 0;
let last = performance.now();
setInterval(() => { const now = performance.now(); window.__maxGap = Math.max(window.__maxGap, now-last); last=now; window.__ticks++; }, 20);
window.__heartbeatReset=()=>{last=performance.now();window.__maxGap=0;};
const root = createRoot(document.getElementById('root'));
window.__mount = (fresh=false) => {
  window.__expected=buildSignalGraph(channels,[],{layout:false});
  window.__started = performance.now(); window.__saves = 0; window.__maxGap = 0;
  const layout = fresh ? {} : Object.fromEntries(channels.flatMap((c, g) => c.items.map((_, i) => ['c-'+g+'-'+i,{x:200+i*160,y:100+g*180}])));
  if(!fresh) for(let g=0;g<12;g++){layout['src-test/input'+g]={x:20,y:100+g*180};layout['src-test/common'+g]={x:20,y:180+g*180};layout['sink-test/g'+g+'/n19']={x:3400,y:100+g*180};}
  root.render(<ReactFlowProvider><ModuleExpressionCanvas onInit={rf=>{window.__rf=rf;}} key={String(fresh)} mode="signal" embedded title="Large canvas" channels={channels} baselineChannels={channels}
    initialLayout={layout} onBack={() => {}} onChannelsChange={() => window.__edits++}
    onLayoutChange={layout => { window.__saved = layout; window.__saves++; window.__readyMs = performance.now()-window.__started; }} /></ReactFlowProvider>);
};
window.__unmount = () => root.render(null);
const c130Document=new DOMParser().parseFromString(${JSON.stringify(c130Xml)},'application/xml');
const c130Channels=[...c130Document.querySelectorAll('aerodynamics > axis')].map(axis=>({name:axis.getAttribute('name'),
  items:[...axis.children].filter(child=>child.tagName==='function').map(fn=>({name:fn.getAttribute('name'),
    type:fn.querySelector('table')?'aero_table':'function',expression:parseXmlText(new XMLSerializer().serializeToString(fn))}))}));
window.__c130Graph=buildSignalGraph(c130Channels,[],{layout:false});
window.__mountC130=(restore=false)=>{
  window.__expected=window.__c130Graph;
  window.__started=performance.now();window.__saves=0;window.__maxGap=0;
  root.render(<ReactFlowProvider><ModuleExpressionCanvas onInit={rf=>{window.__rf=rf;}} key={'c130-'+restore} mode="signal" embedded title="C130 气动" channels={c130Channels} baselineChannels={c130Channels}
    initialLayout={restore?window.__c130Layout:undefined} onBack={()=>{}} onChannelsChange={()=>window.__edits++}
    onLayoutChange={layout=>{window.__saved=window.__c130Layout=layout;window.__saves++;window.__readyMs=performance.now()-window.__started;}} /></ReactFlowProvider>);
};
let genericVersion=0;
window.__mountGeneric=(variant='overlap',count=64)=>{
  const groups=4, perGroup=Math.ceil(count/groups);
  const channels=Array.from({length:groups},(_,group)=>({name:'Generic '+group,items:Array.from({length:perGroup},(_,i)=>({
    type:'summer',name:'generic/'+group+'/'+i,
    componentProps:{inputs:i%3===0?Array.from({length:8},(_,port)=>'generic/input/'+group+'/'+port):
      [i?'generic/'+group+'/'+(i-1):'generic/input/'+group+'/0','generic/input/'+group+'/1']},
  }))}));
  const graph=buildSignalGraph(channels,[],{layout:false});
  const layout=variant==='empty'?{}:variant==='partial'?Object.fromEntries(graph.nodes.slice(0,graph.nodes.length/2).map(n=>[n.id,n.position])):
    Object.fromEntries(graph.nodes.map((n,i)=>[n.id,{x:80+i%5*140,y:80+Math.floor(i/5)*32}]));
  window.__expected=graph;window.__started=performance.now();window.__saves=0;window.__maxGap=0;
  root.render(<ReactFlowProvider><ModuleExpressionCanvas onInit={rf=>{window.__rf=rf;}} key={'generic-'+genericVersion++} mode="signal" embedded title="通用多节点画布"
    channels={channels} baselineChannels={channels} initialLayout={layout} onBack={()=>{}} onChannelsChange={()=>window.__edits++}
    onLayoutChange={next=>{window.__saved=next;window.__saves++;window.__readyMs=performance.now()-window.__started;}} /></ReactFlowProvider>);
};
window.__inspect=()=>{
  const nodes=window.__rf.getNodes().filter(n=>!n.hidden),edges=window.__rf.getEdges().filter(e=>!e.hidden);
  const domNodes=new Map([...document.querySelectorAll('.react-flow__node')].map(n=>[n.dataset.id,n]));
  const domEdges=new Map([...document.querySelectorAll('.react-flow__edge')].map(e=>[e.dataset.id,e]));
  const missingNodes=nodes.filter(n=>!domNodes.has(n.id)).map(n=>n.id);
  const missingEdges=[],misaligned=[],overlaps=[],outsideViewport=[];
  const boxes=nodes.map(n=>({id:n.id,rect:domNodes.get(n.id)?.getBoundingClientRect()})).filter(n=>n.rect);
  const viewport=document.querySelector('.react-flow').getBoundingClientRect();
  const transform=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);
  for(const {id,rect:r} of boxes)if(r.left<Math.max(0,viewport.left)-.7||r.right>Math.min(innerWidth,viewport.right)+.7||r.top<Math.max(0,viewport.top)-.7||r.bottom>Math.min(innerHeight,viewport.bottom)+.7)outsideViewport.push(id);
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
    const a=boxes[i].rect,b=boxes[j].rect;
    if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5)overlaps.push([boxes[i].id,boxes[j].id]);
  }
  for(const edge of edges){
    const path=domEdges.get(edge.id)?.querySelector('.react-flow__edge-path');
    if(!path||!path.getTotalLength()){missingEdges.push(edge.id);continue;}
    for(const side of ['source','target']){
      const handle=[...domNodes.get(edge[side]).querySelectorAll('.react-flow__handle')].find(h=>h.dataset.handleid===edge[side+'Handle']&&h.classList.contains(side));
      if(!handle){misaligned.push([edge.id,'missing port']);continue;}
      const r=handle.getBoundingClientRect(),p=path.getPointAtLength(side==='source'?0:path.getTotalLength()),screen=new DOMPoint(p.x,p.y).matrixTransform(transform);screen.x+=viewport.x;screen.y+=viewport.y;
      if(Math.hypot(screen.x-(side==='source'?r.right:r.left),screen.y-r.y-r.height/2)>.7)misaligned.push([edge.id,side]);
    }
  }
  return {nodes:nodes.length,edges:edges.length,missingNodes,missingEdges,overlaps,misaligned,outsideViewport};
};
window.__mountExpressions=()=>{
  const expression={kind:'sum',children:[{kind:'value',value:2},{kind:'value',value:3}]};
  root.render(<ModuleExpressionCanvas key="expression-mode" mode="expr" embedded expressions={[{id:'generic-expression',name:'Sum',expression}]}
    onChange={(id,expression)=>{window.__expressionResult={id,expression};}} onBack={()=>{}} />);
};
window.__checkGraph = () => {
  const start = performance.now();
  const graph = buildSignalGraph(channels, [], {layout:false});
  const ms = performance.now()-start;
  return {ms,nodes:graph.nodes.length,edges:graph.edges.length,pending:[...pendingOperatorIds(graph.nodes,channels)],roundtrip:graphToChannels(graph.nodes,graph.edges)};
};
window.__mount();
`);
if (process.argv.includes('--production')) {
  const { build, preview } = await import('vite');
  productionDir = await mkdtemp(path.join(tmpdir(), 'canvas-production-'));
  const configFile = new URL('../vite.config.ts', import.meta.url).pathname;
  await build({ configFile, logLevel:'error', build:{outDir:productionDir,emptyOutDir:true,rollupOptions:{input:html.pathname}} });
  productionServer = await preview({ configFile, logLevel:'error', build:{outDir:productionDir},preview:{host:'127.0.0.1',port:0} });
  base = 'http://127.0.0.1:'+productionServer.httpServer.address().port;
}
const profile = await mkdtemp(path.join(tmpdir(), 'canvas-performance-'));
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], {stdio:['ignore','ignore','pipe']});
let ws;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(Error('Chrome startup timeout')),15000);
    chrome.stderr.on('data', chunk => { stderr += chunk; const m=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if(m){clearTimeout(timer);resolve(m[1]);} });
    chrome.once('exit', code => {clearTimeout(timer);reject(Error('Chrome exited '+code));});
  });
  const page = (await fetch(`http://${new URL(endpoint).host}/json/list`).then(r=>r.json())).find(p=>p.type==='page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
  let sequence=0;
  const pending=new Map();
  const errors=[];
  ws.addEventListener('message', event=>{
    const message=JSON.parse(event.data);
    if(message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if(message.method==='Runtime.consoleAPICalled' && message.params.type==='error') errors.push(message.params.args.map(a=>a.description||a.value));
    const cb=pending.get(message.id);
    if(cb){clearTimeout(cb.timer);pending.delete(message.id);message.error?cb.reject(Error(JSON.stringify(message.error))):cb.resolve(message.result);}
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},60000);
    pending.set(id,{resolve,reject,timer}); ws.send(JSON.stringify({id,method,params}));
  });
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async expression=>{
    for(let i=0;i<600;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}
    throw Error('UI timeout '+expression+' '+JSON.stringify(errors)+' '+await evaluate('JSON.stringify({probeNodes:window.__rf?.getNodes().length,probeEdges:window.__rf?.getEdges().length,nodes:document.querySelectorAll(".react-flow__node").length,paths:document.querySelectorAll(".react-flow__edge-path").length,workers:window.__activeWorkers,busy:document.querySelector(".expr-layout-btn")?.disabled,saves:window.__saves,status:[...document.querySelectorAll("[role=status]")].map(n=>n.textContent)})'));
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.__activeWorkers=0;
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args){if(window.__failRouting&&String(args[0]).includes('signalGraph.worker'))throw Error('Intentional routing failure');super(...args);window.__activeWorkers++;}
      terminate(){if(!this.stopped){this.stopped=true;window.__activeWorkers--;}super.terminate();}
    };
  `});
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  if(process.env.CANVAS_PROFILE){await send('Profiler.enable');await send('Profiler.start');}
  await send('Page.navigate',{url:base+'/.canvas-performance-test.html'});
  if(process.env.CANVAS_EXPRESSIONS){
    await until('typeof window.__mountExpressions==="function"');
    await evaluate('window.__mountExpressions()');
    await until('document.querySelectorAll(".react-flow__node").length===3 && document.querySelectorAll(".react-flow__edge-path").length===2');
    await evaluate('document.querySelector(".expr-apply-btn").click()');
    assert.deepEqual(await evaluate('window.__expressionResult'),{id:'generic-expression',expression:{kind:'sum',children:[{kind:'value',value:2},{kind:'value',value:3}]}});
    console.log('PASS: generic expression module displays and saves its complete formula');
  }else if(process.env.CANVAS_LARGE_ONLY){
    await until('typeof window.__mountGeneric==="function"');
    await evaluate('window.__mountGeneric("empty",1000)');
    await until('window.__rf?.getNodes().length===window.__expected.nodes.length && document.querySelectorAll(".react-flow__edge-path").length===window.__expected.edges.length');
    await until('document.querySelectorAll(".react-flow__node-signalBlock.draggable").length===1000');
    await evaluate('new Promise(resolve=>setTimeout(resolve,400))');
    const actual=await evaluate('window.__inspect()');
    assert.deepEqual(actual.missingNodes,[]);assert.deepEqual(actual.missingEdges,[]);assert.deepEqual(actual.misaligned,[]);
    await evaluate('window.__heartbeatReset()');
    await evaluate('(async()=>{const v=window.__rf.getViewport();for(let i=0;i<12;i++){await window.__rf.setViewport({...v,x:v.x+i*5,y:v.y+i*3});window.__rf.updateNode("c-0-0",{selected:i%2===0});await new Promise(r=>requestAnimationFrame(r));}})()');
    const gap=await evaluate('window.__maxGap');
    assert.ok(gap<700,'Large-graph pan/zoom/selection remains responsive: '+gap);
    assert.equal(await evaluate('document.querySelectorAll(".react-flow__edge-path").length'),actual.edges);
    await evaluate('window.__unmount()');await until('window.__activeWorkers===0');
    assert.deepEqual(errors,[]);
    console.log('PASS: 1000-operator interaction',JSON.stringify({nodes:actual.nodes,edges:actual.edges,maxGap:gap}));
  }else{
  await until('window.__saves > 0 && !document.querySelector("[role=status]")');
  const saved=await evaluate('({readyMs:window.__readyMs,maxGap:window.__maxGap,saves:window.__saves,nodes:document.querySelectorAll(".react-flow__node").length,routes:Object.keys(window.__saved.__elkRoutes||{}).length})');
  console.log('saved canvas',JSON.stringify(saved));
  if(process.env.CANVAS_PROFILE){
    const {profile:p}=await send('Profiler.stop');
    const byId=new Map(p.nodes.map(n=>[n.id,n])),cost=new Map();
    p.samples.forEach((id,i)=>{const n=byId.get(id),k=n.callFrame.functionName+' '+n.callFrame.url+':'+n.callFrame.lineNumber;cost.set(k,(cost.get(k)||0)+(p.timeDeltas[i]||0));});
    console.log([...cost].sort((a,b)=>b[1]-a[1]).slice(0,20));
  }
  if (process.env.CANVAS_BASELINE || process.env.CANVAS_PROFILE) process.exitCode=0;
  else {
    assert.equal(saved.nodes,276);
    assert.equal(saved.routes,492);
    assert.ok(saved.maxGap<1000,'Opening must not block the UI for one second: '+JSON.stringify(saved));
    assert.ok(saved.saves<=2,'Startup must not solve/save the same geometry repeatedly');
    const graph=await evaluate('window.__checkGraph()');
    assert.deepEqual(graph.pending,[],'Layout-free graph keeps baseline identities');
    assert.equal(graph.roundtrip.flatMap(c=>c.items).length,240);
    assert.deepEqual(graph.roundtrip.map(channel=>({name:channel.name,items:channel.items.map(item=>({
      type:item.type,name:item.name,inputs:item.componentProps.inputs,
    }))})),Array.from({length:12},(_,group)=>({name:'Group '+group,items:Array.from({length:20},(_,i)=>({
      type:'summer',name:'test/g'+group+'/n'+i,
      inputs:[i?'test/g'+group+'/n'+(i-1):'test/input'+group,'test/common'+group],
    }))})),'Skipping layout preserves every component and ordered input');
    console.log('graph construction',JSON.stringify({ms:graph.ms,nodes:graph.nodes,edges:graph.edges}));
    // No saved layout: background placement followed by routing, with a live UI.
    await evaluate('window.__mount(true)');
    await until('window.__saves > 0 && !document.querySelector(".expr-layout-btn").disabled && !document.querySelector("[role=status]")');
    const fresh=await evaluate('({readyMs:window.__readyMs,maxGap:window.__maxGap,saves:window.__saves,routes:Object.keys(window.__saved.__elkRoutes||{}).length,edits:window.__edits})');
    assert.equal(fresh.routes,492);
    assert.equal(fresh.edits,0,'Layout never changes the model');
    assert.ok(fresh.maxGap<1000,'Placement/routing must keep the UI responsive: '+JSON.stringify(fresh));
    console.log('fresh canvas',JSON.stringify(fresh));
    const assertComplete=async(label,checkOverlap=true)=>{
      const actual=await evaluate('window.__inspect()');
      const expected=await evaluate('({nodes:window.__expected.nodes.filter(n=>!n.hidden).length,edges:window.__expected.edges.filter(e=>!e.hidden).length})');
      assert.equal(actual.nodes,expected.nodes,label+' retains all declared nodes');
      assert.equal(actual.edges,expected.edges,label+' retains all declared connections');
      assert.deepEqual(actual.missingNodes,[],label+' renders every node');
      assert.deepEqual(actual.missingEdges,[],label+' renders every connection');
      assert.deepEqual(actual.misaligned,[],label+' keeps every endpoint attached to its actual port');
      if(checkOverlap)assert.deepEqual(actual.overlaps,[],label+' has no overlapping nodes');
      return actual;
    };
    await assertComplete('large fresh canvas');
    for(const variant of ['partial','overlap','empty']){
      await evaluate('window.__mountGeneric('+JSON.stringify(variant)+')');
      // Even before detailed routing finishes, no connection is discarded.
      await until('window.__rf?.getNodes().length>80 && document.querySelectorAll(".react-flow__edge-path").length===window.__rf.getEdges().length');
      await assertComplete(variant+' while loading',false);
      await until('window.__inspect().overlaps.length===0');
      const firstCompleteMs=await evaluate('performance.now()-window.__started');
      assert.ok(firstCompleteMs<5000,variant+' displays the full measured layout before detailed routing finishes');
      await until('document.querySelectorAll(".react-flow__node-signalBlock.draggable").length===64');
      assert.ok(await evaluate('window.__activeWorkers>0'),'Nodes are interactive while detailed routing is still running');
      await evaluate('window.__rf.updateNode("c-0-0",{selected:true})');
      await until('window.__saves>0 && !document.querySelector(".expr-layout-btn").disabled && window.__activeWorkers===0');
      const actual=await assertComplete(variant+' after repair');
      assert.deepEqual(actual.outsideViewport,[],variant+' fits the entire graph in view');
      console.log('generic '+variant,JSON.stringify({nodes:actual.nodes,edges:actual.edges,firstCompleteMs,...await evaluate('({readyMs:window.__readyMs,maxGap:window.__maxGap})')}));
      if(variant==='overlap'){
        const shot=await send('Page.captureScreenshot',{format:'png'});
        await writeFile('/tmp/jsbsim-generic-canvas-repaired.png',Buffer.from(shot.data,'base64'));
      }
    }
    // Zoom/pan and selection must not restart a whole-graph solve or lose wires.
    const savesBefore=await evaluate('window.__saves');
    await evaluate('window.__heartbeatReset()');
    await evaluate('(async()=>{for(let i=0;i<12;i++){await window.__rf.setViewport({x:i*4,y:i*3,zoom:.6+i*.01});window.__rf.updateNode("c-0-0",{selected:i%2===0});await new Promise(r=>requestAnimationFrame(r));}})()');
    const panGap=await evaluate('window.__maxGap');
    assert.ok(panGap<500,'Pan/zoom/selection stays responsive');
    await assertComplete('pan, zoom and selection');
    console.log('interaction max gap',panGap);
    assert.equal(await evaluate('window.__saves'),savesBefore,'View-only interactions do not reroute or save the graph');
    // A crowded user edit can require routing assistance; all wires stay visible.
    await evaluate('window.__rf.setNodes(ns=>ns.map(n=>n.id==="c-0-1"?{...n,position:ns.find(x=>x.id==="c-0-0").position}:n))');
    await until('window.__activeWorkers===0 && !document.body.innerText.includes("整理连线…")');
    await assertComplete('crowded manual edit',false);

    await evaluate('window.__failRouting=true;window.__mountGeneric("empty",32)');
    await until('window.__saves>0 && !document.querySelector(".expr-layout-btn").disabled && window.__activeWorkers===0');
    await assertComplete('routing failure preserves complete placement');
    await evaluate('window.__failRouting=false');
    // A much larger topology remains complete while its background job is
    // active, and closing it stops that work promptly.
    await evaluate('window.__mountGeneric("empty",1000)');
    await until('window.__rf?.getNodes().length===window.__expected.nodes.length && document.querySelectorAll(".react-flow__edge-path").length===window.__expected.edges.length');
    const large=await assertComplete('1000-operator topology while loading',false);
    console.log('1000 operators',JSON.stringify({nodes:large.nodes,edges:large.edges,...await evaluate('({maxGap:window.__maxGap,ticks:window.__ticks})')}));
    await evaluate('window.__heartbeatReset()');
    await evaluate('(async()=>{const v=window.__rf.getViewport();for(let i=0;i<8;i++){await window.__rf.setViewport({...v,x:v.x+i*5,y:v.y+i*3});await new Promise(r=>requestAnimationFrame(r));}})()');
    console.log('1000-operator pan max gap',await evaluate('window.__maxGap'));
    await evaluate('window.__unmount()');
    await until('window.__activeWorkers===0');
    // Representative real expression/LUT input, using the same generic path.

    await evaluate('window.__mountC130()');
    await until('window.__saves > 0 && !document.querySelector(".expr-layout-btn").disabled && !document.querySelector("[role=status]")');
    const c130=await evaluate('({readyMs:window.__readyMs,maxGap:window.__maxGap,nodes:window.__c130Graph.nodes.length,edges:window.__c130Graph.edges.length,tables:window.__c130Graph.nodes.filter(n=>n.data.kind==="tablePreview").length,routes:Object.keys(window.__saved.__elkRoutes||{}).length,edits:window.__edits})');
    await assertComplete('aircraft aerodynamic canvas');
    assert.equal(c130.routes,c130.edges,'Every C130 aerodynamic wire is routed');
    assert.ok(c130.tables>=6,'All C130 aerodynamic LUTs are included');
    assert.equal(c130.edits,0,'C130 expressions and tables remain unchanged');
    assert.ok(c130.maxGap<1000,'C130 startup keeps the UI responsive');
    const coordinates=await evaluate('Object.fromEntries(Object.entries(window.__saved).filter(([id])=>!id.startsWith("__")))');
    await evaluate('window.__mountC130(true)');
    await until('window.__saves > 0 && !document.querySelector("[role=status]")');
    assert.deepEqual(await evaluate('Object.fromEntries(Object.entries(window.__saved).filter(([id])=>!id.startsWith("__")))'),coordinates,'Reopening C130 preserves all saved coordinates');
    console.log('C130 aerodynamics',JSON.stringify(c130));
    assert.equal(await evaluate('window.__activeWorkers'),0,'Settled solvers release their workers');
    // Closing during work must terminate it and discard its pending save.
    await evaluate('document.querySelector(".expr-layout-btn").click()');
    await until('window.__activeWorkers > 0');
    await evaluate('window.__unmount()');
    await until('!document.querySelector(".react-flow")');
    assert.equal(await evaluate('window.__activeWorkers'),0,'Closing the canvas terminates in-flight work');
    const saves=await evaluate('window.__saves');
    await new Promise(r=>setTimeout(r,1000));
    assert.equal(await evaluate('window.__saves'),saves,'Unmounted solver cannot persist a stale result');
    assert.deepEqual(errors,[],'No browser errors');
  }
  }
} finally {
  ws?.close(); chrome.kill();
  await new Promise(r=>setTimeout(r,200));
  if(productionServer) await new Promise(resolve=>productionServer.httpServer.close(resolve));
  if(productionDir) await rm(productionDir,{recursive:true,force:true});
  await Promise.all([rm(profile,{recursive:true,force:true}),rm(html,{force:true}),rm(module,{force:true})]);
}
