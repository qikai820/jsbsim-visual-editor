// Real DOM XML semantics, source patches, review UI and upload preflight.
// Self-contained Chromium/Vite harness; no simulator is contacted.
// Node 20: node --experimental-websocket tests/xml-semantics-ui.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), 'xml-semantics-'));
const name = `.xml-semantics-${process.pid}`;
const entry = new URL(`../client/${name}.html`, import.meta.url);
const module = new URL(`../client/${name}.tsx`, import.meta.url);
const voliro = await readFile(new URL('../../jsbsim_realtime/data/aviation/aircraft/voliro_t/VoliroTActuators.xml', import.meta.url), 'utf8');
await writeFile(entry, `<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`);
await writeFile(module, `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import XmlSourceBrowser from './src/components/XmlSourceBrowser';import './src/App.css';
function Harness(){const [view,setView]=useState(null);window.__show=(local,remote)=>setView({local,remote,id:Math.random()});
return view?<XmlSourceBrowser key={view.id} documents={[{path:'systems/Test.xml',content:view.local,dirty:true}]}
 remoteContents={{'systems/Test.xml':view.remote}} onClose={()=>setView(null)}/>:null;}
createRoot(document.getElementById('root')).render(<Harness/>);
`);
const vite = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5193', '--strictPort'], { cwd: root, stdio: 'ignore' });
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${work}/chrome`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
    chrome.stderr.on('data', data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.once('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}`)); });
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:5193/${name}.html`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const page = (await fetch(`http://${new URL(endpoint).host}/json/list`).then(r => r.json())).find(page => page.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), item = pending.get(message.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`UI timeout ${expression}: ${await evaluate('document.body.innerText')}`);
  };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__writes=[];window.__confirms=[];window.__remote='<old/>';
    window.confirm=message=>{window.__confirms.push(message);return true;};
    localStorage.setItem('jsbsim-remote-upload-enabled','true');
    window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,
      invoke:async(command,args)=>{
        if(command==='ftp_list_xml_parent')return {exists:true,files:['Test.xml']};
        if(command==='ftp_download_xml')return {content:window.__remote};
        if(command==='ftp_upload_file'){window.__writes.push(args);return {uploaded:true};}return {};
      }};
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:5193/${name}.html` });
  await until('window.__show');

  const cases = await evaluate(`(async()=>{
    const {xmlContentEqual:eq,compareXmlContent,normalizeXmlNumber}=await import('/src/utils/xmlContentEqual.ts');
    const {applyXmlDelta}=await import('/src/utils/xmlDelta.ts');
    const {prepareModelXml,compareModelXml}=await import('/src/utils/modelXmlSync.ts');
    const tests=[];const check=(name,left,right,expected)=>tests.push({name,actual:eq(left,right),expected});
    const scalar=value=>'<function><value>'+value+'</value></function>';
    check('formatting, attributes and empty tags',"<?xml version='1.0'?><system name='a' type='b'>\\r\\n <empty> </empty>\\r\\n<function><value>0.050000</value></function></system>",'<system type="b" name="a"><empty/><function><value>5e-2</value></function></system>',true);
    for(const [a,b] of [['1000000.0','1e6'],['.00000500','5e-6'],['+000.370000','3.7E-1'],['9007199254740993.0','9007199254740993'],['1e-400','10e-401'],['1e999999999999999999','10e999999999999999998']])check('exact equivalent '+a,scalar(a),scalar(b),true);
    for(const [a,b] of [['0.008494031','0.008494032'],['0.3','0.30000000000000004'],['9007199254740992','9007199254740993'],['0','1e-400'],['1e-400','2e-400'],['1e400','2e400']])check('real numeric change '+a,scalar(a),scalar(b),false);
    check('CDATA value','<value><![CDATA[0.0500]]></value>','<value>5e-2</value>',true);
    check('unknown numeric text','<vendor>1.0</vendor>','<vendor>1</vendor>',false);
    check('unknown numeric attribute','<value vendor="1.0">1</value>','<value vendor="1">1</value>',false);
    check('missing attribute','<value custom="">1</value>','<value>1</value>',false);
    check('unit change','<x unit="FT">1</x>','<x unit="M">1</x>',false);
    check('numeric name','<channel name="01"/>','<channel name="1"/>',false);
    check('property path','<property>fcs/input[01]</property>','<property>fcs/input[1]</property>',false);
    check('string trim','<input> fcs/input </input>','<input>fcs/input</input>',true);
    check('preserve whitespace','<input xml:space="preserve"> fcs/input </input>','<input xml:space="preserve">fcs/input</input>',false);
    check('unknown mixed content','<vendor>a <b/> b</vendor>','<vendor>a<b/>b</vendor>',false);
    const newline=compareXmlContent('<vendor>a&#13;b</vendor>','<vendor>a\\nb</vendor>');
    tests.push({name:'significant character reference stays visible in diff',actual:!newline.equal&&newline.left.xml!==newline.right.xml,expected:true});
    check('operand order','<difference><value>1</value><value>2</value></difference>','<difference><value>2</value><value>1</value></difference>',false);
    check('unknown child','<system><vendor/></system>','<system/>',false);
    check('invalid identical XML','<system>','<system>',false);
    const table1='<table><independentVar>x</independentVar><tableData>\\n0.000 0.000\\n0.050000 0.008494031\\n1.0 1.0\\n</tableData></table>';
    const table1b='<table><independentVar lookup="row"> x </independentVar><tableData>\\n 0 0\\n 5e-2\\t0.008494031\\n 1 1\\n</tableData></table>';
    check('1D data and default row lookup',table1,table1b,true);
    check('1D actual cell edit',table1,table1b.replace('0.008494031','0.008494032'),false);
    check('row boundaries',table1,table1.replace('0.000 0.000\\n','0.000\\n0.000 '),false);
    check('axis variable',table1,table1.replace('>x<','>y<'),false);
    const table2='<table><independentVar lookup="row">x</independentVar><independentVar lookup="column">y</independentVar><tableData>\\n 0.0 1.0\\n 0.0 2.0 3.0\\n 1.0 4.0 5.0\\n</tableData></table>';
    check('2D matrix formatting',table2,table2.replace(/([0-5])\\.0/g,'$1').replaceAll(' ','\\t'),true);
    check('2D column header',table2,table2.replace('0.0 1.0','0.0 1.1'),false);
    const table3=table2.replace('</table>','<tableData breakPoint="1.000">\\n0 1\\n0 6 7\\n1 8 9\\n</tableData></table>').replace('<tableData>','<independentVar lookup="table">z</independentVar><tableData breakPoint="0.000">');
    check('3D layer numeric attributes',table3,table3.replaceAll('1.000','1e0').replaceAll('0.000','0'),true);
    check('3D actual layer change',table3,table3.replace('1.000','1.001'),false);
    check('numeric attributes','<output type="HIL_SENSOR" name="a" rate="020.00" port="5000.0"/>','<output type="HIL_SENSOR" port="5e3" rate="2e1" name="a"/>',true);
    check('socket port uses atoi','<output type="SOCKET" port="5000"/>','<output type="SOCKET" port="5e3"/>',false);
    check('gearratio','<propeller><gearratio>1.000</gearratio></propeller>','<propeller><gearratio>1e0</gearratio></propeller>',true);
    check('vendor gain remains opaque','<system><vendor><gain>1.0</gain></vendor></system>','<system><vendor><gain>1</gain></vendor></system>',false);
    check('zero_centered is a string switch','<aerosurface_scale><zero_centered>0</zero_centered></aerosurface_scale>','<aerosurface_scale><zero_centered>0.0</zero_centered></aerosurface_scale>',false);
    check('random numeric attributes and defaults','<function><random/></function>','<function><random mean="0.0" stddev="1e0"/></function>',true);
    check('actual function aliases','<function><product><value>1.0</value><property>x</property></product></function>','<function><product><v>1</v><p>x</p></product></function>',true);
    check('HIL system IDs are numeric','<output type="HIL_GPS" system_id="001.0"/>','<output type="HIL_GPS" system_id="1e0"/>',true);
    check('recursive ND table and axis aliases','<table><independentVar lookup="axis01">x</independentVar><tableData breakPoint="1.00"><tableData breakPoint="2.00">0 1\\n0 2 3\\n1 4 5</tableData></tableData></table>','<t><independentVar lookup="row">x</independentVar><tableData breakPoint="1"><tableData breakPoint="2e0">0.0 1.0\\n0.0 2.0 3.0\\n1.0 4.0 5.0</tableData></tableData></t>',true);
    check('firmware hex bytes','<serial_outputs><output prefix="aa:01"/></serial_outputs>','<serial_outputs><output prefix="AA-01"/></serial_outputs>',true);
    check('firmware byte change','<serial_outputs><output prefix="AA01"/></serial_outputs>','<serial_outputs><output prefix="AA02"/></serial_outputs>',false);
    check('PWM runtime defaults','<pwm_inputs><input device="/dev/capture0" property="fcs/a"/></pwm_inputs>','<pwm_inputs><input device="/dev/capture0" property="fcs/a" min_us="1000.0" max_us="2e3" output_min="-1" output_max="1.0" failsafe="0" timeout_ms="500"/></pwm_inputs>',true);
    check('empty required numeric attribute is not a default','<pwm_inputs><input min_us=""/></pwm_inputs>','<pwm_inputs><input/></pwm_inputs>',false);
    check('property RHS condition values','<switch><test value="1.0">fcs/a gt 0.05000</test></switch>','<switch><test value="1">fcs/a &gt; 5e-2</test></switch>',true);
    check('property LHS remains a name','<switch><test value="1">01 eq 0</test></switch>','<switch><test value="1">1 eq 0</test></switch>',false);
    check('signed zero spelling','<value>-0.000e0</value>','<value>-0</value>',true);
    check('signed zero remains significant','<value>-0.0</value>','<value>0.0</value>',false);
    const spaceA=new DOMParser().parseFromString('<system xml:space="preserve"><function><value> 1 </value></function></system>','application/xml');
    const spaceB=new DOMParser().parseFromString('<system xml:space="preserve"><function><value>1</value></function></system>','application/xml');
    const {xmlElementsEqual}=await import('/src/utils/xmlContentEqual.ts');
    tests.push({name:'patch comparisons preserve inherited xml:space',actual:!xmlElementsEqual(spaceA.querySelector('value'),spaceB.querySelector('value')),expected:true});
    const source=${JSON.stringify(voliro)};
    const doc=new DOMParser().parseFromString(source,'application/xml');
    for(const data of doc.querySelectorAll('tableData'))data.textContent='\\n'+data.textContent.trim().split(/\\r?\\n/).map(row=>row.trim().split(/\\s+/).map(normalizeXmlNumber).join('\\t')).join('\\n')+'\\n';
    const generated=new XMLSerializer().serializeToString(doc);
    check('full Voliro screenshot case',source,generated,true);
    tests.push({name:'no-op delta retains every source byte',actual:applyXmlDelta(source,source,generated)===source,expected:true});
    const edited=generated.replace('0.008494031','0.008494032');
    const patched=applyXmlDelta(source,generated,edited);
    tests.push({name:'real Voliro cell delta reaches the final XML',actual:!eq(patched,source)&&eq(patched,edited),expected:true});
    tests.push({name:'real table delta preserves every following source byte',actual:patched.slice(patched.indexOf('</tableData>'))===source.slice(source.indexOf('</tableData>')),expected:true});
    const comment=compareXmlContent('<system><!--old--><function><value>1</value></function></system>','<system><!--new--><function><value>1.0</value></function></system>');
    tests.push({name:'comments separately visible',actual:comment.equal&&comment.commentsDiffer,expected:true});
    const base={aircraft:{name:'test'},nodes:[],edges:[],xmlFiles:[{id:'main',path:'aircraft/test/test.xml',category:'main',originalXml:table1,currentXml:table1,dirty:false}]};
    const current=structuredClone(base);current.xmlFiles[0].currentXml=table1b;
    const prepared=await prepareModelXml(current,base,'test',{generateXml:async()=>{throw Error('no-op source edit must not generate');},generateSubfile:async()=>''});
    tests.push({name:'prepared no-op preserves original source',actual:!prepared[0].dirty&&prepared[0].content===table1,expected:true});
    tests.push({name:'equivalent remote produces no upload candidate',actual:(await compareModelXml(prepared,async()=>table1b)).length===0,expected:true});
    let invalidBlocked=false;try{await compareModelXml(prepared,async()=>'<broken>');}catch{invalidBlocked=true;}
    tests.push({name:'invalid remote comparison blocks',actual:invalidBlocked,expected:true});
    window.__equivalent=generated;window.__source=source;
    window.__changed=edited;
    return tests;
  })()`);
  for (const test of cases) assert.equal(test.actual, test.expected, test.name);

  await evaluate('window.__show(window.__equivalent,window.__source)');
  await until('document.querySelector(".xml-git-empty")');
  assert.match(await evaluate('document.querySelector(".xml-git-counts").textContent'), /0 处模型差异/);
  assert.equal(await evaluate('document.querySelectorAll(".xml-git-row.has-change").length'), 0);
  assert.match(await evaluate('document.body.innerText'), /模型语义一致，无需同步/);
  await evaluate(`(()=>{const select=document.querySelector('[aria-label="差异比较规则"]');select.value='text';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until('document.querySelectorAll(".xml-git-row.has-change").length>0');
  await evaluate('window.__show(window.__changed,window.__source)');
  await until('document.querySelectorAll(".xml-git-row.has-change").length===1');
  assert.match(await evaluate('document.querySelector(".xml-git-row.has-change").textContent'), /0\.008494032/);
  await send('Page.captureScreenshot', { format: 'png' }).then(result => writeFile('/tmp/jsbsim-xml-semantic-diff.png', Buffer.from(result.data, 'base64')));
  await evaluate('window.__show("<broken>","<system/>")');
  await until('document.querySelector("[role=alert]")');
  assert.match(await evaluate('document.querySelector("[role=alert]").textContent'), /无法进行语义比较/);

  const upload = await evaluate(`(async()=>{
    const api=await import('/src/utils/tauriApi.ts');window.__remote=window.__source;
    const skipped=await api.ftpUploadFile('systems/Test.xml',window.__equivalent);
    const noOp={uploaded:skipped.uploaded,writes:window.__writes.length,confirms:window.__confirms.length};
    await api.ftpUploadFile('systems/Test.xml',window.__changed);
    window.__remote='<invalid>';let invalidBlocked=false;try{await api.ftpUploadFile('systems/Test.xml',window.__changed);}catch{invalidBlocked=true;}
    return {noOp,writes:window.__writes.length,confirm:window.__confirms[0],invalidBlocked};
  })()`);
  assert.deepEqual(upload.noOp, { uploaded: false, writes: 0, confirms: 0 });
  assert.equal(upload.writes, 1); assert.equal(upload.invalidBlocked, true);
  assert.match(upload.confirm, /语义变更/);
  console.log(`PASS: ${cases.length} semantic/source cases; real Voliro no-op, one-cell review, raw-text switch, invalid XML and upload preflight.`);
} finally {
  socket?.close(); chrome.kill('SIGTERM'); vite.kill('SIGTERM');
  await rm(entry, { force: true }); await rm(module, { force: true });
  await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
