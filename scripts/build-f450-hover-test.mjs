import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const target=resolve(process.argv[2]||join(root,'examples/flight-tests/f450-hover/hover.xml'));
const dir=await mkdtemp(join(tmpdir(),'f450-hover-compiler-'));
try{
  await build({stdin:{contents:`export * from './client/src/flight-test/model';export * from './client/src/flight-test/xml';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:join(dir,'compiler.cjs'),logLevel:'silent'});
  const{DEFS,compileTest,validateDocument}=createRequire(import.meta.url)(join(dir,'compiler.cjs'));
  const block=(id,type,p={})=>({id:'b'+id,type,p:{...DEFS[type].p,...p}});
  const document={version:1,name:'F450 联合测试 · 起飞5m / 悬停30s / 降落',aircraft:'F450_PX4',initialize:'current-instance',duration:180,rateHz:50,throttle:0,clock:'realtime',onFinish:'land',onAbort:'land',blocks:[
    block('ground_check','assert',{field:'landed',op:'eq',value:1,timeout:5}),
    block('normal_input','input_mode',{input:'normal'}),block('neutral','neutral'),
    block('low_throttle','throttle',{value:0}),block('position_mode','mode',{mode:'POSCTL',timeout:10}),
    block('arm','arm',{timeout:10}),block('takeoff','takeoff',{altitude:5,timeout:45}),
    block('center_throttle','throttle',{value:50}),block('hold_mode','mode',{mode:'POSCTL',timeout:10}),block('settle','wait',{duration:5}),
    block('hover_begin','mark',{text:'HOVER_BEGIN'}),block('hover','wait',{duration:30}),block('hover_end','mark',{text:'HOVER_END'}),
    block('land','land',{timeout:60}),block('landed_check','assert',{field:'landed',op:'eq',value:1,timeout:5}),
    block('disarm','disarm',{timeout:10}),block('unarmed_check','assert',{field:'armed',op:'eq',value:0,timeout:3}),
  ]};
  validateDocument(document);
  const xml=compileTest(document);
  await writeFile(target,xml);
  await writeFile(target.replace(/\.xml$/i,'.json'),JSON.stringify(document,null,2)+'\n');
  console.log(`Prepared ${target}; ${document.blocks.length} blocks; real flight NOT executed`);
}finally{await rm(dir,{recursive:true,force:true});}
