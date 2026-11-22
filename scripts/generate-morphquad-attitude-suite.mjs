// Generate importable workbench FGScript. This command only writes files; no device I/O.
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const height=Number(process.argv[2]??10);
if(!Number.isFinite(height)||height<2||height>100)throw Error('高度须为 2～100 m');
const output=path.resolve(process.argv[3]??path.join(root,'examples/flight-tests/morphquad-attitude'));
const temp=await mkdtemp('/tmp/morphquad-attitude-');
try{
 await build({stdin:{contents:`export * from './client/src/flight-test/model';export * from './client/src/flight-test/xml';export * from './client/src/flight-test/presets';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:temp+'/compiler.cjs',logLevel:'silent'});
 const {BUILTIN_TESTS,builtinDocument,sweepPoints,compileTest,documentFromXml}=createRequire(import.meta.url)(temp+'/compiler.cjs');
 await mkdir(output,{recursive:true});
 const entries=[];
 const counts=(blocks,multiplier=1,out={})=>{for(const b of blocks){out[b.type]=(out[b.type]??0)+multiplier;if(b.body)counts(b.body,multiplier*Number(b.p.count),out);for(const lane of [...(b.lanes??[]),...(b.yes?[b.yes,b.no]:[])])counts(lane,multiplier,out);}return out;};
 const save=async(file,doc,extra={})=>{const xml=compileTest(doc);if(!documentFromXml(xml))throw Error('Metadata roundtrip failed');await writeFile(path.join(output,file),xml);entries.push({file,name:doc.name,bytes:Buffer.byteLength(xml),...extra});};
 for(const preset of BUILTIN_TESTS){
  const doc=builtinDocument(preset.id,height);
  const motion=preset.mode==='POSCTL'&&preset.input==='normal';
  await save(preset.file,doc,{presetId:preset.id,executionCounts:counts(doc.blocks),...(preset.id.startsWith('four_')?{profile:'four-mode',requirements:doc.requirements,headingDegrees:90,headingStepDegrees:30,ordinaryTiltDegrees:35,vectorTiltDegrees:120,sharedRecovery:true}:{}),...(preset.mode?{mode:preset.mode,axis:preset.axis,input:preset.input,vectorSwitch:preset.input==='vector'?'on':'off',...(motion?{evaluation:'motion-and-braking',stickPercent:[60,-60],pulseSeconds:2,minTiltDeg:1,minSpeedMps:.3,brakeSpeedMps:.2}: {points:sweepPoints(preset.input==='vector'?120:45,preset.input==='vector'?10:5),holdSeconds:preset.mode==='MANUAL'?2:10,manualRecovery:preset.mode==='MANUAL',angleToleranceDeg:3,settleSeconds:.5,pointTimeoutSeconds:preset.mode==='MANUAL'?12:40})}:{}),...(preset.id==='complete'?{combined:true,stages:9,totalAttitudePoints:246,positionPulses:4,manualRecoveryActions:76}:{} )});
 }
 await writeFile(path.join(output,'suite.json'),JSON.stringify({version:3,model:'MorphQuad',profile:'four-mode: ordinary ±35°, heading ±90°, shared parameterized recovery; vector ±120°; legacy presets retained',heightMeters:height,rateHz:50,clock:'realtime',sweep:'MANUAL/ALTCTL: ±45 by 5; normal POSCTL: ±60% stick for 2s then brake; vector: ±120 by 10',files:entries},null,2)+'\n');
 console.log(`Generated ${entries.length} XML scripts for current MorphQuad at ${height} m → ${output}`);
 for(const f of entries)console.log(`${f.file}: ${f.bytes} bytes`);
}finally{await rm(temp,{recursive:true,force:true});}
