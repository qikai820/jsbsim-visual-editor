// Isolated Chromium regression test. Uses real model XML; mocks only desktop
// IPC so no simulator, application profile, or source models are modified.
// Usage (Node 20): node --experimental-websocket tests/model-import-ui.mjs [Vite URL] [model directory]
import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const baseUrl = process.argv[2] || 'http://localhost:5174';
const directory = process.argv[3] || '/home/qikai820/src/px4-jsbsim-bridge/models/quadrotor_x';
async function scan(dir, prefix = '') {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isDirectory()) result.push(...await scan(path.join(dir, item.name), name + '/'));
    else if (item.isFile() && /\.xml$/i.test(name)) result.push({ name, xml: await readFile(path.join(dir, item.name), 'utf8') });
  }
  return result;
}
const files = await scan(directory);
const fixture = { directory, mainFile: 'quadrotor_x.xml', files };
const firmwareFixture = { path: '/tmp/firmware/nuttx.bin', name: 'nuttx.bin', size: 1024 * 1024 };
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
      const result = await evaluate(`Boolean(${expression})`);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`UI timeout: ${expression}\nAlerts: ${JSON.stringify(await evaluate('window.__alerts'))}\nCalls: ${JSON.stringify(await evaluate('window.__calls.map(call => call.command)'))}\n${await evaluate('document.body.innerText')}`);
  }
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__fixture = ${JSON.stringify(fixture)};
    window.__firmwareSelection = ${JSON.stringify(firmwareFixture)};
    window.__calls = []; window.__alerts = [];
    window.alert = message => window.__alerts.push(message);
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        window.__calls.push({ command, args });
        if (command === 'select_model_import') return window.__fixture;
        if (command === 'select_firmware_file') return window.__firmwareSelection;
        if (command === 'parse_xml') return {
          aircraft: { name: new DOMParser().parseFromString(args.xml, 'application/xml').documentElement.getAttribute('name') },
          nodes: [], edges: [], subFiles: [], xmlFiles: [],
          packageFiles: args.files.map(file => ({ path: file.name, category: file.category, xml: file.xml }))
        };
        return {};
      }
    };
  ` });
  await send('Page.navigate', { url: baseUrl });
  await until('document.querySelector(".file-menu-trigger")');
  async function openImport(folder = false) {
    await evaluate('document.querySelector(".file-menu-trigger").click()');
    await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(button => ${folder
      ? '/导入 XML 目录|Import XML folder/.test(button.textContent)'
      : '/自动关联同目录|Import XML with siblings/.test(button.textContent)'}).click()`);
  }
  await openImport();
  await until('document.querySelector(".model-import-dialog")');
  assert.equal(await evaluate('window.__calls.find(call => call.command === "select_model_import").args.initialDirectory'), null);
  assert.equal(await evaluate('localStorage.getItem("jsbsim-last-model-import-directory")'), directory);
  assert.equal(await evaluate('document.querySelectorAll(".model-import-associated li").length'), files.length);
  const initNames = await evaluate(`Array.from(document.querySelectorAll('.model-import-associated li')).filter(li => li.querySelector('select')?.value === 'initialization').map(li => li.querySelector('span:not(.model-import-file-icon)').textContent)`);
  assert.deepEqual(initNames.sort(), ['initfile.xml', 'reset.xml']);
  assert.equal(await evaluate('document.querySelector(".model-import-name input").value'), 'quadrotor_x');
  assert.ok((await evaluate('document.querySelector(".model-import-dialog").innerText')).includes(directory));
  await evaluate('document.querySelector(".model-import-dialog footer button:last-child").click()');
  await until('document.querySelector(".xml-import-files-dialog")');
  assert.equal(await evaluate('localStorage.getItem("jsbsim-remote-model")'), 'quadrotor_x');
  const summary = await evaluate('document.querySelector(".xml-import-files-dialog").innerText');
  assert.match(summary, /已关联 2 个初始化/);
  assert.match(summary, /initfile.xml/); assert.match(summary, /reset.xml/);
  const imported = await evaluate('window.__calls.find(call => call.command === "parse_xml").args');
  assert.match(imported.xml, /<fdm_config[^>]*name="quadrotor_x"/);
  assert.equal(imported.files.find(file => file.name === 'initfile.xml').xml, files.find(file => file.name === 'initfile.xml').xml);
  await evaluate('document.querySelector(".xml-import-files-dialog footer button").click()');
  // Repeat the same folder: arbitrary initialization filename plus an XML
  // comment before the root must still be recognized. Non-XML is excluded by
  // the production scanner tested separately in Rust.
  await evaluate(`window.__fixture.mainFile = null; window.__fixture.files.push({name:'custom-start.xml',xml:'<?xml version="1.0"?><!-- start --><initialize/>'})`);
  await openImport(true);
  await until('document.querySelector(".model-import-dialog")');
  assert.equal(await evaluate('window.__calls.filter(call => call.command === "select_model_import").at(-1).args.initialDirectory'), directory);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.model-import-associated select')).filter(select => select.value === 'initialization').length`), 3);
  await evaluate('document.querySelector(".model-import-check input").click()');
  await evaluate('document.querySelector(".model-import-dialog footer button:last-child").click()');
  await until('document.querySelector(".xml-import-files-dialog")');
  assert.equal(await evaluate('localStorage.getItem("jsbsim-remote-model")'), 'quadrotor_x');
  assert.match(await evaluate('localStorage.getItem("jsbsim-raw-xml")'), /<fdm_config[^>]*name="dflyer"/);
  await evaluate('document.querySelector(".xml-import-files-dialog footer button").click()');
  await evaluate('window.__fixture = null');
  await openImport();
  await until('!document.querySelector(".file-menu-trigger").disabled');
  assert.equal(await evaluate('localStorage.getItem("jsbsim-last-model-import-directory")'), directory);
  assert.equal(await evaluate('Boolean(document.querySelector(".model-import-dialog"))'), false);
  await evaluate('window.__reloadMarker = true');
  await send('Page.reload');
  await until('window.__reloadMarker !== true && document.querySelector(".file-menu-trigger")');
  await openImport();
  await until('!document.querySelector(".file-menu-trigger").disabled');
  assert.equal(await evaluate('window.__calls.filter(call => call.command === "select_model_import").at(-1).args.initialDirectory'), directory);
  async function openFirmwarePage() {
    await evaluate(`Array.from(document.querySelectorAll('button')).find(button => /⚙ (Simulation|仿真配置)/.test(button.textContent)).click()`);
    await until('document.querySelector(".sim-config-overlay")');
    await evaluate(`Array.from(document.querySelectorAll('.sim-config-overlay button')).find(button => /Upgrade Firmware|升级固件/.test(button.textContent)).click()`);
    await until('document.querySelector(".firmware-file-picker")');
  }
  await openFirmwarePage();
  await evaluate('document.querySelector(".firmware-file-picker").click()');
  await until('localStorage.getItem("jsbsim-last-firmware-path")');
  assert.equal(await evaluate('window.__calls.filter(call => call.command === "select_firmware_file").at(-1).args.previousPath'), null);
  assert.equal(await evaluate('localStorage.getItem("jsbsim-last-firmware-path")'), firmwareFixture.path);
  assert.equal(await evaluate('window.__calls.some(call => call.command.startsWith("firmware_stage"))'), false);
  await evaluate('window.__firmwareSelection = null');
  await evaluate('document.querySelector(".firmware-file-picker").click()');
  await until('window.__calls.filter(call => call.command === "select_firmware_file").length === 2');
  assert.equal(await evaluate('localStorage.getItem("jsbsim-last-firmware-path")'), firmwareFixture.path);
  await evaluate('window.__reloadMarker = true');
  await send('Page.reload');
  await until('window.__reloadMarker !== true && document.querySelector(".file-menu-trigger")');
  await openFirmwarePage();
  await evaluate('document.querySelector(".firmware-file-picker").click()');
  await until('window.__calls.some(call => call.command === "select_firmware_file")');
  assert.equal(await evaluate('window.__calls.find(call => call.command === "select_firmware_file").args.previousPath'), firmwareFixture.path);
  assert.deepEqual(await evaluate('window.__alerts'), []);
  console.log(`PASS: ${files.length} real XML files; remembered model and firmware paths after reload; cancel preserves each path; firmware selection does not start upgrade. Desktop IPC was mocked.`);
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
