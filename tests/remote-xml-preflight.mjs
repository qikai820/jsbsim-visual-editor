// Exercise the real desktop upload adapter with isolated browser IPC mocks.
// No board is contacted. Node 20: node --experimental-websocket tests/remote-xml-preflight.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const profile = await mkdtemp(path.join(tmpdir(), 'jsbsim-preflight-'));
const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
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
    page = (await fetch(`http://${new URL(endpoint).host}/json/list`).then(response => response.json()))
      .find(target => target.type === 'page');
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    if (!pending.has(result.id)) return;
    const { resolve, reject, timer } = pending.get(result.id);
    clearTimeout(timer); pending.delete(result.id);
    if (result.error) reject(new Error(JSON.stringify(result.error)));
    else resolve(result.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  const evalPage = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__case = { files: [], calls: [], confirmations: [], listError: '', downloadError: '' };
    window.confirm = message => { window.__case.confirmations.push(message); return true; };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      invoke: async (command, args) => {
        if (command.startsWith('ftp_')) window.__case.calls.push(command);
        if (command === 'ftp_list_xml_parent') {
          if (window.__case.listError) throw new Error(window.__case.listError);
          return { exists: window.__case.parentExists !== false, files: window.__case.files };
        }
        if (command === 'ftp_download_model' || command === 'ftp_download_xml') {
          if (window.__case.downloadError) throw new Error(window.__case.downloadError);
          return { xml: '<old/>', content: '<old/>' };
        }
        if (command === 'ftp_upload_model' || command === 'ftp_upload_file') return { uploaded: true };
        return {};
      }
    };
  ` });
  await send('Page.navigate', { url: 'http://localhost:5174/' });
  for (let i = 0; i < 100; i++) {
    if (await evalPage('document.readyState === "complete" && Boolean(window.__TAURI_INTERNALS__)')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await evalPage('localStorage.setItem("jsbsim-remote-upload-enabled", "true")');
  const run = (setup, operation) => evalPage(`(async () => {
    window.__case = { files: [], calls: [], confirmations: [], listError: '', downloadError: '', ...${JSON.stringify(setup)} };
    const api = await import('/src/utils/tauriApi.ts');
    let result, error;
    try { result = await ${operation}; } catch (caught) { error = caught.message; }
    return { result, error, calls: window.__case.calls, confirmations: window.__case.confirmations };
  })()`);
  const newModel = await run({ parentExists: false }, `api.ftpUploadModel('quadrotor_x', '<new/>')`);
  assert.deepEqual(newModel.calls, ['ftp_list_xml_parent', 'ftp_upload_model']);
  assert.match(newModel.confirmations[0], /将新建/);
  assert.equal(newModel.result.uploaded, true);
  const oldModel = await run({ files: ['quadrotor_x.xml'] }, `api.ftpUploadModel('quadrotor_x', '<new/>')`);
  assert.deepEqual(oldModel.calls, ['ftp_list_xml_parent', 'ftp_download_model', 'ftp_upload_model']);
  assert.match(oldModel.confirmations[0], /即将更新/);
  const listFailure = await run({ listError: 'USB timeout' }, `api.ftpUploadModel('quadrotor_x', '<new/>')`);
  assert.deepEqual(listFailure.calls, ['ftp_list_xml_parent']);
  assert.match(listFailure.error, /USB timeout/);
  const readFailure = await run({ files: ['quadrotor_x.xml'], downloadError: 'errno 20' }, `api.ftpUploadModel('quadrotor_x', '<new/>')`);
  assert.deepEqual(readFailure.calls, ['ftp_list_xml_parent', 'ftp_download_model']);
  assert.match(readFailure.error, /errno 20/);
  const existingEngine = await run({ files: ['propeller.xml'] }, `api.ftpUploadFile('engine/propeller.xml', '<new/>')`);
  assert.deepEqual(existingEngine.calls, ['ftp_list_xml_parent', 'ftp_download_xml', 'ftp_upload_file']);
  const newSystem = await run({}, `api.ftpUploadFile('systems/new_sensor.xml', '<new/>')`);
  assert.deepEqual(newSystem.calls, ['ftp_list_xml_parent', 'ftp_upload_file']);
  const newNestedReference = await run({ parentExists: false }, `api.ftpUploadFile('aircraft/quadrotor_x/Models/quadrotor_x.xml', '<new/>')`);
  assert.deepEqual(newNestedReference.calls, ['ftp_list_xml_parent', 'ftp_upload_file']);
  assert.match(newNestedReference.confirmations[0], /将新建/);
  console.log('PASS: new XML creation, existing XML comparison, error stop, engine overwrite protection');
} finally {
  socket?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill('SIGTERM');
  await stopped;
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
