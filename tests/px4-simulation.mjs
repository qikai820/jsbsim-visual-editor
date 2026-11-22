import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const dir = await mkdtemp('/tmp/px4-simulation-');
try {
  await build({ stdin: { contents: `export * from './client/src/px4/simulation';export * from './client/src/px4/connection';export * from './client/src/px4/protocol';export * from './client/src/px4/shell';`, resolveDir: process.cwd() }, outfile: dir + '/test.cjs', bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { rebootFlightController, switchSimulationMode, Px4Connection, Px4Shell, encode, view, stringAt } = createRequire(import.meta.url)(dir + '/test.cjs');
  const memory = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values };
  };
  function fixture({ hitl = 0, gps = 201, armed = false, uid = 42n, rejectWrite = false, saveFails = false, rebootResult = 0, lostAck = false, noReboot = false, differentUid = false, sameLink = false } = {}) {
    const storage = memory(), params = new Map([['SYS_HITL', hitl], ['GPS_1_CONFIG', gps]]), events = [], progress = [];
    let current, sequence = 0;
    const shell = { saveParameters: async () => { events.push(['save']); if (saveFails) throw Error('save failed'); } };
    const emit = (link, id, payload) => link.transport.onPacket(encode(id, payload, sequence++, 7, 1));
    const heartbeat = (link, mode) => { const p = new Uint8Array([0, 0, 0, 0, 2, 12, mode, 3, 3]); emit(link, 0, p); };
    function connect(mode, hardwareUid = uid) {
      const link = new Px4Connection({ system: 7, component: 1 });
      link.transport.onStatus(true); heartbeat(link, mode);
      const attitude = new Uint8Array(28); view(attitude).setUint32(0, 60000, true); emit(link, 30, attitude);
      const param = name => {
        const p = new Uint8Array(25); view(p).setInt32(0, params.get(name), true); view(p).setUint16(4, 2, true); view(p).setUint16(6, name === 'SYS_HITL' ? 0 : 1, true); p.set(new TextEncoder().encode(name), 8); p[24] = 6; emit(link, 22, p);
      };
      link.send = async (id, p) => {
        if (id === 20) { const name = stringAt(p, 4, 16); events.push(['read', name]); if (params.has(name)) param(name); }
        if (id === 23) { const name = stringAt(p, 6, 16); events.push(['write', name, view(p).getInt32(0, true)]); if (!rejectWrite) params.set(name, view(p).getInt32(0, true)); param(name); }
        if (id === 76 && view(p).getUint16(28, true) === 512 && view(p).getFloat32(0, true) === 148) { const r = new Uint8Array(78); view(r).setBigUint64(8, hardwareUid, true); emit(link, 148, r); }
        if (id === 76 && view(p).getUint16(28, true) === 246) {
          events.push(['reboot', Array.from(p)]);
          assert.equal(view(p).getFloat32(0, true), 1); assert.equal(p[30], 7); assert.equal(p[31], 1);
          if (!lostAck) { const ack = new Uint8Array(10); view(ack).setUint16(0, 246, true); ack[2] = rebootResult; ack[8] = 254; ack[9] = 190; emit(link, 77, ack); }
          if (rebootResult === 0 && !noReboot) setTimeout(() => {
            if (params.get('SYS_HITL') > 0) params.set('GPS_1_CONFIG', 0);
            if (sameLink) {
              heartbeat(link, params.get('SYS_HITL') > 0 ? 32 : 0);
              const attitude = new Uint8Array(28); view(attitude).setUint32(0, 10, true); emit(link, 30, attitude);
            } else {
              link.transport.onStatus(false);
              current = connect(params.get('SYS_HITL') > 0 ? 32 : 0, differentUid ? 43n : hardwareUid);
            }
          }, 20);
        }
      };
      return link;
    }
    current = connect((hitl > 0 ? 32 : 0) | (armed ? 128 : 0));
    return { storage, params, events, progress, get link() { return current; }, heartbeat,
      options: enabled => ({ enabled, storage, getLink: () => current, getShell: () => shell, signal: new AbortController().signal, progress: value => progress.push(value), timeoutMs: 1500 }) };
  }
  const writes = f => f.events.filter(e => e[0] === 'write');
  const reboots = f => f.events.filter(e => e[0] === 'reboot');
  const backupKey = 'px4-hitl-gps-backup-v1:2a';

  for (const settings of [{}, { hitl: 1, gps: 0 }, { sameLink: true }, { lostAck: true }]) {
    const f = fixture(settings), before = [...f.params];
    f.storage.setItem(backupKey, 'existing backup');
    assert.match(await rebootFlightController(f.options(false)), /飞控已重启并重新连接/);
    assert.deepEqual([...f.params], before, 'standalone reboot never changes configuration');
    assert.equal(writes(f).length, 0); assert.equal(f.events.some(e => e[0] === 'save'), false);
    assert.equal(f.storage.getItem(backupKey), 'existing backup', 'standalone reboot leaves simulation recovery data intact');
    assert.equal(reboots(f).length, 1);
  }
  for (const [settings, reason] of [[{ armed: true }, /已解锁/], [{ rebootResult: 1 }, /拒绝重启/], [{ noReboot: true }, /确认超时/], [{ differentUid: true }, /另一块飞控/]]) {
    const f = fixture(settings);
    await assert.rejects(rebootFlightController(f.options(false)), reason);
    assert.equal(reboots(f).length, settings.armed ? 0 : 1); assert.equal(writes(f).length, 0);
  }

  const normal = fixture();
  assert.match(await switchSimulationMode(normal.options(true)), /已进入仿真模式/);
  assert.deepEqual(writes(normal), [['write', 'SYS_HITL', 1]]);
  assert.equal(normal.params.get('GPS_1_CONFIG'), 0, 'simulate PX4 rcS disabling the GPS on HIL boot');
  assert.equal(JSON.parse(normal.storage.getItem(backupKey)).gps1Config, 201);
  assert.ok(normal.events.findIndex(e => e[0] === 'save') > normal.events.findLastIndex(e => e[0] === 'write'));
  assert.equal(reboots(normal).length, 1);
  const count = normal.events.length;
  assert.match(await switchSimulationMode(normal.options(true)), /已处于仿真模式/);
  assert.ok(normal.events.slice(count).every(e => e[0] !== 'write' && e[0] !== 'reboot'));
  assert.equal(JSON.parse(normal.storage.getItem(backupKey)).gps1Config, 201, 'repeat entry retains the real GPS port');
  assert.match(await switchSimulationMode(normal.options(false)), /已退出仿真模式/);
  assert.equal(normal.params.get('GPS_1_CONFIG'), 201); assert.equal(normal.params.get('SYS_HITL'), 0);
  assert.equal(normal.storage.getItem(backupKey), null, 'backup is cleared only after reboot and restored-parameter verification');

  for (const settings of [{ armed: true }, { uid: 0n }]) {
    const f = fixture(settings); await assert.rejects(switchSimulationMode(f.options(true)), /已解锁|硬件标识/);
    assert.equal(writes(f).length, 0); assert.equal(reboots(f).length, 0);
  }
  const stale = fixture(); stale.link.lastHeartbeat = Date.now() - 3000;
  await assert.rejects(switchSimulationMode(stale.options(true)), /最新心跳/); assert.equal(writes(stale).length, 0);
  const full = fixture(); full.storage.setItem = () => { throw Error('storage full'); };
  await assert.rejects(switchSimulationMode(full.options(true)), /storage full/); assert.equal(writes(full).length, 0);
  const rejected = fixture({ rejectWrite: true });
  await assert.rejects(switchSimulationMode(rejected.options(true)), /飞控返回 0/); assert.equal(reboots(rejected).length, 0);
  const failedSave = fixture({ saveFails: true });
  await assert.rejects(switchSimulationMode(failedSave.options(true)), /save failed.*未发送重启/); assert.equal(reboots(failedSave).length, 0); assert.ok(failedSave.storage.getItem(backupKey));
  const deniedReboot = fixture({ rebootResult: 1 });
  await assert.rejects(switchSimulationMode(deniedReboot.options(true)), /拒绝重启/); assert.equal(reboots(deniedReboot).length, 1);
  const lost = fixture({ lostAck: true });
  assert.match(await switchSimulationMode(lost.options(true)), /已进入仿真模式/); assert.equal(reboots(lost).length, 1, 'lost reboot ACK is never blindly retried');
  const timeout = fixture({ noReboot: true });
  await assert.rejects(switchSimulationMode(timeout.options(true)), /确认超时/); assert.equal(reboots(timeout).length, 1); assert.ok(timeout.storage.getItem(backupKey));
  const different = fixture({ differentUid: true });
  await assert.rejects(switchSimulationMode(different.options(true)), /另一块飞控/); assert.ok(different.storage.getItem(backupKey));
  assert.equal(writes(different).length, 1, 'never restore parameters to a different flight controller');
  const legacy = fixture({ hitl: 1, gps: 0 });
  assert.match(await switchSimulationMode(legacy.options(false)), /没有此飞控的进入前备份/); assert.deepEqual(writes(legacy), [['write', 'SYS_HITL', 0]]);
  const changedGps = fixture(); await switchSimulationMode(changedGps.options(true)); changedGps.params.set('GPS_1_CONFIG', 202);
  assert.match(await switchSimulationMode(changedGps.options(false)), /保留当前手动修改/); assert.equal(changedGps.params.get('GPS_1_CONFIG'), 202);
  const armedWhileSaving = fixture(), options = armedWhileSaving.options(true);
  options.getShell = () => ({ saveParameters: async () => armedWhileSaving.heartbeat(armedWhileSaving.link, 128) });
  await assert.rejects(switchSimulationMode(options), /已解锁/); assert.equal(reboots(armedWhileSaving).length, 0, 'recheck arming after parameter persistence');

  // Test the real SERIAL_CONTROL save path, including echo, chunking and exit status.
  for (const fails of [false, true]) {
    const f = fixture(), shell = new Px4Shell(f.link); let input = '';
    f.link.send = async (id, p) => {
      if (id !== 126) return;
      input += new TextDecoder().decode(p.subarray(9, 9 + p[8]));
      const match = input.match(/if param save; then echo (PX4S\w+)0; else echo \1[1]; fi\r/);
      if (match) {
        const response = input + '\r\n' + match[1] + (fails ? '1' : '0') + '\r\nnsh> ';
        const encoded = new TextEncoder().encode(response);
        for (let at = 0; at < encoded.length; at += 17) {
          const r = new Uint8Array(81), bytes = encoded.subarray(at, at + 17); r[6] = 10; r[8] = bytes.length; r.set(bytes, 9);
          f.link.transport.onPacket(encode(126, r, 0, 7, 1));
        }
      }
    };
    if (fails) await assert.rejects(shell.saveParameters(new AbortController().signal), /保存失败/);
    else await shell.saveParameters(new AbortController().signal);
    await shell.close(false); assert.ok(input.includes('param save'));
  }
  console.log('PASS: standalone reboot without parameter writes, unchanged HIL state and uptime reset detection, refusal/timeout/lost ACK/wrong device, HITL switching, GPS backup/restore, independent readback, synchronous persistence, armed/stale checks and failure recovery.');
} finally { await rm(dir, { recursive: true, force: true }); }
