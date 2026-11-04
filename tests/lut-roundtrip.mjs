import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const work=await mkdtemp(path.join(tmpdir(),'lut-roundtrip-'));
try {
  const source=fileURLToPath(new URL('./support/lut-roundtrip.rs',import.meta.url));
  await writeFile(path.join(work,'Cargo.toml'),`[package]\nname="lut-roundtrip"\nversion="0.0.0"\nedition="2021"\n[[bin]]\nname="lut-roundtrip"\npath=${JSON.stringify(source)}\n[dependencies]\nserde_json="1"\nserde={version="1",features=["derive"]}\nquick-xml={version="0.41",features=["serialize","overlapped-lists","escape-html"]}\n`);
  const result=spawnSync('cargo',['run','--offline','--quiet','--manifest-path',path.join(work,'Cargo.toml')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr+result.stdout);
  console.log(result.stdout.trim());
} finally {await rm(work,{recursive:true,force:true});}
