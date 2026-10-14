import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transformSync } = require('esbuild');
const source = fs.readFileSync(new URL('../client/src/utils/serialProtocol.ts', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'esm' }).code;
const { FrameDecoder, checkFrame, decodeField, parseHex, toHex } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const rule = {
  mode: 'headerLength', header: 'AA 55', footer: '', delimiter: '0A', fixedLength: 7,
  lengthOffset: 2, lengthWidth: 1, lengthEndian: 'little', lengthMeaning: 'payload',
  gapMs: 20, maxLength: 64, checksum: 'xor8', checksumStart: 3, fields: [],
};

assert.deepEqual(parseHex('00 ff:AA-55'), [0, 255, 170, 85]);
assert.throws(() => parseHex('0FA'));
assert.equal(toHex([0, 255]), '00 FF');

const decoder = new FrameDecoder(rule);
assert.deepEqual(decoder.push({ direction: 'rx', timeMs: 1000, elapsedUs: 1000, bytes: [0x99, 0xaa] }).map(frame => frame.problem), ['未匹配帧头']);
assert.deepEqual(decoder.push({ direction: 'rx', timeMs: 1001, elapsedUs: 2000, bytes: [0x55, 0x03, 0x01] }), []);
const result = decoder.push({ direction: 'rx', timeMs: 1002, elapsedUs: 3000,
  bytes: [0x2c, 0x00, 0x2d, 0xaa, 0x55, 0x03, 0x02, 0x1e, 0x00, 0x1c] });
assert.equal(result.length, 2, 'split and concatenated reads must yield exactly two frames');
assert.deepEqual(result.map(frame => frame.valid), [true, true]);
assert.equal(result[0].timeMs, 1000, 'frame time is the first byte batch timestamp');
assert.equal(decodeField(result[0], { name: 'value', offset: 4, length: 2, type: 'u16', endian: 'little', scale: 0.5 }), '22');
assert.equal(checkFrame([0xaa, 0x55, 0x03, 0x02, 0x1e, 0x00, 0x00], rule).valid, false);

const otherDirection = decoder.push({ direction: 'tx', timeMs: 1003, elapsedUs: 4000, bytes: [0xaa, 0x55, 0x03, 0x01, 0x2c, 0, 0x2d] });
assert.equal(otherDirection[0].direction, 'tx');
const invalid = decoder.push({ direction: 'rx', timeMs: 1004, elapsedUs: 5000, bytes: [0xaa, 0x55, 0x03, 0x03, 0x5a, 0, 0] });
assert.equal(invalid[0].valid, false);
assert.match(invalid[0].problem, /XOR8/);

const gap = new FrameDecoder({ ...rule, mode: 'gap', checksum: 'none' });
gap.push({ direction: 'rx', timeMs: 2000, elapsedUs: 1000, bytes: [0, 255] });
assert.equal(gap.flushGap('rx')[0].valid, null);
assert.equal(gap.flushGap('rx').length, 0);

const fixed = new FrameDecoder({ ...rule, mode: 'fixed', fixedLength: 3, checksum: 'none' });
assert.equal(fixed.push({ direction: 'rx', timeMs: 1, elapsedUs: 1, bytes: [1, 2, 3, 4] }).length, 1);
assert.deepEqual(fixed.flush()[0].bytes, [4]);

const delimiter = new FrameDecoder({ ...rule, mode: 'delimiter', delimiter: '0D 0A', checksum: 'none' });
assert.deepEqual(delimiter.push({ direction: 'rx', timeMs: 2, elapsedUs: 2, bytes: [0, 255, 13] }), []);
assert.deepEqual(delimiter.push({ direction: 'rx', timeMs: 3, elapsedUs: 3, bytes: [10] })[0].bytes, [0, 255, 13, 10]);

const footer = new FrameDecoder({ ...rule, mode: 'headerFooter', footer: '0D 0A', checksum: 'none' });
assert.deepEqual(footer.push({ direction: 'rx', timeMs: 4, elapsedUs: 4, bytes: [0xaa, 0x55, 0x00, 13, 10] })[0].bytes, [0xaa, 0x55, 0x00, 13, 10]);

assert.equal(checkFrame([0x01, 0x03, 0x00, 0x00, 0xf1, 0xd8], { ...rule, checksum: 'crc16Modbus', checksumStart: 0 }).valid, true);
assert.equal(decodeField({ ...result[0], bytes: [0x01, 0x02] }, { name: 'big', offset: 0, length: 2, type: 'u16', endian: 'big', scale: 1 }), '258');

console.log('serial assistant protocol: PASS');
