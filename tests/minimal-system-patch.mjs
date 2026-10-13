// Regression: adding one canvas constant must not reformat H7_Viztra.xml.
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const source = await readFile(new URL('../../jsbsim_realtime/data/aviation/aircraft/H7/H7_Viztra.xml', import.meta.url), 'utf8');
const actualCandidate = process.argv[2] ? await readFile(process.argv[2], 'utf8') : null;
const fixture = new URL('../client/.minimal-system-patch.html', import.meta.url);
await writeFile(fixture, '<html><body>XML patch test</body></html>');
const profile = await mkdtemp(path.join(tmpdir(), 'jsbsim-xml-patch-'));
const vite = spawn('node_modules/.bin/vite', ['--host', '127.0.0.1', '--port', '5187', '--strictPort'], { stdio: 'ignore' });
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
    try { if ((await fetch('http://127.0.0.1:5187/.minimal-system-patch.html')).ok) break; }
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
  await send('Page.navigate', { url: 'http://127.0.0.1:5187/.minimal-system-patch.html' });
  const expression = `(async () => {
    const { patchExistingSubfileXml } = await import('/src/utils/sourcePreservingXml.ts');
    const source = ${JSON.stringify(source)};
    const candidate = new DOMParser().parseFromString(source, 'application/xml');
    const stripFormatting = node => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.COMMENT_NODE || (child.nodeType === Node.TEXT_NODE && !child.nodeValue.trim())) child.remove();
        else stripFormatting(child);
      }
    };
    stripFormatting(candidate.documentElement);
    const withoutConstant = new XMLSerializer().serializeToString(candidate);
    const unchanged = patchExistingSubfileXml(source, 'system', {}, withoutConstant);
    const channel = candidate.querySelector('channel');
    const constant = candidate.createElement('fcs_function');
    constant.setAttribute('name', 'fcs/constant-1');
    const fn = candidate.createElement('function');
    const value = candidate.createElement('value');
    value.textContent = '0';
    fn.appendChild(value);
    constant.appendChild(fn);
    channel.appendChild(constant);
    const patched = patchExistingSubfileXml(source, 'system', {}, new XMLSerializer().serializeToString(candidate));
    const removed = patchExistingSubfileXml(patched, 'system', {}, withoutConstant);
    const edited = candidate.cloneNode(true);
    edited.querySelector('function[name="px4/viztra/motion-trigger"] value').textContent = '-4';
    const patchedValue = patchExistingSubfileXml(source, 'system', {}, new XMLSerializer().serializeToString(edited));
    const actualPatch = ${JSON.stringify(actualCandidate)}
      ? patchExistingSubfileXml(source, 'system', {}, ${JSON.stringify(actualCandidate)}) : null;
    return { patched, unchanged, patchedValue, removed, actualPatch };
  })()`;
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  const { patched, unchanged, patchedValue, removed, actualPatch } = result.result.value;
  const assertExact = (actual, expected, label) => {
    if (actual === expected) return;
    let index = 0;
    while (index < actual.length && index < expected.length && actual[index] === expected[index]) index++;
    throw new Error(`${label}: first difference at ${index}; got ${JSON.stringify(actual.slice(index, index + 100))}, expected ${JSON.stringify(expected.slice(index, index + 100))}`);
  };
  assertExact(unchanged, source, 'Saving an unchanged system is byte-for-byte stable');
  const insertion = /\n([ \t]*)<\/channel>/.exec(source);
  assert.ok(insertion, 'Source channel has a closing line');
  const expected = source.replace(insertion[0],
    `\n${insertion[1]}  <fcs_function name="fcs/constant-1"><function><value>0</value></function></fcs_function>${insertion[0]}`);
  assertExact(patched, expected, 'A single new constant is the only XML change');
  assertExact(removed, source, 'Removing the constant restores the original XML');
  assertExact(patchedValue, expected.replace('<value>-3.280839895</value>', '<value>-4</value>'),
    'Editing one existing value changes only that value and the new constant');
  if (actualPatch) {
    const start = actualPatch.indexOf('<fcs_function name="fcs/constant-1">');
    assert.ok(start > 0, 'The actual generator includes the new constant');
    const end = actualPatch.indexOf('</fcs_function>', start) + '</fcs_function>'.length;
    assert.ok(end > start);
    const lineStart = actualPatch.lastIndexOf('\n', start);
    assertExact(actualPatch.slice(0, lineStart) + actualPatch.slice(end), source,
      'Actual Rust parse/generate result changes only the new constant');
  }
  console.log('PASS: H7 XML keeps every original byte except the new constant line');
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  vite.kill('SIGTERM');
  await rm(fixture, { force: true });
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
