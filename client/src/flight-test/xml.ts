import { AXES, childLanes, copy, MAX_EXECUTION_NODES, MAX_TEST_BYTES, MODES, TestBlock, TestDocument, validateDocument } from './model';
export const esc=(s:unknown)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
type Cond=string|{logic:'AND'|'OR';terms:Cond[]};
const and=(...terms:Cond[]):Cond=>({logic:'AND',terms});
const or=(...terms:Cond[]):Cond=>({logic:'OR',terms});
const conditionXml=(c:Cond):string=>typeof c==='string'?esc(c):`<condition logic="${c.logic}">${c.terms.map(t=>typeof t==='string'?esc(t)+'\n':conditionXml(t)).join('')}</condition>`;
const inverse:Record<string,string>={ge:'lt',le:'gt',gt:'le',lt:'ge',eq:'ne',ne:'eq'};
/** Lower structured control flow to ordinary FGScript properties/events/functions.
 * The test/* property bridge is supplied by the desktop runner. No custom XML tags.
 */
export function compileTest(document:TestDocument,metadata=true):string{
  validateDocument(document);const props=new Map<string,number>(),events:string[]=[];let count=0;
  const prop=(path:string,value=0)=>{props.set(path,value);return path;};
  for(const [key,value] of Object.entries(document.requirements??{}))prop('test/requirements/'+key,value);
  for(const [name,value]of Object.entries({ready:0,complete:0,failed:0}))prop('test/runtime/'+name,value);
  for(const a of AXES)prop('test/rc/'+a+'-norm',a==='throttle'?document.throttle:0);
  prop('test/rc/enabled',1);
  const set=(path:string,value:number)=>`<set name="${esc(path)}" value="${value}"/>`;
  const deadline=(path:string,seconds:number)=>`<set name="${path}"><function><sum><property>simulation/sim-time-sec</property><value>${seconds}</value></sum></function></set>`;
  const event=(name:string,c:Cond,sets:string[],notify=false,notifyProperties:string[]=[])=>{events.push(`    <event name="${esc(name)}">\n      ${typeof c==='string'?`<condition>${esc(c)}</condition>`:conditionXml(c)}\n      ${sets.join('\n      ')}${notify?'\n      <notify>'+notifyProperties.map(path=>`<property caption="${esc(path.split('/').slice(-1)[0])}">${esc(path)}</property>`).join('')+'</notify>':''}\n    </event>`);};
  const global:Cond=and('test/runtime/ready eq 1','test/runtime/complete eq 0','test/runtime/failed eq 0');
  type Handle={done:string;cancel:string;all:string[];inputs:string[];commands:string[]};
  function block(n:TestBlock,activate:Cond,ancestors:Cond[],parallelDepth:number):Handle{
    if(++count>MAX_EXECUTION_NODES)throw Error('循环展开超过 1024 个执行节点，请减少次数或嵌套');
    const id=n.id+'_'+count,base='test/flow/'+id,started=prop(base+'/started'),done=prop(base+'/done'),cancel=prop(base+'/cancelled'),until=prop(base+'/deadline');
    const guard=and(global,...ancestors,`${cancel} eq 0`),start=and(guard,activate,`${started} eq 0`),running=and(guard,`${started} eq 1`,`${done} eq 0`);
    const h:Handle={done,cancel,all:[cancel],inputs:[],commands:[]},p=n.p;
    const begin=[set(started,1)],finish=[set(done,1)];
    const timeout=(seconds:number)=>{event(n.id+'::timeout',and(running,`simulation/sim-time-sec ge ${until}`),[set('test/runtime/failed',1)],true);};
    const append=(v:Handle)=>{h.all.push(...v.all);h.inputs.push(...v.inputs);h.commands.push(...v.commands);};
    const activeChildren=[...ancestors,`${started} eq 1`,`${done} eq 0`,`${cancel} eq 0`];
    if(n.type==='channel'){
      if(parallelDepth)throw Error('通道控制应放在并行组之外设置或释放，通道值会持续保持');
      const base='test/channel/'+p.channel,enabled=prop(base+'/enabled'),value=prop(base+'/value-norm');
      event(n.id+'::'+p.channel+' '+(p.action==='release'?'释放':p.value+'%'),start,[...begin,set(value,Number(p.value)/100),set(enabled,p.action==='release'?0:1),...finish],true);return h;
    }
    if(n.type==='input_mode'){if(parallelDepth)throw Error('姿态输入路径应放在并行组之外切换');const path=prop('test/rc/input-kind',0);event(n.id+'::'+(p.input==='vector'?'矢量 AUX':'普通主杆'),start,[...begin,set(path,p.input==='vector'?2:1),...finish],true);return h;}
    const manualTakeoff=n.type==='manual_takeoff';
    const manualRecover=n.type==='manual_recover';
    const heading=n.type==='heading';
    const angle=['attitude','attitude_delta'].includes(n.type);
    if(['pulse','axes','neutral','altitude','manual_takeoff','manual_recover','attitude','attitude_delta','heading'].includes(n.type)){
      const input='test/input/'+id,selected=n.type==='altitude'?['throttle']:n.type==='pulse'?[String(p.axis)]:['neutral','attitude','attitude_delta','manual_recover','heading'].includes(n.type)?['roll','pitch','yaw']:[...AXES];
      prop(input+'/mask',selected.reduce((mask,a)=>mask|(1<<AXES.indexOf(a as typeof AXES[number])),0));
      for(const a of AXES)prop(input+'/'+a+'-norm',n.type==='pulse'?(a===p.axis?Number(p.value)/100:0):n.type==='axes'?Number(p[a])/100:a==='throttle'?document.throttle:0);
      if(n.type==='altitude')for(const [field,value]of Object.entries({'height-target-m':Number(p.target),'height-tolerance-m':Number(p.tolerance),'height-hover-norm':Number(p.hover)/100,'height-min-norm':Number(p.min)/100,'height-max-norm':Number(p.max)/100,'height-slew-norm-s':Number(p.slew)/100,'height-kp':Number(p.response)/100,'height-kd':Number(p.damping)/100,'height-ki':Number(p.trim)/100,'height-deadzone-norm':Number(p.deadzone)/100}))prop(input+'/'+field,value);
      if(manualTakeoff)for(const [field,value]of Object.entries({'height-target-m':Number(p.target),'height-tolerance-m':Number(p.tolerance),'height-hover-norm':Number(p.hover)/100,'height-min-norm':0,'height-max-norm':Number(p.max)/100,'height-slew-norm-s':Number(p.slew)/100,'height-kp':.08,'height-kd':.2,'height-ki':.03,'height-deadzone-norm':0,'height-climb-max-mps':Number(p.climb),'height-settle-s':Number(p.settle)}))prop(input+'/'+field,value);
      if(manualRecover)for(const [field,value]of Object.entries({'recover-reference':p.reference==='capture'?1:p.reference==='stop'?3:2,'recover-mode':MODES[String(p.mode)]??0,'recover-heading':p.heading==='reference'?1:0,'recover-position-m':Number(p.position),'recover-speed-mps':Number(p.speed),'recover-settle-s':Number(p.settle),'recover-max-speed-mps':Number(p.maxSpeed),'recover-max-tilt-deg':Number(p.maxTilt),'recover-acceleration-mps2':Number(p.acceleration),'recover-rate-deg-s':Number(p.rate)}))prop(input+'/'+field,value);
      if(heading)for(const [field,value]of Object.entries({'heading-target-deg':Number(p.target),'heading-hold-s':Number(p.hold),'heading-tolerance-deg':Number(p.tolerance),'heading-rate-deg-s':Number(p.rate),'heading-settle-s':Number(p.settle)}))prop(input+'/'+field,value);
      if(angle)for(const [field,value]of Object.entries({'angle-roll-deg':Number(p.roll),'angle-pitch-deg':Number(p.pitch),'angle-hold-s':Number(p.hold),'angle-tolerance-deg':Number(p.tolerance),'angle-rate-deg-s':Number(p.rate),'angle-settle-s':Number(p.settle)}))prop(input+'/'+field,value);
      if(angle){
        for(const axis of ['roll','pitch']){
          const target=prop('test/target/'+axis+'-deg'),path=input+'/angle-'+axis+'-deg';
          if(n.type==='attitude_delta')begin.push(`<set name="${path}"><function><sum><property>${target}</property><value>${p[axis]}</value></sum></function></set>`);
          else begin.push(set(target,Number(p[axis])));
        }
        if(n.type==='attitude_delta')for(const axis of ['roll','pitch'])begin.push(`<set name="test/target/${axis}-deg"><function><sum><property>test/target/${axis}-deg</property><value>${p[axis]}</value></sum></function></set>`);
      }
      const enabled=prop(input+'/enabled');h.inputs.push(enabled);begin.push(set(enabled,1),deadline(until,angle||heading||manualTakeoff||manualRecover?Number(p.timeout):n.type==='neutral'?1/document.rateHz:Number(p.duration)));finish.unshift(set(enabled,0));
      event(n.id+'::start',start,begin,true,angle?[input+'/angle-roll-deg',input+'/angle-pitch-deg']:heading?[input+'/heading-target-deg']:[]);
      const reached=angle?prop('test/attitude/'+id+'/status'):heading?prop('test/heading/'+id+'/status'):manualTakeoff?prop('test/altitude/'+id+'/status'):manualRecover?prop('test/manual/'+id+'/status'):null;
      if(manualTakeoff)finish.unshift(`<set name="test/rc/throttle-norm"><function><property>${input}/throttle-norm</property></function></set>`);
      event(n.id+'::done',and(running,reached?`${reached} eq 1`:`simulation/sim-time-sec ge ${until}`),finish,angle||heading||manualTakeoff||manualRecover,angle?[input+'/angle-roll-deg',input+'/angle-pitch-deg','test/attitude/held-s']:heading?[input+'/heading-target-deg','test/heading/error-deg','test/heading/held-s']:manualRecover?['test/manual/position-error-m','test/manual/speed-mps','test/manual/held-s']:[]);
      if(angle||heading||manualTakeoff||manualRecover)timeout(Number(p.timeout));return h;
    }
    if(['mode','arm','disarm','takeoff','land'].includes(n.type)){
      const command='test/command/'+id,kind=({arm:1,disarm:2,mode:3,takeoff:4,land:5}as Record<string,number>)[n.type];
      prop(command+'/kind',kind);prop(command+'/argument',n.type==='mode'?MODES[String(p.mode)]:n.type==='takeoff'?Number(p.altitude):0);prop(command+'/status');
      const request=prop(command+'/request');h.commands.push(request);begin.push(set(request,1),deadline(until,Number(p.timeout)));finish.unshift(set(request,0));
      event(n.id+'::start',start,begin,true);event(n.id+'::done',and(running,`${command}/status eq 1`),finish);
      event(n.id+'::rejected',and(running,`${command}/status lt 0`),[set('test/runtime/failed',1)],true);timeout(Number(p.timeout));return h;
    }
    if(n.type==='wait'){event(n.id+'::start',start,[...begin,deadline(until,Number(p.duration))],true);event(n.id+'::done',and(running,`simulation/sim-time-sec ge ${until}`),finish);return h;}
    if(n.type==='mark'||n.type==='throttle'){
      if(n.type==='throttle'&&parallelDepth)throw Error('并行分支内请使用“多轴打杆”控制油门；基准油门只能在串行流程中修改');
      if(n.type==='throttle')begin.push(set('test/rc/throttle-norm',Number(p.value)/100));
      event(n.id+'::'+(n.type==='mark'?String(p.text):'基准油门'),start,[...begin,...finish],true);return h;
    }
    if(n.type==='wait_state'||n.type==='assert'){
      event(n.id+'::start',start,[...begin,deadline(until,Number(p.timeout))],true);
      event(n.id+'::done',and(running,`test/fc/${p.field} ${p.op} ${p.value}`),finish);timeout(Number(p.timeout));return h;
    }
    if(n.type==='loop'){
      event(n.id+'::start',start,begin,true);let activation:Cond=`${started} eq 1`;
      for(let i=0;i<Number(p.count);i++){const child=sequence(n.body!,activation,activeChildren,parallelDepth);append(child);activation=`${child.done} eq 1`;}
      event(n.id+'::done',and(running,activation),finish);return h;
    }
    if(n.type==='branch'){
      const choice=prop(base+'/choice',-1),pred=`test/fc/${p.field} ${p.op} ${p.value}`,opposite=`test/fc/${p.field} ${inverse[String(p.op)]} ${p.value}`;
      event(n.id+'::start',start,begin,true);
      event(n.id+'::then',and(running,`${choice} eq -1`,pred),[set(choice,1)]);event(n.id+'::else',and(running,`${choice} eq -1`,opposite),[set(choice,0)]);
      const yes=sequence(n.yes!,`${choice} eq 1`,activeChildren,parallelDepth),no=sequence(n.no!,`${choice} eq 0`,activeChildren,parallelDepth);append(yes);append(no);
      event(n.id+'::done',and(running,or(and(`${choice} eq 1`,`${yes.done} eq 1`),and(`${choice} eq 0`,`${no.done} eq 1`))),finish);return h;
    }
    if(n.type==='parallel'){
      event(n.id+'::start',start,[...begin,deadline(until,Number(p.timeout))],true);
      const branches=n.lanes!.map(list=>sequence(list,`${started} eq 1`,activeChildren,parallelDepth+1));branches.forEach(append);
      const complete=(p.join==='all'?and:or)(...branches.map(v=>`${v.done} eq 1`));
      const clean=branches.flatMap(v=>[...v.all.map(path=>set(path,1)),...v.inputs.map(path=>set(path,0)),...v.commands.map(path=>set(path,0))]);
      event(n.id+'::'+(p.join==='all'?'all':'any'),and(running,complete),[...clean,...finish],true);timeout(Number(p.timeout));return h;
    }
    throw Error('不支持的积木：'+n.type);
  }
  function sequence(list:TestBlock[],activate:Cond,ancestors:Cond[],parallelDepth:number):Handle{
    const id='sequence_'+(++count),done=prop('test/flow/'+id+'/done'),cancel=prop('test/flow/'+id+'/cancelled');if(count>MAX_EXECUTION_NODES)throw Error('流程展开超过 1024 个节点');
    const h:Handle={done,cancel,all:[cancel],inputs:[],commands:[]};let next=activate;
    for(const n of list){const c=block(n,next,[...ancestors,`${cancel} eq 0`],parallelDepth);h.all.push(...c.all);h.inputs.push(...c.inputs);h.commands.push(...c.commands);next=and(activate,`${c.done} eq 1`);}
    event(id+'::done',and(global,...ancestors,`${cancel} eq 0`,next,`${done} eq 0`),[set(done,1)]);return h;
  }
  const root=sequence(document.blocks,'test/runtime/ready eq 1',[],0);
  event('test::complete',and(global,`${root.done} eq 1`),[set('test/runtime/complete',1)],true);
  const encoded=metadata?`<!-- flight-test-workspace:${encodeDocument(document)} -->\n`:'';
  const xml=`<?xml version="1.0"?>\n${encoded}<runscript name="${esc(document.name)}">\n  <use aircraft="${esc(document.aircraft)}" initialize="${esc(document.initialize)}"/>\n  <run start="0" end="${document.duration}" dt="0.01">\n${[...props].map(([k,v])=>`    <property value="${v}">${esc(k)}</property>`).join('\n')}\n${events.join('\n')}\n  </run>\n</runscript>\n`;
  if(new TextEncoder().encode(xml).length>MAX_TEST_BYTES)throw Error('生成脚本超过 4 MiB');return xml;
}
export function encodeDocument(d:TestDocument):string{const bytes=new TextEncoder().encode(JSON.stringify(d));let text='';for(const b of bytes)text+=String.fromCharCode(b);return btoa(text);}
export function documentFromXml(xml:string):TestDocument|null{
  if(new TextEncoder().encode(xml).length>MAX_TEST_BYTES||/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('脚本过大或包含不支持的 DTD/实体');
  const match=xml.match(/<!-- flight-test-workspace:([A-Za-z0-9+/=]+) -->/);if(!match)return null;
  try{
    const bytes=Uint8Array.from(atob(match[1]),c=>c.charCodeAt(0)),d=JSON.parse(new TextDecoder().decode(bytes));validateDocument(d);
    const normalize=(s:string)=>s.replace(/<!-- flight-test-workspace:[\s\S]*?-->/g,'').replace(/>\s+</g,'><').trim();
    // Edited XML must never silently be replaced by stale visual metadata.
    return normalize(compileTest(d,false))===normalize(xml)?copy(d):null;
  }catch{return null;} // Bad/older layout metadata never discards valid raw XML.
}
