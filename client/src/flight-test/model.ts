/** Editable test tree. Execution is compiled to JSBSim event XML, never eval(). */
export const MAX_TEST_SECONDS=14400;
export const MAX_TEST_BYTES=4*1024*1024;
export const MAX_TEST_BLOCKS=400;
export const MAX_EXECUTION_NODES=1024;
export type BlockType = 'mode'|'arm'|'disarm'|'takeoff'|'land'|'pulse'|'axes'|'neutral'|'throttle'|'channel'|'altitude'|'manual_takeoff'|'manual_recover'|'input_mode'|'attitude'|'attitude_delta'|'heading'|'wait'|'wait_state'|'assert'|'loop'|'branch'|'parallel'|'mark';
export type Params = Record<string, number|string>;
export type TestBlock = { id:string; type:BlockType; p:Params; body?:TestBlock[]; yes?:TestBlock[]; no?:TestBlock[]; lanes?:TestBlock[][] };
export type TestDocument = { version:1; name:string; aircraft:string; initialize:string; blocks:TestBlock[]; duration:number; rateHz:number; throttle:number; clock:'realtime'|'simulation'; onFinish:'hold'|'land'|'release'; onAbort:'hold'|'land'|'release'; requirements?:Record<string,number> };
export const AXES = ['roll','pitch','yaw','throttle'] as const;
export const AXIS_LABEL: Record<string,string> = { roll:'横滚',pitch:'俯仰',yaw:'偏航',throttle:'油门' };
export const CHANNELS: Record<string,string> = Object.fromEntries([
  ['vector-switch','矢量模式开关（自动映射）'],
  ...Array.from({length:18},(_,i)=>['rc'+(i+1),'RC'+(i+1)]),
  ...Array.from({length:6},(_,i)=>['aux'+(i+1),'AUX'+(i+1)]),
]);
export const FIELDS: Record<string,string> = { 'relative-alt-m':'相对高度 m','roll-abs-deg':'横滚绝对值 °','pitch-abs-deg':'俯仰绝对值 °','groundspeed-mps':'地速 m/s','armed':'已解锁','landed':'已落地','mode':'模式代码' };
export const MODES: Record<string,number> = { POSCTL:3,ALTCTL:2,STABILIZED:7,HOLD:4,MANUAL:1,ACRO:5,OFFBOARD:6 };
export const DEFS: Record<BlockType,{label:string;group:string;p:Params}> = {
  mode:{label:'模式',group:'飞控动作',p:{mode:'POSCTL',timeout:8}},arm:{label:'解锁',group:'飞控动作',p:{timeout:8}},disarm:{label:'上锁',group:'飞控动作',p:{timeout:8}},
  takeoff:{label:'起飞',group:'飞控动作',p:{altitude:5,timeout:40}},land:{label:'降落',group:'飞控动作',p:{timeout:60}},
  pulse:{label:'打杆',group:'遥控输入',p:{axis:'roll',value:20,duration:1}},axes:{label:'多轴打杆',group:'遥控输入',p:{roll:20,pitch:0,yaw:-15,throttle:50,duration:2}},
  neutral:{label:'姿态回中',group:'遥控输入',p:{}},throttle:{label:'基准油门',group:'遥控输入',p:{value:50}},
  channel:{label:'通道控制',group:'遥控输入',p:{channel:'vector-switch',action:'set',value:100}},
  altitude:{label:'油门控高',group:'遥控输入',p:{target:5,duration:20,tolerance:.2,hover:50,min:25,max:75,slew:25,response:8,damping:12,trim:1.5,deadzone:6}},
  input_mode:{label:'姿态输入路径',group:'遥控输入',p:{input:'normal'}},
  manual_takeoff:{label:'手动油门起飞',group:'遥控输入',p:{target:10,climb:.5,tolerance:.3,settle:3,timeout:120,hover:50,max:75,slew:10}},
  manual_recover:{label:'回位',group:'遥控输入',p:{reference:'return',mode:'current',heading:'keep',position:.5,speed:.2,settle:2,maxSpeed:3,maxTilt:20,acceleration:3,rate:30,timeout:120}},
  heading:{label:'航向步进',group:'遥控输入',p:{target:30,hold:10,tolerance:3,rate:10,settle:2,timeout:45}},
  attitude:{label:'姿态角步进',group:'遥控输入',p:{roll:0,pitch:10,hold:10,tolerance:3,rate:15,settle:.5,timeout:40}},
  attitude_delta:{label:'姿态角增量',group:'遥控输入',p:{roll:0,pitch:10,hold:10,tolerance:3,rate:15,settle:.5,timeout:40}},
  wait:{label:'等待',group:'流程控制',p:{duration:1}},wait_state:{label:'等待状态',group:'流程控制',p:{field:'relative-alt-m',op:'ge',value:3,timeout:10}},
  assert:{label:'检查',group:'流程控制',p:{field:'roll-abs-deg',op:'le',value:10,timeout:3}},loop:{label:'重复',group:'流程控制',p:{count:2}},
  branch:{label:'如果',group:'流程控制',p:{field:'relative-alt-m',op:'ge',value:3}},parallel:{label:'并行',group:'流程控制',p:{join:'all',timeout:20}},mark:{label:'标记',group:'流程控制',p:{text:'测试事件'}},
};
export const copy = <T,>(v:T):T => JSON.parse(JSON.stringify(v));
let serial=0;
export function makeBlock(type:BlockType):TestBlock { const n:TestBlock={id:'b'+Date.now().toString(36)+(++serial).toString(36),type,p:copy(DEFS[type].p)};if(type==='loop')n.body=[];if(type==='branch'){n.yes=[];n.no=[];}if(type==='parallel')n.lanes=[[],[]];return n; }
export function childLanes(n:TestBlock):Array<{slot:string;name:string;blocks:TestBlock[]}> { if(n.type==='parallel')return (n.lanes||[]).map((blocks,i)=>({slot:String(i),name:'分支 '+String.fromCharCode(65+i),blocks}));return (['body','yes','no'] as const).filter(k=>n[k]).map(slot=>({slot,name:slot==='body'?'执行':slot==='yes'?'满足':'否则',blocks:n[slot]!})); }
export function flatten(blocks:TestBlock[]):TestBlock[]{return blocks.flatMap(n=>[n,...childLanes(n).flatMap(l=>flatten(l.blocks))]);}
export function laneAt(blocks:TestBlock[],key:string):TestBlock[]|undefined {if(key==='root')return blocks;const [id,slot]=key.split(':');const n=flatten(blocks).find(n=>n.id===id);return n?.type==='parallel'?n.lanes?.[Number(slot)]:n?.[slot as 'body'|'yes'|'no'];}
export function locate(blocks:TestBlock[],id:string,key='root'):{blocks:TestBlock[];index:number;lane:string}|undefined{for(let i=0;i<blocks.length;i++){if(blocks[i].id===id)return{blocks,index:i,lane:key};for(const l of childLanes(blocks[i])){const found=locate(l.blocks,id,blocks[i].id+':'+l.slot);if(found)return found;}}}
export function duplicate(n:TestBlock):TestBlock {const out=copy(n);function visit(b:TestBlock){b.id=makeBlock(b.type).id;childLanes(b).forEach(l=>l.blocks.forEach(visit));}visit(out);return out;}
export function defaultDocument():TestDocument {return {version:1,name:'并行打杆测试',aircraft:'voliro_t',initialize:'reset',duration:60,rateHz:50,throttle:.5,clock:'realtime',onFinish:'hold',onAbort:'hold',blocks:[
  {id:'b1',type:'mode',p:{mode:'POSCTL',timeout:8}},
  {id:'b2',type:'parallel',p:{join:'all',timeout:10},lanes:[[{id:'b3',type:'pulse',p:{axis:'roll',value:20,duration:3}}],[{id:'b4',type:'pulse',p:{axis:'yaw',value:-15,duration:1.5}},{id:'b5',type:'mark',p:{text:'偏航完成'}}]]},
  {id:'b6',type:'wait',p:{duration:1}},
]};}
export function validateDocument(input:unknown):asserts input is TestDocument {
  const d=input as TestDocument;
  if(!d||d.version!==1||typeof d.name!=='string'||d.name.length>100||typeof d.aircraft!=='string'||!d.aircraft.trim()||d.aircraft.length>128||typeof d.initialize!=='string'||!d.initialize.trim()||d.initialize.length>128||!Array.isArray(d.blocks))throw Error('测试文件结构或机型/初始化标签无效');
  if(!Number.isFinite(d.duration)||d.duration<1||d.duration>MAX_TEST_SECONDS||!Number.isFinite(d.rateHz)||d.rateHz<20||d.rateHz>100||!Number.isFinite(d.throttle)||d.throttle<0||d.throttle>1)throw Error('测试时长、发送频率或基准油门无效');
  if(!['realtime','simulation'].includes(d.clock)||![d.onFinish,d.onAbort].every(v=>['hold','land','release'].includes(v)))throw Error('测试时钟或退出策略无效');
  if(d.requirements!==undefined&&(!d.requirements||Array.isArray(d.requirements)||Object.entries(d.requirements).some(([k,v])=>!['manual-tilt-deg','altitude-tilt-deg','vector-tilt-deg'].includes(k)||!Number.isFinite(v)||v<=0||v>120)))throw Error('测试所需倾角范围无效');
  const seen=new Set<string>();
  function walk(list:TestBlock[],depth:number){if(depth>8||!Array.isArray(list))throw Error('积木嵌套过深或结构无效');for(const n of list){
    if(!n||typeof n.id!=='string'||!/^b[a-z0-9_]{0,80}$/i.test(n.id)||seen.has(n.id)||!Object.prototype.hasOwnProperty.call(DEFS,n.type)||!n.p||typeof n.p!=='object')throw Error('积木类型或标识无效');seen.add(n.id);if(seen.size>MAX_TEST_BLOCKS)throw Error(`最多支持 ${MAX_TEST_BLOCKS} 个积木`);
    for(const [k,v]of Object.entries(DEFS[n.type].p)){if(n.type==='manual_recover'&&['mode','heading'].includes(k)&&n.p[k]===undefined)continue;if(typeof n.p[k]!==typeof v||(typeof n.p[k]==='number'&&!Number.isFinite(n.p[k])))throw Error(DEFS[n.type].label+' 参数无效：'+k);}
    if(Object.keys(n.p).some(k=>!Object.prototype.hasOwnProperty.call(DEFS[n.type].p,k))||(n.body!==undefined&&n.type!=='loop')||((n.yes!==undefined||n.no!==undefined)&&n.type!=='branch')||(n.lanes!==undefined&&n.type!=='parallel'))throw Error('积木包含不支持的参数或子流程');
    const p=n.p,num=(k:string,min:number,max:number)=>{if(Number(p[k])<min||Number(p[k])>max)throw Error(DEFS[n.type].label+' 参数越界：'+k);};
    if(p.duration!==undefined)num('duration',.02,n.type==='altitude'?MAX_TEST_SECONDS:300);if(p.timeout!==undefined)num('timeout',.1,n.type==='parallel'?MAX_TEST_SECONDS:3600);
    if(n.type==='pulse'){if(!AXES.includes(p.axis as typeof AXES[number]))throw Error('打杆轴无效');num('value',p.axis==='throttle'?0:-100,100);}
    if(n.type==='axes')for(const a of AXES)num(a,a==='throttle'?0:-100,100);
    if(n.type==='throttle')num('value',0,100);if(n.type==='takeoff')num('altitude',.5,1000);
    if(n.type==='channel'){if(!Object.prototype.hasOwnProperty.call(CHANNELS,String(p.channel))||!['set','release'].includes(String(p.action)))throw Error('通道控制目标或动作无效');num('value',-100,100);}
    if(n.type==='altitude'){
      num('target',.5,1000);num('tolerance',.05,5);num('hover',5,95);num('min',0,49);num('max',51,100);num('slew',1,100);num('response',.1,100);num('damping',0,100);num('trim',0,20);num('deadzone',0,20);
      if(Number(p.hover)<Number(p.min)||Number(p.hover)>Number(p.max)||Number(p.deadzone)>Math.min(50-Number(p.min),Number(p.max)-50))throw Error('油门控高：悬停杆位和中位死区须在油门限制内');
    }
    if(['attitude','attitude_delta'].includes(n.type)){num('roll',-140,140);num('pitch',-140,140);num('hold',.1,60);num('tolerance',.5,10);num('rate',1,30);num('settle',.1,5);if(Number(p.timeout)<=Number(p.hold)+Number(p.settle))throw Error('姿态角步进超时须大于到位稳定和停留时间');}
    if(n.type==='heading'){num('target',-180,180);num('hold',.1,60);num('tolerance',.5,10);num('rate',1,30);num('settle',.1,5);if(Number(p.timeout)<=Number(p.hold)+Number(p.settle))throw Error('航向超时须大于稳定和保持时间');}
    if(n.type==='input_mode'&&!['normal','vector'].includes(String(p.input)))throw Error('姿态输入路径无效');
    if(n.type==='manual_takeoff'){num('target',.5,100);num('climb',.1,2);num('tolerance',.05,1);num('settle',1,10);num('hover',5,70);num('max',51,100);num('slew',1,30);if(Number(p.max)<Number(p.hover)||Number(p.timeout)<Number(p.settle)+10)throw Error('手动起飞油门或超时配置无效');}
    if(n.type==='manual_recover'){if(!['capture','return','stop'].includes(String(p.reference)))throw Error('回位原点选项无效');if(!['current','MANUAL','ALTCTL','POSCTL'].includes(String(p.mode??'current'))||!['keep','reference'].includes(String(p.heading??'keep')))throw Error('回位模式或航向选项无效');num('position',.1,2);num('speed',.05,.5);num('settle',1,10);num('maxSpeed',.3,5);num('maxTilt',3,20);num('acceleration',.2,3);num('rate',5,60);if(Number(p.timeout)<=Number(p.settle)+5)throw Error('回位超时须大于稳定时间加 5 秒');}
    if(n.type==='mode'&&!Object.prototype.hasOwnProperty.call(MODES,String(p.mode)))throw Error('飞行模式无效');
    if(['wait_state','assert','branch'].includes(n.type)&&(!Object.prototype.hasOwnProperty.call(FIELDS,String(p.field))||!['ge','le','gt','lt','eq','ne'].includes(String(p.op))))throw Error('状态条件无效');
    if(n.type==='loop'&&(!Number.isInteger(p.count)||Number(p.count)<1||Number(p.count)>20||!Array.isArray(n.body)))throw Error('循环次数须为 1～20');
    if(n.type==='parallel'&&(!['all','any'].includes(String(p.join))||!Array.isArray(n.lanes)||n.lanes.length<2||n.lanes.length>4))throw Error('并行组须为 2～4 个分支');
    if(n.type==='branch'&&(!Array.isArray(n.yes)||!Array.isArray(n.no)))throw Error('条件分支结构无效');
    if(n.type==='mark'&&String(p.text).length>200)throw Error('事件名称过长');
    childLanes(n).forEach(l=>walk(l.blocks,depth+1));
  }}walk(d.blocks,0);
}
