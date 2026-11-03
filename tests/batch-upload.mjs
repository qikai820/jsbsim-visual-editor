// Regression: adding one canvas constant must not reformat H7_Viztra.xml.
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const fixture = new URL('../client/.batch-upload-test.html', import.meta.url);
await writeFile(fixture, '<html><body>XML patch test</body></html>');
const profile = await mkdtemp(path.join(tmpdir(), 'jsbsim-batch-upload-'));
const vite = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5188', '--strictPort'], { stdio: 'ignore' });
const chrome = spawn('/usr/bin/google-chrome-stable', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const endpointPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000);
  let stderr = '';
  chrome.stderr.on('data', data => {
    stderr += String(data);
    const match = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  chrome.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}/${signal}: ${stderr.slice(-1000)}`)); });
});
let socket;
try {
  const endpoint = await endpointPromise;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://127.0.0.1:5188/.batch-upload-test.html')).ok) break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const page = (await fetch(`http://${new URL(endpoint).host}/json/list`).then(response => response.json()))
    .find(target => target.type === 'page');
  assert.ok(page);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const entry = pending.get(result.id);
    if (!entry) return;
    pending.delete(result.id);
    if (result.error) entry.reject(new Error(JSON.stringify(result.error)));
    else entry.resolve(result.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.navigate', { url: 'http://127.0.0.1:5188/.batch-upload-test.html' });
  const expression = `(async () => {
    const files = { 'systems/a.xml': '<system>old</system>', 'systems/b.xml': '<system>same</system>' };
    const writes = [], dialogs = [];
    window.confirm = message => { dialogs.push(message); return true; };
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'ftp_list_xml_parent') return { exists: true, files: Object.keys(files).map(path => path.split('/').pop()) };
      if (command === 'ftp_download_xml') return { path: args.path, content: files[args.path] };
      if (command === 'ftp_upload_file') { writes.push(args.path); files[args.path] = args.content; return { path: args.path, uploaded: true }; }
      throw new Error('Unexpected command: ' + command);
    } };
    localStorage.setItem('jsbsim-remote-upload-enabled', 'true');
    const { ftpUploadFile } = await import('/src/utils/tauriApi.ts');
    await ftpUploadFile('systems/a.xml', '<system>new</system>', { batchConfirmed: true });
    await ftpUploadFile('systems/b.xml', '<system>same</system>', { batchConfirmed: true });
    const batchDialogs = dialogs.length;
    await ftpUploadFile('systems/a.xml', '<system>single</system>');
    return { writes, batchDialogs, totalDialogs: dialogs.length };
  })()`;
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  assert.deepEqual(result.result.value, { writes: ['systems/a.xml', 'systems/a.xml'], batchDialogs: 0, totalDialogs: 1 });
  console.log('PASS: batch uploads skip per-file prompts and unchanged files; single uploads still prompt');
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  vite.kill('SIGTERM');
  await rm(fixture, { force: true });
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
