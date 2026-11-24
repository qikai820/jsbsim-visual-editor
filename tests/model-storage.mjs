import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
const tmp=await mkdtemp('/tmp/jsbsim-model-storage-');
const original=globalThis.localStorage;
try {
 await build({entryPoints:['client/src/utils/modelStorage.ts'],bundle:true,platform:'node',format:'cjs',outfile:tmp+'/storage.cjs',logLevel:'silent'});
 const {modelStorage,migrateModelStorage}=createRequire(import.meta.url)(tmp+'/storage.cjs');
 class Storage {
  values=new Map(); limit=5*1024*1024; fail=null; writes=0;
  get length(){return this.values.size;} key(i){return [...this.values.keys()][i]??null;}
  getItem(k){return this.values.get(k)??null;} removeItem(k){this.values.delete(k);}
  setItem(k,v){this.writes++;if(this.fail)throw this.fail;const next=new Map(this.values);next.set(k,v);if([...next].reduce((n,[key,value])=>n+2*(key.length+value.length),0)>this.limit)throw new DOMException('The quota has been exceeded.','QuotaExceededError');this.values=next;}
 }
 let storage=globalThis.localStorage=new Storage();
 const xml='<?xml version="1.0"?>\r\n<system><!-- 中文 🚁 --><value>1.2500</value></system>\n'.repeat(18000);
 const project=JSON.stringify({aircraft:{name:'XCD20_FlightIdentified'},xmlFiles:[{path:'GuideRailsXML.xml',originalXml:xml,currentXml:xml+'<!-- unsaved edit -->'}],nodes:[{data:{params:{expression:{vendor:'preserve'}}}}]});
 storage.values.set('px4-parameter-metadata:old','m'.repeat(800000));
 storage.values.set('jsbsim-mcap-variables:old','v'.repeat(300000));
 storage.values.set('jsbsim-project','old project');
 assert.throws(()=>storage.setItem('jsbsim-project',project),{name:'QuotaExceededError'});
 modelStorage.setItem('jsbsim-project',project);
 assert.equal(modelStorage.getItem('jsbsim-project'),project);
 assert(storage.getItem('jsbsim-project').startsWith('!jsbsim:gzip:1:'));
 assert(storage.getItem('jsbsim-project').length<project.length/10);
 const stored=storage.getItem('jsbsim-project');modelStorage.setItem('jsbsim-project',project);assert.equal(storage.getItem('jsbsim-project'),stored,'deterministic compression supports rollback');
 storage.values.set('jsbsim-remote-baseline:large',xml);
 storage.values.set('jsbsim-raw-xml',xml);
 storage.values.set('px4-flight-test-workspace-v1','keep script');
 migrateModelStorage();
 assert.equal(modelStorage.getItem('jsbsim-remote-baseline:large'),xml);assert.equal(modelStorage.getItem('jsbsim-raw-xml'),xml);assert.equal(storage.getItem('px4-flight-test-workspace-v1'),'keep script');
 // Corruption must be rejected even if the same key had a memoized decode.
 storage.values.set('jsbsim-project',stored.replace(/:[0-9a-f]{8}:/,':00000000:'));assert.throws(()=>modelStorage.getItem('jsbsim-project'),/校验失败/);assert(storage.getItem('jsbsim-project'));
 storage=globalThis.localStorage=new Storage();storage.limit=12000;
 storage.values.set('jsbsim-project','a'.repeat(500));storage.values.set('px4-parameter-metadata:cache','m'.repeat(4000));storage.values.set('px4-flight-test-workspace-v1','s'.repeat(500));storage.values.set('jsbsim-remote-baseline:protected','b'.repeat(500));
 modelStorage.setItem('jsbsim-project','new'.repeat(1000));
 assert.equal(storage.writes,2);assert.equal(storage.getItem('px4-parameter-metadata:cache'),null);assert.equal(storage.getItem('px4-flight-test-workspace-v1'),'s'.repeat(500));assert.equal(storage.getItem('jsbsim-remote-baseline:protected'),'b'.repeat(500));
 const previous=storage.getItem('jsbsim-project');storage.limit=100;assert.throws(()=>modelStorage.setItem('jsbsim-project','x'.repeat(1000)),{name:'QuotaExceededError'});assert.equal(storage.getItem('jsbsim-project'),previous,'required data survives exhausted quota');
 storage=globalThis.localStorage=new Storage();storage.fail=new Error('Disk write failed');assert.throws(()=>modelStorage.setItem('jsbsim-project','{}'),/Disk write failed/);assert.equal(storage.writes,1,'non-quota errors are never hidden or retried');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new DOMException('denied','SecurityError');}});assert.doesNotThrow(migrateModelStorage);
 console.log('PASS: real-sized quota reproduction, exact Unicode/XML/unsaved-source roundtrip, plain-cache migration, checksum, bounded eviction, failure preservation and non-quota propagation.');
} finally {Object.defineProperty(globalThis,'localStorage',{configurable:true,writable:true,value:original});await rm(tmp,{recursive:true,force:true});}
