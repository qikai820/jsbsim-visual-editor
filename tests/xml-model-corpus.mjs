// Every XML in both aviation libraries: formatting/equivalent-number rewrites,
// every scalar/attribute mutation, and one full-file mutation per model.
// node --experimental-websocket tests/xml-model-corpus.mjs
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.resolve(root, '../jsbsim_realtime');
const checked = spawnSync('python3', ['tools/generate_xml_semantics.py', '--source', source, '--check'], { cwd: root, encoding: 'utf8' });
assert.equal(checked.status, 0, checked.stdout + checked.stderr);
const audit=JSON.parse(await readFile(path.join(root,'tests/fixtures/jsbsim-xml-source-audit.json'),'utf8'));
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute);
    else if (entry.name.endsWith('.xml')) files.push({ path: path.relative(source, absolute), xml: await readFile(absolute, 'utf8') });
  }
}
await collect(path.join(source, 'data/aviation'));
await collect(path.join(source, 'ROMFS/jsbsim'));
files.sort((a,b) => a.path.localeCompare(b.path));
const directory = await mkdtemp(path.join(tmpdir(), 'xml-corpus-'));
const bundled=await build({stdin:{contents:`import * as sem from './client/src/utils/xmlContentEqual';import * as rules from './client/src/utils/jsbsimXmlRules';window.sem=sem;window.rules=rules;`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser',target:'es2020',logLevel:'silent'});
const server=createServer((request,response)=>{
  if(request.url==='/harness.js'){response.setHeader('Content-Type','application/javascript');response.end(bundled.outputFiles[0].text);}
  else response.end('<html><body>XML model corpus<script src="/harness.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const baseUrl=`http://127.0.0.1:${server.address().port}`;
const chrome = spawn('/usr/bin/google-chrome-stable', ['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',
  '--remote-debugging-port=0',`--user-data-dir=${directory}/chrome`,'about:blank'], { stdio: ['ignore','ignore','pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolve,reject) => {
    let output=''; const timer=setTimeout(()=>reject(Error('Chrome timeout')),15000);
    chrome.stderr.on('data', data=>{output+=data; const m=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
  });
  const target=(await fetch(`http://${new URL(endpoint).host}/json/list`).then(r=>r.json())).find(t=>t.type==='page');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));
  let sequence=0;const pending=new Map();
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout ${method}`));},60000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await send('Page.navigate',{url:baseUrl});
  for(let i=0;i<100;i++){if(await evaluate('Boolean(window.sem&&window.rules)'))break;await new Promise(r=>setTimeout(r,50));}
  console.log(`Corpus loaded: ${files.length} XML files`);
  await evaluate(`(async()=>{
    window.corpus=${JSON.stringify([])};
    window.report={files:0,equivalentFiles:0,fullFileMutations:0,fieldMutations:0,equivalentFields:0,roots:{},opaqueNumeric:{},failures:[]};
    window.runModels=(start,end)=>{
      const {parseXmlSemantics,xmlContentEqual,xmlElementsEqual}=window.sem;
      const {xmlElementRule,xmlAttributeKind}=window.rules;
      const parser=new DOMParser(),serializer=new XMLSerializer();
      const decimal=/^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?$/;
      // Independent spelling transformation: append fractional zeros without
      // evaluating or rounding the decimal, preserving any original exponent.
      const spell=value=>value.trim().replace(/^([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))([eE][+-]?\\d+)?$/,(_all,mantissa,exp)=>
        mantissa+(mantissa.includes('.')?'000':'.000')+(exp||''));
      const change=value=>decimal.test(value.trim())?value.trim().replace(/\\d/,digit=>digit==='9'?'8':String(Number(digit)+1)):value+'__changed';
      const eligible=(kind,value)=>['number','parameter','atoi'].includes(kind)&&decimal.test(value.trim())&&(kind!=='atoi'||/^[+-]?\\d+(?:\\.0*)?$/.test(value.trim()));
      for(const file of window.corpus.slice(start,end)){
        const original=parser.parseFromString(file.xml,'application/xml');
        if(original.querySelector('parsererror')){window.report.failures.push({path:file.path,error:'input parse error'});continue;}
        const copy=original.cloneNode(true),left=[...original.querySelectorAll('*')],right=[...copy.querySelectorAll('*')];
        const formatted=original.cloneNode(true),pretty=[...formatted.querySelectorAll('*')];
        let firstMutation=null,fallbackMutation=null;
        for(let i=0;i<left.length;i++){
          const a=left[i],b=right[i],f=pretty[i],rule=xmlElementRule(a);
          const pathOf=element=>{const tags=[];for(let n=element;n;n=n.parentElement)tags.unshift(n.tagName);return tags.join('/');};
          for(const attribute of [...a.attributes]){
            const kind=xmlAttributeKind(rule,a,attribute.name),value=attribute.value;
            fallbackMutation||={index:i,attribute:attribute.name};
            b.setAttribute(attribute.name,change(value));
            if(xmlElementsEqual(a,b))window.report.failures.push({path:file.path,field:pathOf(a)+'/@'+attribute.name,error:'missed attribute change'});
            window.report.fieldMutations++;
            b.setAttribute(attribute.name,value);
            if(eligible(kind,value)){
              firstMutation||={index:i,attribute:attribute.name};
              f.setAttribute(attribute.name,spell(value));
              window.report.equivalentFields++;
            }else if(decimal.test(value)&&!rule?.attributes[attribute.name]){
              const key=pathOf(a)+'/@'+attribute.name;window.report.opaqueNumeric[key]=(window.report.opaqueNumeric[key]||0)+1;
            }
          }
          // Attribute order and quoting are spelling only, even for opaque tags.
          const attributes=[...f.attributes];for(const attr of attributes)f.removeAttribute(attr.name);
          for(const attr of attributes.reverse())f.setAttribute(attr.name,attr.value);
          if(!a.children.length&&a.textContent?.trim()){
            const value=a.textContent,kind=rule?.text;
            fallbackMutation||={index:i};
            b.textContent=change(value);
            if(xmlElementsEqual(a,b))window.report.failures.push({path:file.path,field:pathOf(a),error:'missed scalar change'});
            window.report.fieldMutations++;b.textContent=value;
            if(eligible(kind,value)){
              f.textContent='\\n  '+spell(value)+'  \\n';window.report.equivalentFields++;
              firstMutation||={index:i};
            }else if(kind==='table'){
              f.textContent=value.split('\\n').map(row=>row.trim().split(/\\s+/).map(token=>decimal.test(token)?spell(token):token).join('\\t')).join('\\n');
              window.report.equivalentFields+=value.trim().split(/\\s+/).length;
              // Every table cell must remain distinguishable, including tiny
              // coefficients and decimal strings beyond binary64 precision.
              for(const match of value.matchAll(/[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?/g)){
                b.textContent=value.slice(0,match.index)+change(match[0])+value.slice(match.index+match[0].length);
                if(xmlElementsEqual(a,b))window.report.failures.push({path:file.path,field:pathOf(a),error:'missed table cell',index:match.index});
                window.report.fieldMutations++;
              }
              b.textContent=value;
            }else if(decimal.test(value.trim())&&(!kind||kind==='string')){
              const key=pathOf(a);window.report.opaqueNumeric[key]=(window.report.opaqueNumeric[key]||0)+1;
            }
          }
          const preserve=(()=>{for(let n=f;n;n=n.parentElement)if(n.hasAttribute('xml:space'))return n.getAttribute('xml:space')==='preserve';return false;})();
          if(f.children.length&&![...f.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.nodeValue.trim())&&!preserve){
            for(const node of [...f.childNodes])if(node.nodeType===Node.TEXT_NODE)node.remove();
            for(const child of [...f.children])f.insertBefore(formatted.createTextNode('\\n    '),child);
            f.appendChild(formatted.createTextNode('\\n'));
          }
        }
        const newXml=serializer.serializeToString(formatted);
        if(!xmlContentEqual(file.xml,newXml)){
          const a=parseXmlSemantics(file.xml).xml.split('\\n'),b=parseXmlSemantics(newXml).xml.split('\\n');
          const at=a.findIndex((line,i)=>line!==b[i]);
          window.report.failures.push({path:file.path,error:'equivalent rewrite differs',line:at,left:a.slice(at,at+3),right:b.slice(at,at+3)});
        }else window.report.equivalentFiles++;
        const mutation=firstMutation||fallbackMutation;
        if(mutation){
          const {index,attribute}=mutation;
          if(attribute)right[index].setAttribute(attribute,change(left[index].getAttribute(attribute)));
          else right[index].textContent=change(left[index].textContent);
          if(xmlContentEqual(file.xml,serializer.serializeToString(copy)))window.report.failures.push({path:file.path,error:'missed full-file change'});
          window.report.fullFileMutations++;
        }else{
          copy.documentElement.setAttribute('__semantic_change__','1');
          if(xmlContentEqual(file.xml,serializer.serializeToString(copy)))window.report.failures.push({path:file.path,error:'missed added attribute'});
          window.report.fullFileMutations++;
        }
        window.report.files++;const tag=original.documentElement.tagName;window.report.roots[tag]=(window.report.roots[tag]||0)+1;
      }
      return {files:window.report.files,failures:window.report.failures.length,fieldMutations:window.report.fieldMutations};
    };
  })()`);
  await evaluate(`window.corpus=${JSON.stringify(files)};true`);
  const synthetic=await evaluate(`(()=>{
    const evidence=${JSON.stringify(audit.rules)};
    const {xmlContentEqual}=window.sem,serializer=new XMLSerializer(),failures=[],seen=new Set();let checks=0;
    for(const field of evidence){
      if(!['number','parameter','atoi','condition'].includes(field.kind)||seen.has(field.path))continue;
      seen.add(field.path);
      const parts=field.path.split('/'),root=parts.shift(),attribute=parts.at(-1)?.startsWith('@')?parts.pop().slice(1):null;
      const doc=document.implementation.createDocument('',root);let element=doc.documentElement;
      if(['input','output'].includes(root))element.setAttribute('type','HIL_SENSOR');
      for(const tag of parts){const next=doc.createElement(tag);element.appendChild(next);element=next;}
      const set=value=>attribute?element.setAttribute(attribute,value):element.textContent=value;
      const body=value=>field.kind==='condition'?'fcs/probe gt '+value:value;
      set(body('1'));const before=serializer.serializeToString(doc);
      set(body('1.000'));if(!xmlContentEqual(before,serializer.serializeToString(doc)))failures.push({field:field.path,error:'source rule missed equal decimals'});checks++;
      if(field.kind!=='atoi'){
        set(body('1e0'));if(!xmlContentEqual(before,serializer.serializeToString(doc)))failures.push({field:field.path,error:'source rule missed equal exponent'});checks++;
      }
      set(body('1.0000000001'));if(xmlContentEqual(before,serializer.serializeToString(doc)))failures.push({field:field.path,error:'source rule hid real change'});checks++;
    }
    return {fields:seen.size,checks,failures};
  })()`);
  assert.deepEqual(synthetic.failures,[],JSON.stringify(synthetic.failures.slice(0,15),null,2));
  console.log(`Source rules: ${synthetic.fields} fields, ${synthetic.checks} independent checks`);
  for(let start=0;start<files.length;start+=20){
    const progress=await evaluate(`window.runModels(${start},${start+20})`);
    if(progress.failures)break;
    if(start%100===0)console.log(`Corpus: ${progress.files}/${files.length} files, ${progress.fieldMutations} field mutations`);
  }
  const report=await evaluate('window.report');
  report.sourceRevision=audit.revision;
  report.sourceRuleFields=synthetic.fields;report.sourceRuleChecks=synthetic.checks;
  report.conservativePolicies=Object.keys(report.opaqueNumeric).map(field=>({field,count:report.opaqueNumeric[field],policy:audit.conservativeCorpusPolicies.find(p=>new RegExp(p.pattern).test(field))}));
  report.unclassifiedNumericPaths=report.conservativePolicies.filter(entry=>!entry.policy).map(entry=>entry.field);
  await writeFile('/tmp/jsbsim-xml-corpus-report.json',JSON.stringify(report,null,2)+'\n');
  assert.deepEqual(report.failures,[],JSON.stringify(report.failures.slice(0,12),null,2));
  assert.deepEqual(report.unclassifiedNumericPaths,[],'Every preserved numeric-looking field needs an explicit source-reviewed disposition');
  assert.equal(report.files,files.length);assert.equal(report.equivalentFiles,files.length);
  console.log(`PASS: ${report.files} XML files, ${report.equivalentFields} equivalent numeric fields/cells, ${report.fieldMutations} independent field/cell mutations, ${report.fullFileMutations} full-file mutations. Report: /tmp/jsbsim-xml-corpus-report.json`);
} finally {
  socket?.close();chrome.kill('SIGTERM');server.close();
  await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
