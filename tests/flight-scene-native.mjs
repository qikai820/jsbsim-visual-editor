// Run the visual snapshot cache tests without GTK, USB or a running simulator.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const directory = await mkdtemp(path.join(tmpdir(), 'flight-scene-native-'));
try {
  const source = fileURLToPath(new URL('../src-tauri/src/scene_telemetry.rs', import.meta.url));
  await writeFile(path.join(directory, 'Cargo.toml'), `[package]\nname="flight-scene-native-tests"\nversion="0.0.0"\nedition="2021"\n[lib]\npath=${JSON.stringify(source)}\n[dependencies]\nserde_json="1"\n`);
  const result = spawnSync('cargo', ['test', '--offline', '--manifest-path', path.join(directory, 'Cargo.toml')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  console.log(result.stdout.trim());
} finally { await rm(directory, { recursive: true, force: true }); }
