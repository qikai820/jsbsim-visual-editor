import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const directory=await mkdtemp(path.join(tmpdir(),'scope-units-'));
try {
  const output=path.join(directory,'scope-units.cjs');
  await build({entryPoints:[fileURLToPath(new URL('../client/src/components/monitor/scopeUnits.ts',import.meta.url))],outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const {convertScopeValue,inferredScopeUnit,scopeUnits,formatScopeValue}=createRequire(import.meta.url)(output);
  const check=(value,sourceUnit,displayUnit,expected)=>assert.ok(Math.abs(convertScopeValue(value,{key:'x',label:'x',sourceUnit,displayUnit})-expected)<1e-8,`${sourceUnit} → ${displayUnit}`);
  check(1,'ft','m',.3048);check(1,'kn','km/h',1.852);check(Math.PI,'rad','deg',180);
  check(1,'lbf','N',4.4482216152605);check(1,'lb','kg',.45359237);
  check(32,'F','C',0);check(100,'C','F',212);check(0,'C','K',273.15);check(32.1740485564,'ft/s²','g',1);
  assert.equal(convertScopeValue(32,{key:'x',label:'x',sourceUnit:'F',displayUnit:'F'}),32,'retaining the same unit does not round-trip through an offset');
  assert.equal(inferredScopeUnit({key:'fcs/voliro_t/thrust-lbf[1]',label:'x'}),'lbf');
  assert.equal(inferredScopeUnit({key:'accelerations/udot-ft_sec2',label:'x'}),'ft/s²');
  assert.equal(inferredScopeUnit({key:'velocities/p-rad_sec',label:'x'}),'rad/s');
  assert.equal(inferredScopeUnit({key:'fcs/esc-out[1]',label:'x'}),undefined,'unknown units are never guessed');
  assert.equal(inferredScopeUnit({key:'custom/m',label:'x'}),undefined,'component names are not treated as units');
  assert.equal(scopeUnits({key:'x',label:'x',sourceUnit:'kg',displayUnit:'N'}).target,'kg','incompatible dimensions cannot be applied');
  assert.equal(formatScopeValue(2,{key:'x',label:'x',sourceUnit:'ft',displayUnit:'m'}),'0.6096 m');
  console.log('PASS: common unit conversions, temperature offsets, safe unit inference and dimensional isolation');
} finally {await rm(directory,{recursive:true,force:true})}
