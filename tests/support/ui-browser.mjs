import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
export async function uiBrowser(source,{port=5192,width=1360,height=900,setup=''}={}){
 const root=process.cwd(),work=await mkdtemp('/tmp/px4-ui-'),name='.px4-ui-'+process.pid;
 const entry=root+'/client/'+name+'.html',module=root+'/client/'+name+'.tsx';
 let vite,chrome,ws;
 const close=async()=>{ws?.close();vite?.kill('SIGTERM');chrome?.kill('SIGTERM');await Promise.all([rm(entry,{force:true}),rm(module,{force:true})]);await new Promise(r=>setTimeout(r,200));await rm(work,{recursive:true,force:true,maxRetries:4,retryDelay:100});};
 try{
  await writeFile(entry,`<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`);await writeFile(module,source);
  vite=spawn(root+'/node_modules/.bin/vite',['--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,stdio:'ignore'});
  chrome=spawn('/usr/bin/google-chrome-stable',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${work}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  const debug=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),15000);chrome.stderr.on('data',b=>{out+=b;const m=out.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});});
  const target=(await fetch(`http://${new URL(debug).host}/json/list`).then(r=>r.json())).find(t=>t.type==='page');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();const errors=[];
  ws.addEventListener('message',e=>{const v=JSON.parse(e.data);if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails);const p=pending.get(v.id);if(!p)return;pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>reject(Error('CDP timeout '+method)),15000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async expression=>{for(let i=0;i<160;i++){if(await ev(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,50));}throw Error(`UI timeout ${expression}: ${await ev('document.body.innerText')} ${JSON.stringify(errors)}`);};
  const click=async expression=>{const p=await ev(`(()=>{const e=(${expression}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y))};})()`);assert.ok(p.hit,'Pointer target visible: '+expression);await send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});};
  await send('Page.enable');await send('Runtime.enable');await send('Page.addScriptToEvaluateOnNewDocument',{source:setup});await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/${name}.html`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/${name}.html`});
  return{ev,send,until,click,errors,close};
 }catch(e){await close();throw e;}
}
