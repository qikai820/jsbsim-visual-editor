import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const work = await mkdtemp('/tmp/jsbsim-browser-cache-');
const previousStorage = globalThis.localStorage;
try {
  await build({ entryPoints: ['client/src/utils/browserCache.ts'], outfile: work + '/cache.cjs', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { cacheLocalText, trimBrowserCaches, tryStoreLocalText } = createRequire(import.meta.url)(work + '/cache.cjs');
  const values = new Map();
  let full = false;
  globalThis.localStorage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key),
    setItem(key, value) { if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); values.set(key, value); },
  };
  const protectedKeys = ['jsbsim-project', 'jsbsim-raw-xml', 'jsbsim-reference-files', 'jsbsim-remote-baseline:MorphQuad', 'px4-flight-test-workspace-v1', 'jsbsim-script-editor:test.xml', 'jsbsim-global-variables', 'jsbsim-simulator-version-snapshots'];
  for (const key of protectedKeys) values.set(key, 'preserve:' + key);
  for (let i = 0; i < 3; i++) values.set('px4-parameter-metadata:' + i, 'x'.repeat(835000));
  for (let i = 0; i < 6; i++) values.set('jsbsim-mcap-variables:model' + i, 'x'.repeat(125000));
  trimBrowserCaches();
  assert.equal([...values.keys()].filter(key => key.startsWith('px4-parameter-metadata:')).length, 1, 'old multi-firmware caches are bounded at startup');
  assert.equal([...values.keys()].filter(key => key.startsWith('jsbsim-mcap-variables:')).length, 4, 'old property lists are bounded');
  assert.equal(cacheLocalText('px4-parameter-metadata:new', 'y'.repeat(835000)), true);
  assert.equal(values.has('px4-parameter-metadata:new'), true, 'newly verified metadata takes priority');
  assert.equal(cacheLocalText('px4-parameter-metadata:oversize', 'z'.repeat(2 * 1024 * 1024)), false, 'oversized entries stay in memory');
  full = true;
  assert.equal(cacheLocalText('jsbsim-mcap-variables:unwritable', '["/attitude/phi-deg"]'), false, 'quota failures do not escape into React');
  assert.equal(tryStoreLocalText('jsbsim-simulator-version-snapshots', 'new'), false);
  assert.equal(cacheLocalText('jsbsim-project', 'must not replace project'), false);
  for (const key of protectedKeys) assert.equal(values.get(key), 'preserve:' + key, key + ' survives cache cleanup and write failure');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); } });
  assert.doesNotThrow(trimBrowserCaches);
  assert.equal(cacheLocalText('jsbsim-available-variables', '[]'), false);
  assert.equal(tryStoreLocalText('preference', 'value'), false);
  console.log('PASS: legacy cache limits, replacement, quota/unavailable storage, oversized entries and project/script preservation.');
} finally {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previousStorage });
  await rm(work, { recursive: true, force: true });
}
