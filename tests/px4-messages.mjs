import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const dir = await mkdtemp('/tmp/px4-messages-');
try {
  await build({ stdin: { contents: `export * from './client/src/px4/messages';export * from './client/src/px4/protocol';`, resolveDir: process.cwd() }, outfile: dir + '/test.cjs', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { Px4Messages, PX4_MESSAGE_LIMIT, Parser, encode } = createRequire(import.meta.url)(dir + '/test.cjs');
  const buffer = new Px4Messages(), parser = new Parser(), encoder = new TextEncoder();
  const emit = (text, severity = 6, id = 0, chunk = 0, system = 7, component = 1, now = 100) => {
    const p = new Uint8Array(54); p[0] = severity;
    p.set(typeof text === 'string' ? encoder.encode(text) : text, 1);
    p[51] = id & 255; p[52] = id >> 8; p[53] = chunk;
    const frame = parser.push(encode(253, p, 0, system, component))[0];
    buffer.receive(frame, now);
  };
  let notifications = 0; const unsubscribe = buffer.subscribe(() => notifications++);
  emit('Ready'); emit('Preflight: sensor warning', 4); emit('Critical failure', 2);
  assert.deepEqual(buffer.getSnapshot().map(({ text, severity, system, component }) => ({ text, severity, system, component })), [
    { text: 'Ready', severity: 6, system: 7, component: 1 },
    { text: 'Preflight: sensor warning', severity: 4, system: 7, component: 1 },
    { text: 'Critical failure', severity: 2, system: 7, component: 1 },
  ]);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(notifications, 1, 'bursts produce one UI update');
  emit('X'.repeat(50), 6); assert.equal(buffer.getSnapshot().at(-1).text.length, 50, 'legacy non-terminated 50-byte message displays immediately');
  buffer.clear();
  const unicode = 'a'.repeat(49) + '飞控打印正常', raw = encoder.encode(unicode);
  emit(raw.slice(0, 50), 4, 1025); const original = buffer.getSnapshot()[0];
  emit('other stream', 6, 1026);
  emit(raw.slice(50), 4, 1025, 1);
  assert.equal(buffer.getSnapshot().length, 2);
  assert.equal(buffer.getSnapshot()[0].text, unicode, 'UTF-8 split across wire chunks is reassembled');
  assert.equal(buffer.getSnapshot()[0].id, original.id); assert.equal(buffer.getSnapshot()[0].incomplete, false);
  buffer.clear();
  emit('A'.repeat(50), 6, 5); emit('B'.repeat(50), 6, 5, 1); emit('B'.repeat(50), 6, 5, 1); emit('done', 6, 5, 2);
  assert.equal(buffer.getSnapshot()[0].text, 'A'.repeat(50) + 'B'.repeat(50) + 'done', 'duplicate continuation is ignored');
  buffer.clear();
  emit('A'.repeat(50), 6, 5); emit('tail', 6, 5, 2);
  assert.equal(buffer.getSnapshot()[0].incomplete, true); assert.match(buffer.getSnapshot()[0].text, /缺失分片/);
  emit('orphan', 6, 6, 1); assert.equal(buffer.getSnapshot().at(-1).incomplete, true);
  buffer.clear();
  emit('A'.repeat(50), 6, 5, 0, 7, 1, 100); emit('new tail', 6, 5, 1, 7, 1, 6000);
  assert.equal(buffer.getSnapshot().length, 2, 'expired message IDs cannot splice unrelated text');
  buffer.clear(); emit('A'.repeat(50), 6, 5); buffer.resetAssembly(); emit('after reconnect', 6, 5, 1);
  assert.equal(buffer.getSnapshot().length, 2, 'connection replacement resets assembly while retaining history');
  buffer.clear(); emit('A'.repeat(50), 6, 5); buffer.clear(); emit('after clear', 6, 5, 1);
  assert.equal(buffer.getSnapshot().length, 1); assert.equal(buffer.getSnapshot()[0].text, 'after clear');
  buffer.clear(); emit('A'.repeat(50), 6, 5); emit('other component', 6, 5, 1, 7, 2);
  assert.equal(buffer.getSnapshot().length, 2, 'different senders never share a chunk assembly');
  buffer.clear(); emit('', 6); emit('invalid severity', 255);
  buffer.receive({ id: 126, payload: new Uint8Array(81), signed: false });
  buffer.receive({ id: 253, payload: new Uint8Array(5), signed: false });
  buffer.receive({ id: 253, payload: new Uint8Array(54), signed: true });
  assert.equal(buffer.getSnapshot().length, 0);
  for (let i = 0; i < PX4_MESSAGE_LIMIT + 7; i++) emit('line ' + i);
  assert.equal(buffer.getSnapshot().length, PX4_MESSAGE_LIMIT); assert.equal(buffer.getSnapshot()[0].text, 'line 7');
  buffer.clear(); unsubscribe();
  console.log('PASS PX4 messages: wire decoding, severity, batching, UTF-8 chunks, duplicates, missing chunks, expiry, connection reset, sender isolation, history limit and clear.');
} finally { await rm(dir, { recursive: true, force: true }); }
