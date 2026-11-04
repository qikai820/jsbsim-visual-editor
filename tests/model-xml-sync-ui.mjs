// End-to-end XML sync regression. Real Rust XML parser/generator, isolated
// in-memory simulator IPC; no hardware is contacted. Node 20: --experimental-websocket.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), 'model-xml-sync-'));
const bridgeSource = fileURLToPath(new URL('support/model-sync-backend.rs', import.meta.url));
await writeFile(path.join(work, 'Cargo.toml'), `[package]\nname="model-sync-backend"\nversion="0.0.0"\nedition="2021"\n[[bin]]\nname="model-sync-backend"\npath=${JSON.stringify(bridgeSource)}\n[dependencies]\nserde_json="1"\nserde={version="1",features=["derive"]}\nquick-xml={version="0.41",features=["serialize","overlapped-lists","escape-html"]}\n`);
const build = spawnSync('cargo', ['build', '--offline', '--quiet', '--manifest-path', path.join(work, 'Cargo.toml')], { cwd: root, encoding: 'utf8' });
assert.equal(build.status, 0, build.stderr);
const backend = (command, args) => {
  const result = spawnSync(path.join(work, 'target/debug/model-sync-backend'), { input: JSON.stringify({ command, args }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  if (value.error) throw new Error(value.error);
  return value;
};
const liveXml=backend('generate_subfile',{req:{type:'system',name:'Live',params:{channels:JSON.stringify([{name:'Live',items:[{type:'fcs_function',name:'test/limited',cliptoMin:'-1.5',cliptoMax:'test/upper-limit',expression:{kind:'value',value:9.25}},{type:'constant',name:'test/constant',componentProps:{constant:{value:'4.5'}}}]}])}}});
assert.ok(liveXml.xml.includes('<min>-1.5</min>'));assert.ok(liveXml.xml.includes('<max>test/upper-limit</max>'));
assert.ok(liveXml.xml.includes('<value>9.25</value>'));assert.ok(liveXml.xml.includes('<value>4.5</value>'));
const references = [
  { name: 'aircraft/test/Mass.xml', xml: `<?xml version="1.0"?>\n<mass_balance>\n  <!-- keep mass comment -->\n  <ixx unit="SLUG*FT2">1</ixx><iyy unit="SLUG*FT2">2</iyy><izz unit="SLUG*FT2">3</izz>\n  <emptywt unit="LBS">10</emptywt>\n  <location name="CG" unit="IN"><x>1</x><y>2</y><z>3</z></location>\n  <pointmass name="battery"><weight unit="LBS">2</weight><location unit="IN"><x>1</x><y>0</y><z>0</z></location></pointmass>\n  <vendor_mass keep="yes">untouched</vendor_mass>\n</mass_balance>` },
  { name: 'systems/Sensor.xml', xml: `<?xml version="1.0"?>\n<system name="Sensor">\n  <!-- keep sensor comment -->\n  <channel name="sensor"><pure_gain name="sensor/gain"><input>velocities/u-fps</input><gain>1</gain><output>sensor/result</output></pure_gain></channel>\n  <vendor_sensor keep="yes"/>\n</system>` },
  { name: 'engine/Motor.xml', xml: `<?xml version="1.0"?>\n<electric_engine name="Motor"><power unit="WATTS">100</power><vendor_engine keep="yes"/></electric_engine>` },
];
const main = `<?xml version="1.0"?>\n<fdm_config name="test" version="2.0" release="PRODUCTION">\n  <!-- keep main bytes -->\n  <metrics><wingarea unit="FT2">10</wingarea><wingspan unit="FT">4</wingspan><chord unit="FT">2</chord><location name="AERORP" unit="IN"><x>0</x><y>0</y><z>0</z></location></metrics>\n  <mass_balance file="Mass"/>\n  <ground_reactions><contact type="BOGEY" name="left"><location unit="IN"><x>1</x><y>2</y><z>3</z></location><static_friction>0.8</static_friction><spring_coeff unit="LBS/FT">100</spring_coeff><vendor_contact keep="yes"/></contact></ground_reactions>\n  <propulsion><engine file="Motor"><location unit="IN" x="1" y="2" z="3"/><orient unit="DEG" roll="1" pitch="2" yaw="3"/><thruster file="direct"><location unit="IN"><x>0</x><y>0</y><z>0</z></location><sense>1</sense></thruster></engine><tank type="FUEL" number="0"><location unit="IN"><x>0</x><y>0</y><z>0</z></location><capacity unit="LBS">5</capacity><contents unit="LBS">3</contents></tank></propulsion>\n  <system file="Sensor"/>\n  <flight_control name="FCS"><channel name="control"><pure_gain name="fcs/gain"><input>fcs/input</input><gain>2</gain><output>fcs/result</output></pure_gain></channel></flight_control>\n  <aerodynamics><axis name="LIFT"><function name="aero/test"><description>keep me</description><value>1</value></function></axis></aerodynamics>\n  <output name="telemetry" type="SOCKET" port="5000" rate="20"><property>velocities/u-fps</property><vendor_output keep="yes"/></output>\n  <vendor_main keep="yes"/>\n</fdm_config>\n`;
references.push({ name: 'engine/direct.xml', xml: '<direct name="Direct"/>' });
const h7Source = await readFile(new URL('../../jsbsim_realtime/data/aviation/aircraft/H7/H7_Viztra.xml', import.meta.url), 'utf8');
const h7Graph = backend('parse_xml', {xml:'<fdm_config name="H7"><system file="H7_Viztra"/></fdm_config>',files:[{name:'H7_Viztra.xml',xml:h7Source}]});
const graph = backend('parse_xml', { xml: main, files: references });
graph.xmlFiles = [{ id: 'main:aircraft/test/test.xml', path: 'aircraft/test/test.xml', category: 'main', originalXml: main, currentXml: main, dirty: false },
  ...references.map(file => ({ id: `source:${file.name}`, path: file.name, category: file.name.startsWith('engine/') ? 'engine' : 'system', originalXml: file.xml, currentXml: file.xml, dirty: false }))];
for (const node of graph.nodes) {
  const p = node.data.params;
  if (p._source_file) {
    const file = references.find(file => file.name.split('/').pop().replace(/\.xml$/, '') === p._source_file.replace(/\.xml$/, ''));
    if (file) { p.referencePath = file.name; p.source = { path: file.name }; }
  } else if (p.source) p.source.path = 'aircraft/test/test.xml';
}
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (request.method === 'OPTIONS') { response.end(); return; }
  let source = ''; for await (const chunk of request) source += chunk;
  try { const { command, args } = JSON.parse(source); response.end(JSON.stringify(backend(command, args))); }
  catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const backendUrl = `http://127.0.0.1:${server.address().port}`;
const vite = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5191', '--strictPort'], { cwd: root, stdio: 'ignore' });
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${work}/chrome`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = ''; const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
    chrome.stderr.on('data', data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:5191')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const page = (await fetch(`http://${new URL(endpoint).host}/json/list`).then(r => r.json())).find(page => page.type === 'page');
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); const entry = pending.get(message.id); if (!entry) return; clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => reject(new Error(`CDP timeout ${method}`)), 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const until = async expression => { for (let i = 0; i < 120; i++) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`UI timeout ${expression}: ${await evaluate('document.body.innerText')}`); };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const graph = ${JSON.stringify(graph)};
    window.__graph = graph;
    window.__files = Object.fromEntries(graph.xmlFiles.map(file => [file.path, file.originalXml]));
    window.__writes = []; window.__alerts = []; window.__failRead = ''; window.__failWrite = ''; window.__badReadback = ''; window.__holdWrite = false;
    window.confirm = () => true; window.alert = message => window.__alerts.push(message);
    localStorage.setItem('jsbsim-language', 'zh-CN'); localStorage.setItem('jsbsim-cache-version', '2');
    localStorage.setItem('jsbsim-project', JSON.stringify(graph)); localStorage.setItem('jsbsim-remote-model', 'test');
    localStorage.setItem('jsbsim-remote-baseline:test', JSON.stringify(graph));
    localStorage.setItem('jsbsim-remote-upload-enabled', 'true');
    window.__TAURI_INTERNALS__ = { metadata: { currentWindow:{label:'main'}, currentWebview:{label:'main'} }, transformCallback:()=>1,
      invoke: async (command, args) => {
        if (['generate_xml','generate_subfile','parse_xml'].includes(command)) {
          const result = await fetch(${JSON.stringify(backendUrl)}, { method:'POST', body:JSON.stringify({command,args}) }).then(r=>r.json());
          if (result.error) throw new Error(result.error); return result;
        }
        if (command === 'ftp_download_xml') {
          if (window.__failRead === args.path) throw new Error('USB timeout');
          if (!(args.path in window.__files)) throw new Error('ENOENT');
          return { path:args.path, content:window.__badReadback === args.path && window.__writes.length ? '<wrong/>' : window.__files[args.path] };
        }
        if (command === 'ftp_list_xml_parent') {
          const files=Object.keys(window.__files).filter(path=>path.startsWith(args.parent+'/')).map(path=>path.slice(args.parent.length+1));
          return { exists: true, files };
        }
        if (command === 'ftp_download_sim_config') {
          if (!(args.path in window.__files)) throw new Error('ENOENT');
          return {path:args.path,content:window.__files[args.path]};
        }
        if (command === 'ftp_upload_sim_config') {window.__writes.push({path:args.path,content:args.content});window.__files[args.path]=args.content;return {saved:true};}
        if (command === 'ftp_upload_file') {
          if (window.__failWrite === args.path) throw new Error('Write failed');
          if (window.__holdWrite) await new Promise(resolve => {window.__releaseWrite=resolve;});
          window.__writes.push({path:args.path,content:args.content});window.__files[args.path]=args.content;return {uploaded:true};
        }
        if (command === 'sim_status') return {external:true,connected:true,running:false,state:'stopped'};
        if (command === 'sim_list_tests') return {tests:[]}; if (command === 'sim_list_models') return {models:[]};
        if (command === 'sim_list_instances') return {instances:[]};
        return {};
      }
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5191/' });
  await until(`document.querySelector('.toolbar')`);
  await evaluate(`(async()=>{window.store=(await import('/src/store/flowStore.ts')).useFlowStore;window.sync=(await import('/src/utils/modelXmlSync.ts'));window.changes=(await import('/src/utils/modelChanges.ts'));window.api=(await import('/src/utils/tauriApi.ts'));})()`);
  await until(`window.store.getState().nodes.length > 0`);
  // Opening/closing a module and reserializing equal model data must never
  // flash a pending notice. A completed empty preparation is authoritative.
  await evaluate(`(()=>{window.__sawNoopNotice=false;window.__noopObserver=new MutationObserver(()=>{if(document.querySelector('.model-sync-bar'))window.__sawNoopNotice=true;});window.__noopObserver.observe(document.body,{childList:true,subtree:true});const s=window.store.getState(),n=s.nodes.find(n=>n.data.componentType==='system');s.setFocusedNodeId(n.id);})()`);
  await until(`document.querySelector('.expr-apply-btn')`);
  await evaluate(`document.querySelector('.expr-apply-btn').click()`);
  await until(`!document.querySelector('.expr-apply-btn')`);
  await evaluate(`(()=>{const s=window.store.getState(),n=s.nodes.find(n=>n.data.componentType==='system'),o=s.nodes.find(n=>n.data.componentType==='output');s.updateNodeParams(n.id,{channels:JSON.stringify(JSON.parse(n.data.params.channels),null,2)});s.updateNodeParams(o.id,{port:'5000.000'});})()`);
  await new Promise(resolve=>setTimeout(resolve,700));
  assert.equal(await evaluate(`Boolean(document.querySelector('.model-sync-bar'))`),false,'format-only candidates produce no pending notice: '+await evaluate(`document.querySelector('.model-sync-bar')?.textContent+' / '+document.querySelector('.model-sync-error')?.textContent`));
  assert.equal(await evaluate(`window.__sawNoopNotice`),false,'no transient notice while semantic preparation runs');
  const noOpPrepared=await evaluate(`(async()=>{const prepared=await window.sync.prepareModelXml(window.store.getState(),window.__graph,'test',window.api);return prepared.filter(d=>d.dirty);})()`);
  assert.deepEqual(noOpPrepared,[],'module round-trip has no real XML delta');
  await evaluate(`(()=>{window.__noopObserver.disconnect();const s=window.store.getState();for(const type of ['system','output']){const n=s.nodes.find(n=>n.data.componentType===type),old=window.__graph.nodes.find(n=>n.data.componentType===type);s.updateNodeParams(n.id,old.data.params);}})()`);
  const deltaCases = await evaluate(`(async()=>{
    const {applyXmlDelta}=await import('/src/utils/xmlDelta.ts');
    const order=applyXmlDelta('<function><!--keep--><difference><property>a</property><value>2</value></difference></function>',
      '<function><difference><property>a</property><value>2</value></difference></function>',
      '<function><difference><product><value>3</value><property>a</property></product><value>2</value></difference></function>');
    const reordered=applyXmlDelta('<channel><pure_gain name="a"><gain>1</gain><vendor/></pure_gain><!--keep--><pure_gain name="b"><gain>2</gain></pure_gain></channel>',
      '<channel><pure_gain name="a"><gain>1</gain></pure_gain><pure_gain name="b"><gain>2</gain></pure_gain></channel>',
      '<channel><pure_gain name="b"><gain>3</gain></pure_gain><pure_gain name="a"><gain>1</gain></pure_gain></channel>');
    const h7=${JSON.stringify(h7Graph)},source=${JSON.stringify(h7Source)};
    const system=h7.nodes.find(n=>n.data.componentType==='system');
    const before=await window.api.generateSubfile('system','H7_Viztra',system.data.params);
    const changed=structuredClone(system.data.params),channels=JSON.parse(changed.channels);
    channels[0].items.push({type:'constant',name:'fcs/sync-test',componentProps:{constant:{value:'2.5'}}});changed.channels=JSON.stringify(channels);
    const after=await window.api.generateSubfile('system','H7_Viztra',changed);
    const patched=applyXmlDelta(source,before,after);
    const unchanged=applyXmlDelta(source,before,before);
    return {order,reordered,patched,unchanged};
  })()`);
  const parseOrder = deltaCases.order.indexOf('<product>') < deltaCases.order.indexOf('<value>2</value>');
  assert.ok(parseOrder, 'Replacing the first operand must preserve expression operand order');
  assert.ok(deltaCases.reordered.indexOf('name="b"') < deltaCases.reordered.indexOf('name="a"'));
  assert.match(deltaCases.reordered, /<gain>3<\/gain>/); assert.match(deltaCases.reordered, /<vendor\/>/);
  assert.equal(deltaCases.unchanged,h7Source);
  const withoutConstant=deltaCases.patched.replace(/\n[ \t]*<fcs_function name="fcs\/sync-test">[\s\S]*?<\/fcs_function>/,'');
  assert.equal(withoutConstant,h7Source,'A real H7 edit preserves every unrelated source byte');
  const sidecars = await evaluate(`(async()=>{
    const {getComponentDef}=await import('/src/utils/componentDefs.ts');
    const {defaultPwmCaptureChannel}=await import('/src/utils/pwmCaptureConfig.ts');
    const base=structuredClone(window.__graph),sensor={id:'sensor',data:{componentType:'serial_sensor',params:Object.fromEntries(Object.entries(getComponentDef('serial_sensor').params).map(([key,def])=>[key,def.default]))}};
    const pwm={id:'pwm',data:{componentType:'pwm_capture',params:{channels:[defaultPwmCaptureChannel('/dev/capture0',0)]}}};
    base.nodes.push(sensor,pwm);base.edges.push({id:'serial-link',source:base.nodes.find(n=>n.data.componentType==='system').id,target:sensor.id});
    const changed=structuredClone(base);changed.aircraft.name='Display Name';changed.nodes.find(n=>n.id==='sensor').data.params.rate=50;changed.nodes.find(n=>n.id==='pwm').data.params.channels[0].failsafe=-0.5;
    const prepared=await window.sync.prepareModelXml(changed,base,'test',window.api);
    const removed=structuredClone(base);removed.nodes=removed.nodes.filter(n=>!['serial_sensor','pwm_capture'].includes(n.data.componentType));removed.edges=removed.edges.filter(e=>e.id!=='serial-link');
    const cleared=await window.sync.prepareModelXml(removed,base,'test',window.api);
    return {prepared:prepared.filter(d=>d.category==='hardware'),cleared:cleared.filter(d=>d.category==='hardware')};
  })()`);
  assert.deepEqual(sidecars.prepared.map(d=>d.path).sort(),['config/models/test.pwm.xml','config/models/test.serial.xml']);
  assert.ok(sidecars.prepared.every(d=>d.dirty));
  assert.match(sidecars.prepared.find(d=>d.path.endsWith('.serial.xml')).content,/rate="50"/);
  assert.match(sidecars.prepared.find(d=>d.path.endsWith('.pwm.xml')).content,/failsafe="-0.5"/);
  assert.ok(sidecars.cleared.every(d=>d.dirty));
  assert.match(sidecars.cleared.find(d=>d.path.endsWith('.serial.xml')).content,/<serial_outputs version="1"\/>/);
  assert.match(sidecars.cleared.find(d=>d.path.endsWith('.pwm.xml')).content,/<pwm_inputs version="1"\/>/);
  const utility = await evaluate(`(async()=>{
    const base=structuredClone(window.__graph); const next=structuredClone(base);
    const types={};for(const n of next.nodes) types[n.data.componentType]=n.data.params;
    types.inertia.ixx={value:7,unit:'SLUG*FT2'};
    types.fuselage.emptywt={value:14,unit:'LBS'};
    types.point_mass.weight={value:4,unit:'LBS'};
    types.wing.wingarea={value:13,unit:'FT2'};
    types.landing_gear.static_friction='0.6';
    types.fuel_tank.contents={value:4,unit:'LBS'};
    types.engine.power={value:150,unit:'WATTS'};types.engine.location.x=8;types.engine.orient.roll=9;
    types.output.port='5100';types.output.properties='velocities/v-fps';
    const channels=JSON.parse(types.system.channels); channels[0].items[0].componentProps.gain.value='3';types.system.channels=JSON.stringify(channels);
    const fc=JSON.parse(types.flight_control.channels);fc[0].items[0].componentProps.gain.value='4';types.flight_control.channels=JSON.stringify(fc);
    const aero=JSON.parse(types.aero_coefficients.coefficients);aero[0].expression.value=5;types.aero_coefficients.coefficients=JSON.stringify(aero);
    window.__edited=next;
    const documents=await window.sync.prepareModelXml(next,base,'test',window.api);
    return {documents,types,paths:window.changes.changedModelPaths(next,base,'test')};
  })()`);
  const docs = Object.fromEntries(utility.documents.map(file => [file.path, file.content]));
  assert.match(docs['aircraft/test/Mass.xml'], /<ixx unit="SLUG\*FT2">7<\/ixx>/);
  assert.match(docs['aircraft/test/Mass.xml'], /<emptywt unit="LBS">14<\/emptywt>/);
  assert.match(docs['aircraft/test/Mass.xml'], /vendor_mass keep="yes"/);
  assert.match(docs['aircraft/test/test.xml'], /mass_balance file="Mass"/);
  assert.match(docs['aircraft/test/test.xml'], /<wingarea unit="FT2">13<\/wingarea>/);
  assert.match(docs['aircraft/test/test.xml'], /<static_friction>0.6<\/static_friction>/);
  assert.match(docs['aircraft/test/test.xml'], /<contents unit="LBS">4<\/contents>/);
  assert.match(docs['aircraft/test/test.xml'], /<gain>4<\/gain>/);
  assert.match(docs['aircraft/test/test.xml'], /<value>5<\/value>/);
  assert.match(docs['aircraft/test/test.xml'], /location unit="IN" x="8" y="2" z="3"/);
  assert.match(docs['aircraft/test/test.xml'], /orient unit="DEG" roll="9" pitch="2" yaw="3"/);
  assert.match(docs['aircraft/test/test.xml'], /port="5100"/);
  assert.match(docs['aircraft/test/test.xml'], /<property>velocities\/v-fps<\/property>/);
  assert.match(docs['aircraft/test/test.xml'], /vendor_output keep="yes"/);
  assert.match(docs['systems/Sensor.xml'], /<gain>3<\/gain>/);
  assert.match(docs['engine/Motor.xml'], /<power unit="WATTS">150<\/power>/);
  assert.equal(docs['engine/direct.xml'], '<direct name="Direct"/>');
  assert.ok(utility.paths.includes('systems/Sensor.xml'));
  // No module-specific dirty flag is needed, including direct setState.
  await evaluate(`window.store.setState({nodes:window.__edited.nodes,edges:window.__edited.edges})`);
  await until(`document.querySelector('.model-sync-bar')`);
  await new Promise(resolve => setTimeout(resolve, 3800));
  assert.match(await evaluate(`document.querySelector('.model-sync-bar').textContent`), /需要保存到仿真机/);
  await evaluate(`[...document.querySelectorAll('.toolbar button')].find(button=>button.textContent.includes('📁 文件')).click()`);
  await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(button=>button.textContent.trim()==='💾 保存').click()`);
  await until(`window.__alerts.some(message=>message.includes('工程已保存'))`);
  assert.ok(await evaluate(`Boolean(document.querySelector('.model-sync-bar'))`),'Saving a local project does not mark the simulator as saved');
  // Discard has its own confirmation and never uploads or reloads the model.
  assert.ok(await evaluate(`(()=>{const button=document.querySelector('.model-sync-save'),r=button.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===button})()`),'The floating HUD must not cover the save action');
  await send('Page.captureScreenshot', { format:'png' }).then(async result => { await writeFile('/tmp/jsbsim-model-sync-bar.png', Buffer.from(result.data,'base64')); });
  await evaluate(`document.querySelector('.model-sync-discard').click()`);
  await until(`document.querySelector('.model-discard-dialog').open`);
  assert.equal(await evaluate(`document.activeElement.textContent`), '继续编辑');
  assert.match(await evaluate(`document.querySelector('.model-discard-dialog').innerText`), /Mass.xml/);
  await send('Page.captureScreenshot', { format:'png' }).then(async result => { await writeFile('/tmp/jsbsim-model-discard-dialog.png', Buffer.from(result.data,'base64')); });
  await evaluate(`document.querySelector('.model-discard-dialog footer button').click()`);
  assert.equal(await evaluate(`String(window.store.getState().nodes.find(n=>n.data.componentType==='output').data.params.port)`),'5100');
  assert.ok(await evaluate(`Boolean(document.querySelector('.model-sync-bar'))`));
  const layoutBeforeDiscard = await evaluate(`window.store.getState().nodes.map(n=>[n.id,n.position])`);
  await evaluate(`document.querySelector('.model-sync-discard').click();document.querySelector('.model-discard-dialog .danger').click()`);
  await until(`!document.querySelector('.model-sync-bar')`);
  assert.equal(await evaluate(`window.__writes.length`), 0);
  assert.equal(await evaluate(`String(window.store.getState().nodes.find(n=>n.data.componentType==='output').data.params.port)`),'5000');
  assert.deepEqual(await evaluate(`window.store.getState().nodes.map(n=>[n.id,n.position])`),layoutBeforeDiscard);
  assert.ok(await evaluate(`window.store.getState().xmlFiles.every(f=>f.currentXml===f.originalXml&&!f.dirty)`));
  assert.equal(await evaluate(`String(JSON.parse(localStorage.getItem('jsbsim-project')).nodes.find(n=>n.data.componentType==='output').data.params.port)`),'5000');
  await new Promise(resolve=>setTimeout(resolve,300));
  await evaluate(`window.store.setState({nodes:window.__edited.nodes,edges:window.__edited.edges})`);
  await until(`document.querySelector('.model-sync-bar')`);
  await evaluate(`document.querySelector('.model-sync-bar .model-sync-save').click()`);
  await until(`document.querySelector('.model-sync-review-footer')`);
  const reviewText = await evaluate(`document.querySelector('.xml-source-browser').innerText`);
  assert.match(reviewText, /Mass.xml/); assert.match(reviewText, /Sensor.xml/); assert.match(reviewText, /Motor.xml/);
  assert.equal(await evaluate(`window.__writes.length`), 0);
  await evaluate(`document.querySelector('.model-sync-review-footer button').click()`);
  await until(`!document.querySelector('.model-sync-review-footer')`);
  assert.ok(await evaluate(`Boolean(document.querySelector('.model-sync-bar'))`));
  // Read failures leave every remote file untouched.
  await evaluate(`window.__failRead='systems/Sensor.xml';document.querySelector('.model-sync-bar .model-sync-save').click()`);
  await until(`document.querySelector('.model-sync-error')?.textContent.includes('USB timeout')`);
  assert.equal(await evaluate(`window.__writes.length`), 0);
  await evaluate(`window.__failRead='';document.querySelector('.model-sync-bar .model-sync-save').click()`);
  await until(`document.querySelector('.model-sync-review-footer')`);
  await send('Page.captureScreenshot', { format:'png' }).then(async result => { await writeFile('/tmp/jsbsim-model-sync-review.png', Buffer.from(result.data,'base64')); });
  await evaluate(`document.querySelector('.model-sync-review-footer .primary').click()`);
  await until(`!document.querySelector('.model-sync-bar') && !document.querySelector('.model-sync-review-footer')`);
  assert.equal(await evaluate(`window.__writes.length`), 4);
  const written = await evaluate(`window.__writes`);
  for (const file of written) assert.equal(file.content, docs[file.path], `preview and upload agree for ${file.path}`);
  // Undo across a successful save edits the model while retaining the latest
  // verified source snapshots; it must not restore stale source-only history.
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))`);
  await until(`document.querySelector('.model-sync-bar')`);
  assert.equal(await evaluate(`String(window.store.getState().nodes.find(n=>n.data.componentType==='output').data.params.port)`),'5000');
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true}))`);
  await until(`!document.querySelector('.model-sync-bar')`);
  // Layout and selection have no XML changes; reverting parameters clears pending state.
  await evaluate(`(()=>{const s=window.store.getState();s.onNodesChange([{type:'position',id:s.nodes[0].id,position:{x:999,y:999}}]);s.updateNodeParams(s.nodes[0].id,{layout:{canvas:{x:3,y:4}}});s.setSelectedNode(s.nodes[0].id)})()`);
  assert.equal(await evaluate(`Boolean(document.querySelector('.model-sync-bar'))`), false);
  await evaluate(`(()=>{const s=window.store.getState();const n=s.nodes.find(n=>n.data.componentType==='output');s.updateNodeParams(n.id,{port:'5200'})})()`);
  await until(`document.querySelector('.model-sync-bar')`);
  await evaluate(`(()=>{const s=window.store.getState();const n=s.nodes.find(n=>n.data.componentType==='output');s.updateNodeParams(n.id,{port:'5100'})})()`);
  await until(`!document.querySelector('.model-sync-bar')`);
  // Check actual undo/redo against the saved baseline.
  await new Promise(resolve=>setTimeout(resolve,300));
  await evaluate(`(()=>{const s=window.store.getState();const n=s.nodes.find(n=>n.data.componentType==='output');s.updateNodeParams(n.id,{port:'5200'})})()`);
  await until(`document.querySelector('.model-sync-bar')`);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))`);
  await until(`!document.querySelector('.model-sync-bar')`);
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true}))`);
  await until(`document.querySelector('.model-sync-bar')`);
  // Detect a remote change after review before writing anything.
  const writesBeforeRace=await evaluate('window.__writes.length');
  await evaluate(`document.querySelector('.model-sync-bar .model-sync-save').click()`);
  await until(`document.querySelector('.model-sync-review-footer')`);
  await evaluate(`window.__files['aircraft/test/test.xml']+='\\n<!-- changed elsewhere -->';document.querySelector('.model-sync-review-footer .primary').click()`);
  await until(`document.querySelector('.model-sync-error')?.textContent.includes('在对比后已变化')`);
  assert.equal(await evaluate('window.__writes.length'),writesBeforeRace);
  // Edits made while an upload is waiting must remain pending after success.
  await evaluate(`window.__holdWrite=true;document.querySelector('.model-sync-bar .model-sync-save').click()`);
  await until(`document.querySelector('.model-sync-review-footer')`);
  await evaluate(`document.querySelector('.model-sync-review-footer .primary').click()`);
  await until('window.__releaseWrite');
  await evaluate(`(()=>{const s=window.store.getState(),n=s.nodes.find(n=>n.data.componentType==='output');s.updateNodeParams(n.id,{port:'5400'});window.__holdWrite=false;window.__releaseWrite();window.__releaseWrite=null})()`);
  await until(`!document.querySelector('.model-sync-review-footer') && document.querySelector('.model-sync-bar .model-sync-save') && !document.querySelector('.model-sync-bar .model-sync-save').disabled`);
  assert.ok(await evaluate(`Boolean(document.querySelector('.model-sync-bar'))`));
  const pendingBaseline=await evaluate(`JSON.parse(localStorage.getItem('jsbsim-remote-baseline:test')).nodes.find(n=>n.data.componentType==='output').data.params.port`);
  assert.equal(String(pendingBaseline),'5200');
  assert.equal(await evaluate(`String(window.store.getState().nodes.find(n=>n.data.componentType==='output').data.params.port)`),'5400');
  // A failure after upload must not advance the saved baseline.
  await evaluate(`(()=>{const s=window.store.getState();const n=s.nodes.find(n=>n.data.componentType==='output');s.updateNodeParams(n.id,{port:'5300'});window.__badReadback='aircraft/test/test.xml'})()`);
  await until(`document.querySelector('.model-sync-bar')`);
  await evaluate(`document.querySelector('.model-sync-bar .model-sync-save').click()`);
  // The test's bad readback flag applies only after a new write below.
  await until(`document.querySelector('.model-sync-review-footer')`);
  await evaluate(`document.querySelector('.model-sync-review-footer .primary').click()`);
  await until(`document.querySelector('.model-sync-error')?.textContent.includes('回读不一致')`);
  assert.ok(await evaluate(`Boolean(document.querySelector('.model-sync-bar'))`));
  assert.equal(await evaluate(`String(JSON.parse(localStorage.getItem('jsbsim-remote-baseline:test')).nodes.find(n=>n.data.componentType==='output').data.params.port)`),'5200');
  // Environment edits use the same explicit save and readback flow, preserving other JSON groups.
  await evaluate(`(()=>{const s=window.store.getState(),n=s.nodes.find(n=>n.data.componentType==='output');window.__badReadback='';s.updateNodeParams(n.id,{port:'5200'});window.__files['config/models/test.json']=JSON.stringify({version:1,runtime:{dt:.004},diagnostics:{usbDebugPrint:true},environment:{windNorthFps:2,customField:17}},null,2);s.addNode('environment',{x:30,y:30});const env=window.store.getState().nodes.find(n=>n.data.componentType==='environment');window.store.getState().updateNodeParams(env.id,{wind_north_fps:20,wind_east_fps:3});})()`);
  await until(`document.querySelector('.model-sync-bar')`);
  await evaluate(`document.querySelector('.model-sync-bar .model-sync-save').click()`);
  await until(`document.querySelector('.model-sync-review-footer')`);
  assert.ok(await evaluate(`document.querySelector('.xml-source-browser').textContent.includes('test.json')`),'environment JSON is reviewable before save');
  await evaluate(`document.querySelector('.model-sync-review-footer .primary').click()`);
  await until(`!document.querySelector('.model-sync-bar')`);
  const config=await evaluate(`JSON.parse(window.__files['config/models/test.json'])`);
  assert.equal(config.environment.windNorthFps,20);assert.equal(config.environment.windEastFps,3);
  assert.equal(config.environment.customField,17);assert.equal(config.runtime.dt,.004);assert.equal(config.diagnostics.usbDebugPrint,true);
  // Restore a compact baseline after successful saves: original verified XML,
  // deleted nodes, connections and environment all return; new nodes go away.
  const savedSources=await evaluate(`window.store.getState().xmlFiles.map(f=>[f.path,f.originalXml])`);
  const savedNodeIds=await evaluate(`window.store.getState().nodes.map(n=>n.id)`);
  const savedEdges=await evaluate(`window.store.getState().edges.map(e=>[e.id,e.source,e.target,e.sourceHandle,e.targetHandle])`);
  const savedBaseline=await evaluate(`localStorage.getItem('jsbsim-remote-baseline:test')`);
  const writesBeforeDiscard=await evaluate(`window.__writes.length`);
  await evaluate(`(()=>{const s=window.store.getState(),env=s.nodes.find(n=>n.data.componentType==='environment'),output=s.nodes.find(n=>n.data.componentType==='output');s.updateNodeParams(env.id,{wind_north_fps:99});s.removeNode(output.id);s.addNode('point_mass',{x:400,y:300});const live=window.store.getState();window.store.setState({edges:[],xmlFiles:live.xmlFiles.map(f=>f.category==='main'?{...f,currentXml:f.originalXml.replace('port="5200"','port="5999"'),dirty:true}:f)})})()`);
  await until(`document.querySelector('.model-sync-bar')`);
  await evaluate(`document.querySelector('.model-sync-discard').click();document.querySelector('.model-discard-dialog .danger').click()`);
  await until(`!document.querySelector('.model-sync-bar')`);
  assert.deepEqual(await evaluate(`window.store.getState().nodes.map(n=>n.id)`),savedNodeIds);
  assert.deepEqual(await evaluate(`window.store.getState().edges.map(e=>[e.id,e.source,e.target,e.sourceHandle,e.targetHandle])`),savedEdges);
  assert.deepEqual(await evaluate(`window.store.getState().xmlFiles.map(f=>[f.path,f.currentXml])`),savedSources);
  assert.equal(await evaluate(`window.store.getState().nodes.find(n=>n.data.componentType==='environment').data.params.wind_north_fps`),20);
  assert.equal(await evaluate(`localStorage.getItem('jsbsim-remote-baseline:test')`),savedBaseline);
  assert.equal(await evaluate(`window.__writes.length`),writesBeforeDiscard);
  // An imported model can discard edits without claiming an initial upload.
  await evaluate(`(()=>{const s=window.store.getState();localStorage.removeItem('jsbsim-remote-baseline:test');window.dispatchEvent(new Event('jsbsim-remote-baseline-changed'));s.updateNodeParams(s.nodes.find(n=>n.data.componentType==='output').id,{port:'5600'})})()`);
  await until(`document.querySelector('.model-sync-discard')&&!document.querySelector('.model-sync-discard').disabled`);
  await evaluate(`document.querySelector('.model-sync-discard').click();document.querySelector('.model-discard-dialog .danger').click()`);
  await until(`document.querySelector('.model-sync-discard').disabled`);
  assert.equal(await evaluate(`String(window.store.getState().nodes.find(n=>n.data.componentType==='output').data.params.port)`),'5200');
  assert.match(await evaluate(`document.querySelector('.model-sync-bar').innerText`), /尚未保存到仿真机/);
  assert.equal(await evaluate(`window.__writes.length`),writesBeforeDiscard);
  // Long paths and both actions stay inside the notice at narrower widths.
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.ok(await evaluate(`(()=>{const bar=document.querySelector('.model-sync-bar').getBoundingClientRect();return [...document.querySelectorAll('.model-sync-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=bar.left&&r.right<=bar.right&&r.bottom<=bar.bottom})})()`));
  await send('Page.captureScreenshot', { format:'png' }).then(async result => { await writeFile('/tmp/jsbsim-model-sync-narrow.png', Buffer.from(result.data,'base64')); });
  console.log('PASS: real XML edits, source preservation, comparison, cancel, verified save, undo/redo, remote races, environment JSON, confirmed local discard, compact-baseline source/graph restoration, layout retention, initial-upload state and responsive notice');
} finally {
  socket?.close(); chrome.kill('SIGTERM'); vite.kill('SIGTERM'); server.close();
  await rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
