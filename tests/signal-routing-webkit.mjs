// Production routing in the Linux desktop WebView, over HTTP and tauri://.
// Optional project snapshot is read only; no application profile is opened.
// Usage: node tests/signal-routing-webkit.mjs [path/to/model.project.json]
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { build, preview } from 'vite';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const work = await mkdtemp('/tmp/signal-routing-webkit-');
const entry = root + '/client/.' + work.split('/').pop() + '.html';
const module = entry.replace(/\.html$/, '.tsx');
let server;
let cases = [{ name: 'Routing smoke', params: { channels: JSON.stringify([{ name: 'Test', items: [
  { type: 'summer', name: 'test/sum', componentProps: { inputs: ['test/a', 'test/b'] } },
  { type: 'pure_gain', name: 'test/gain', componentProps: { input: { value: 'test/sum' }, gain: { value: '2' } } },
] }]) } }];
try {
  if (process.argv[2]) {
    const snapshot = JSON.parse(await readFile(process.argv[2], 'utf8'));
    cases = (snapshot.project || snapshot).nodes.filter(n => n.data?.params?.channels)
      .map(n => ({ name: n.data.label, params: n.data.params }));
    assert.ok(cases.length, 'Project contains system channels');
  }
  await writeFile(entry, '<html><body style="margin:0"><div id="root"></div><script type="module" src="/' + module.split('/').pop() + '"></script></body></html>');
  await writeFile(module, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ModuleExpressionCanvas from './src/components/expression/ModuleExpressionCanvas';
import { systemCanvasChannels } from './src/utils/systemSignalCanvas';
import './src/App.css';
const cases=${JSON.stringify(cases)};
const report=value=>window.webkit.messageHandlers.probe.postMessage(JSON.stringify(value));
const check=(value,message)=>{if(!value)throw Error(message);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async predicate=>{for(let i=0;i<600;i++){if(predicate())return;await sleep(100);}throw Error('Timed out: '+document.body.innerText.slice(0,500));};
const root=createRoot(document.getElementById('root'));
const nativeWorker=window.Worker;
let failWorker=false, edits=0, rf, saved, version=0;
window.Worker=class extends nativeWorker {
  constructor(url,options){
    if(String(url).includes('signalGraph.worker')){
      // Emulate a desktop that cannot load module workers. The production
      // bundle must route using a single classic worker instead.
      check(options?.type!=='module','Production routing requires a module worker');
      if(failWorker)throw Error('Intentional routing startup failure');
    }
    super(url,options);
  }
};
window.addEventListener('error',e=>report({error:e.message}));
window.addEventListener('unhandledrejection',e=>report({error:String(e.reason)}));
const mount=(item,layout)=>{
  rf=undefined;saved=undefined;
  const p=item.params,parse=(value,fallback)=>value?typeof value==='string'?JSON.parse(value):value:fallback;
  root.render(<ModuleExpressionCanvas key={version++} mode="signal" embedded title={item.name}
    channels={systemCanvasChannels(parse(p.channels,[]),parse(p.topLevelItems,[]))}
    topLevelProps={(p.properties||'').split(',').filter(Boolean)} propertyDefinitions={parse(p.propertyDefinitions,[])}
    initialLayout={layout??parse(p.layout,undefined)} onBack={()=>{}} onInit={instance=>rf=instance}
    onLayoutChange={layout=>saved=layout} onChannelsChange={()=>edits++}/>);
};
const ready=()=>rf&&rf.getNodes().length&& !document.querySelector('.expr-layout-btn')?.disabled
  &&!document.body.innerText.includes('加载画布…')&&!document.body.innerText.includes('整理连线…');
const settled=()=>ready()&&saved;
const verify=()=>{
  check(!document.body.innerText.includes('连线整理未完成'),'Routing failed: '+document.body.innerText.slice(0,500));
  const edges=rf.getEdges().filter(e=>!e.hidden),nodes=rf.getNodes().filter(n=>!n.hidden);
  check(edges.every(e=>e.data?.elkRoute?.points.length>=2),'All visible edges have computed routes');
  check(document.querySelectorAll('.react-flow__edge-path').length===edges.length,'All connections remain visible');
  check(document.querySelectorAll('.react-flow__node').length===nodes.length,'All nodes remain visible');
  check(edits===0,'Routing must not edit the model');
  return {nodes:nodes.length,edges:edges.length};
};
(async()=>{
  const results=[];let firstLayout;
  for(const item of cases){
    mount(item);await until(settled);verify();
    const layout=saved;check(layout,'Layout was persisted');
    if(!firstLayout)firstLayout=layout;
    const positions=JSON.stringify(rf.getNodes().map(n=>[n.id,n.position]));
    mount(item,layout);await until(settled);const counts=verify();
    check(JSON.stringify(rf.getNodes().map(n=>[n.id,n.position]))===positions,'Reopening preserves saved positions');
    results.push({name:item.name,...counts});
  }
  failWorker=true;mount(cases[0],firstLayout);
  await until(()=>ready()&&document.body.innerText.includes('Intentional routing startup failure'));
  check(document.body.innerText.includes('无法启动连线计算线程'),'Startup failure identifies the cause');
  check(document.querySelectorAll('.react-flow__edge-path').length===rf.getEdges().filter(e=>!e.hidden).length,'Failure preserves every wire');
  failWorker=false;document.querySelector('.expr-layout-btn').click();
  await until(()=>settled()&&!document.body.innerText.includes('连线整理未完成'));verify();
  report({passed:true,results,failureRecovery:true,modelEdits:edits});root.unmount();
})().catch(error=>report({error:String(error),stack:error.stack}));
`);
  await build({ configFile: root + '/vite.config.ts', logLevel: 'error', build: {
    outDir: work + '/dist', rollupOptions: { input: entry },
  } });
  server = await preview({ configFile: root + '/vite.config.ts', logLevel: 'error',
    build: { outDir: work + '/dist' }, preview: { host: '127.0.0.1', port: 0 } });
  await writeFile(work + '/probe.py', `
import gi, json, sys, pathlib
from urllib.parse import urlparse
gi.require_version('Gtk','3.0')
gi.require_version('WebKit2','4.1')
gi.require_version('Soup','3.0')
from gi.repository import Gtk, WebKit2, GLib, Gio, Soup
root=pathlib.Path(sys.argv[1])
context=WebKit2.WebContext.new_ephemeral()
def resource(request):
    try:
        name=urlparse(request.get_uri()).path.lstrip('/')
        data=(root/name).read_bytes()
        stream=Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(data))
        response=WebKit2.URISchemeResponse.new(stream,len(data))
        response.set_content_type('text/javascript' if name.endswith('.js') else 'application/wasm' if name.endswith('.wasm') else 'text/css' if name.endswith('.css') else 'text/html')
        response.set_status(200,'OK')
        headers=Soup.MessageHeaders.new(Soup.MessageHeadersType.RESPONSE)
        headers.append('Access-Control-Allow-Origin','tauri://localhost')
        response.set_http_headers(headers)
        request.finish_with_response(response)
    except Exception as error:
        print(json.dumps({'error':str(error)}),flush=True)
        Gtk.main_quit()
context.register_uri_scheme('tauri',resource)
context.get_security_manager().register_uri_scheme_as_secure('tauri')
manager=WebKit2.UserContentManager.new()
manager.register_script_message_handler('probe')
passed=False
def message(manager,result):
    global passed
    text=result.get_js_value().to_string()
    print(text,flush=True)
    passed=json.loads(text).get('passed',False)
    Gtk.main_quit()
manager.connect('script-message-received::probe',message)
view=WebKit2.WebView(web_context=context,user_content_manager=manager)
window=Gtk.Window();window.set_default_size(1600,1000);window.add(view);window.show_all()
view.load_uri(sys.argv[2])
def timeout():
    print(json.dumps({'error':'WebKit routing smoke timed out'}),flush=True)
    Gtk.main_quit();return False
GLib.timeout_add_seconds(150,timeout)
Gtk.main()
sys.exit(0 if passed else 1)
`);
  for (const origin of ['http://127.0.0.1:' + server.httpServer.address().port, 'tauri://localhost']) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('xvfb-run', ['-a', '/usr/bin/python3', work + '/probe.py', work + '/dist', origin + '/' + entry.split('/').pop()], {
        env: { ...process.env, WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1',
          XDG_DATA_HOME: work + '/data', XDG_CONFIG_HOME: work + '/config', XDG_CACHE_HOME: work + '/cache' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', b => out += b);child.stderr.on('data', b => err += b);
      child.once('error', reject);child.once('exit', code => resolve({ code, out, err }));
    });
    assert.equal(result.code, 0, result.out + result.err);
    console.log(origin, result.out.trim());
  }
} finally {
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await Promise.all([rm(entry, { force: true }), rm(module, { force: true }), rm(work, { recursive: true, force: true })]);
}
