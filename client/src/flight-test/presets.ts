import {xcd20Document} from './xcd20';
import { copy, DEFS, Params, TestBlock, TestDocument, validateDocument } from './model';

type Mode = 'MANUAL'|'ALTCTL'|'POSCTL';
type Axis = 'pitch'|'roll';
export type BuiltinTest = {id:string;label:string;file:string;mode?:Mode;axis?:Axis;input?:'normal'|'vector'};
export const BUILTIN_TESTS:readonly BuiltinTest[] = [
  {id:'four_mode_complete',label:'完整四模式 · 矢量速率 / 回中保持 / 一键回平',file:'10_four_mode_complete.xml'},
  {id:'four_manual',label:'四模式分组 · 手动三轴 / 每点回位零速',file:'11_four_manual.xml'},
  {id:'four_altctl',label:'四模式分组 · 定高三轴 / 每点回位零速',file:'12_four_altctl.xml'},
  {id:'four_posctl',label:'四模式分组 · 普通定点打杆 / 航向±90°',file:'13_four_posctl.xml'},
  {id:'four_vector',label:'四模式分组 · 矢量双轴速率 / 一键回平',file:'14_four_vector.xml'},
  {id:'complete',label:'旧固件九阶段 · 矢量 AUX 角度',file:'morphquad_complete.xml'},
  {id:'prepare',label:'手动油门起飞 · 控高悬停',file:'00_prepare_hover.xml'},
  {id:'manual_pitch',label:'普通手动 · Pitch ±45° / 5°',file:'01_manual_pitch.xml',mode:'MANUAL',axis:'pitch',input:'normal'},
  {id:'manual_roll',label:'普通手动 · Roll ±45° / 5°',file:'02_manual_roll.xml',mode:'MANUAL',axis:'roll',input:'normal'},
  {id:'altctl_pitch',label:'普通定高 · Pitch ±45° / 5°',file:'03_altctl_pitch.xml',mode:'ALTCTL',axis:'pitch',input:'normal'},
  {id:'altctl_roll',label:'普通定高 · Roll ±45° / 5°',file:'04_altctl_roll.xml',mode:'ALTCTL',axis:'roll',input:'normal'},
  {id:'posctl_pitch',label:'普通定点 · Pitch 主杆 ±60% / 2s · 回中刹停',file:'05_posctl_pitch.xml',mode:'POSCTL',axis:'pitch',input:'normal'},
  {id:'posctl_roll',label:'普通定点 · Roll 主杆 ±60% / 2s · 回中刹停',file:'06_posctl_roll.xml',mode:'POSCTL',axis:'roll',input:'normal'},
  {id:'vector_pitch',label:'矢量定点 · Pitch 速率与回平',file:'07_vector_pitch.xml',mode:'POSCTL',axis:'pitch',input:'vector'},
  {id:'vector_roll',label:'矢量定点 · Roll 速率与回平',file:'08_vector_roll.xml',mode:'POSCTL',axis:'roll',input:'vector'},
  {id:'xcd20_normal_takeoff',label:'XCD20 普通起飞 · 手动 / 定高 / 定点',file:'XCD20_NormalTakeoff.xml'},
  {id:'xcd20_rail_takeoff',label:'XCD20 双杆自动起飞 → 定点悬停与刹停',file:'XCD20_RailTakeoff.xml'},
  {id:'posctl_regression',label:'定点专项 · 普通打杆刹停 / 矢量速率',file:'09_posctl_regression.xml'},
];
export function sweepPoints(limit:number,step=10):number[]{
  const rising=Array.from({length:Math.floor(limit/step)},(_,i)=>(i+1)*step);
  if(rising[rising.length-1]!==limit)rising.push(limit);
  return [0,...rising,...rising.slice(0,-1).reverse(),0,...rising.map(a=>-a),...rising.slice(0,-1).reverse().map(a=>-a),0];
}
export const SWEEP_POINTS:readonly number[]=Object.freeze(sweepPoints(120,10));
const block=(id:string,type:TestBlock['type'],p:Params={}):TestBlock=>({id,type,p:{...copy(DEFS[type].p),...p}});
function preparation(height:number):TestBlock[]{return [
  block('bprepare_input','input_mode',{input:'normal'}),
  block('bprepare_rotor','channel',{channel:'vector-switch',action:'set',value:-100}),
  block('bprepare_neutral','neutral'),
  block('bknown_landed','wait_state',{field:'landed',op:'ge',value:0,timeout:5}),
  {...block('bground','branch',{field:'landed',op:'eq',value:1}),yes:[
    block('bprepare_low','throttle',{value:0}),block('bprepare_mode','mode',{mode:'MANUAL'}),block('bprepare_arm','arm'),block('bprepare_spool','wait',{duration:2}),
  ],no:[block('bairborne_armed','assert',{field:'armed',op:'eq',value:1,timeout:1}),block('bairborne_throttle','throttle',{value:50}),block('bairborne_mode','mode',{mode:'MANUAL'})]},
  block('bprepare_manual_takeoff','manual_takeoff',{target:height}),
];}
// POSCTL sticks request horizontal motion. The position loop owns attitude;
// holding an Euler angle for 10 s is not a valid normal-position test.
function brake(prefix:string,height:number):TestBlock[]{return [
  {...block(prefix+'_stabilize','parallel',{join:'any',timeout:35}),lanes:[
    [block(prefix+'_recover','manual_recover',{reference:'stop',mode:'POSCTL',timeout:30})],
    [block(prefix+'_height','altitude',{target:height,duration:40})],
  ]},
];}
function positionMotion(preset:BuiltinTest,height:number):TestBlock[]{
  const prefix='b'+preset.id,axis=preset.axis!;
  return [block(prefix+'_input','input_mode',{input:'normal'}),block(prefix+'_neutral','neutral'),
    block(prefix+'_rotor','channel',{channel:'vector-switch',action:'set',value:-100}),
    block(prefix+'_center_throttle','throttle',{value:50}),block(prefix+'_mode','mode',{mode:'POSCTL',timeout:8}),
    ...brake(prefix+'_entry',height),
    ...[1,-1].flatMap(sign=>{
      const id=prefix+(sign>0?'_positive':'_negative');
      return [block(id+'_mark','mark',{text:`普通 POSCTL：${axis} 主杆 ${sign*60}% 持续 2s，检查倾斜/移动后回中刹停`}),{
        ...block(id+'_response','parallel',{join:'all',timeout:4}),
        lanes:[[block(id+'_pulse','pulse',{axis,value:sign*60,duration:2})],
          [block(id+'_tilt','wait_state',{field:axis+'-abs-deg',op:'ge',value:1,timeout:2}),
            block(id+'_moving','wait_state',{field:'groundspeed-mps',op:'ge',value:.3,timeout:2})]],
      },...brake(id+'_brake',height)];
    }),
  ];
}
function sweep(preset:BuiltinTest,height:number,vectorLimit=120,vectorStep=10):TestBlock[]{
  const {mode,axis,input}=preset,prefix='b'+preset.id;
  if(mode==='POSCTL'&&input==='normal')return positionMotion(preset,height);
  const manual=mode==='MANUAL',limit=input==='vector'?vectorLimit:45, step=input==='vector'?vectorStep:5,count=limit/step;
  const recover=(id:string,reference='return')=>block(prefix+'_'+id,'manual_recover',{reference});
  const point=(id:string,angle:number,relative=false)=>block(prefix+'_'+id,relative?'attitude_delta':'attitude',{
    roll:axis==='roll'?angle:0,pitch:axis==='pitch'?angle:0,hold:manual?2:10,tolerance:3,rate:15,settle:.5,timeout:manual?12:40,
  });
  const repeat=(id:string,delta:number):TestBlock=>({...block(prefix+'_'+id,'loop',{count}),body:[point(id+'_step',delta,true),...(manual?[recover(id+'_recover')]:[])]});
  const recoverTimeout=Number(DEFS.manual_recover.p.timeout);
  const budget=sweepPoints(limit,step).length*(manual?12+recoverTimeout:40)+(manual?recoverTimeout:0)+20;
  return [block(prefix+'_input','input_mode',{input:input!}),block(prefix+'_neutral','neutral'),block(prefix+'_rotor','channel',{channel:'vector-switch',action:'set',value:input==='vector'?100:-100}),...(mode==='MANUAL'?[]:[block(prefix+'_center_throttle','throttle',{value:50})]),
    block(prefix+'_mode','mode',{mode:mode!,timeout:8}),...(input==='vector'?brake(prefix+'_entry',height):[]),{
      ...block(prefix+'_sweep','parallel',{join:'any',timeout:budget}),
      lanes:[[...(manual?[recover('origin','capture')]:[]),point('zero',0),...(manual?[recover('zero_recover')]:[]),repeat('positive',step),repeat('positive_return',-step),repeat('negative',-step),repeat('negative_return',step)],
        [block(prefix+'_height','altitude',{target:height,duration:budget+10})]],
    }];
}
const vectorRequirements = {'morphquad-servo-range-deg':35};
const channel=(id:string,target:string,value:number)=>block(id,'channel',{channel:target,action:'set',value});

function vectorRateChecks(prefix:string,axes:readonly Axis[]):TestBlock[]{
  const waitFor=(id:string,field:string,op:string,value:number,timeout:number)=>
    block(prefix+'_'+id,'wait_state',{field,op,value,timeout});
  const level=(id:string):TestBlock[]=>[
    channel(prefix+'_'+id+'_press','level-switch',100),
    block(prefix+'_'+id+'_pulse','wait',{duration:.25}),
    channel(prefix+'_'+id+'_release','level-switch',-100),
    waitFor(id+'_roll','roll-abs-deg','le',1.5,6),
    waitFor(id+'_pitch','pitch-abs-deg','le',1.5,6),
  ];
  return [
    ...level('initial_level'),
    ...axes.flatMap(axis=>[1,-1].flatMap(sign=>{
      const id=axis+(sign>0?'_positive':'_negative');
      const axisChannel='vector-'+axis+'-rate',op=sign>0?'ge':'le';
      return [
        channel(prefix+'_'+id+'_command',axisChannel,35*sign),
        waitFor(id+'_rotate',axis+'-rate-rad-s',op,.03*sign,2),
        waitFor(id+'_angle',axis+'-deg',op,3*sign,2),
        channel(prefix+'_'+id+'_center',axisChannel,0),
        block(prefix+'_'+id+'_settle','wait',{duration:.8}),
        {...block(prefix+'_'+id+'_hold','parallel',{join:'all',timeout:2}),lanes:[
          [block(prefix+'_'+id+'_nonzero','observe',{field:axis+'-deg',min:sign>0?1.5:-12,max:sign>0?12:-1.5,duration:1,reference:'absolute'})],
          [block(prefix+'_'+id+'_steady','observe',{field:axis+'-deg',min:-1,max:1,duration:1,reference:'start'})],
          [block(prefix+'_'+id+'_hold_rate','observe',{field:axis+'-rate-rad-s',min:-.07,max:.07,duration:1,reference:'absolute'})],
        ]},
        ...level(id+'_level'),
      ];
    })),
  ];
}

function vectorRateEntry(prefix:string,height:number):TestBlock[]{
  return [
    block(prefix+'_input','input_mode',{input:'normal'}),
    block(prefix+'_neutral','neutral'),
    channel(prefix+'_off','vector-switch',-100),
    channel(prefix+'_level_off','level-switch',-100),
    channel(prefix+'_roll_center','vector-roll-rate',0),
    channel(prefix+'_pitch_center','vector-pitch-rate',0),
    block(prefix+'_throttle','throttle',{value:50}),
    block(prefix+'_mode','mode',{mode:'POSCTL'}),
    ...brake(prefix+'_entry',height),
    channel(prefix+'_switch','vector-switch',100),
  ];
}
const FOUR_MODE_GROUPS = ['manual','altctl','posctl','vector'] as const;
function fourModeGroup(group:typeof FOUR_MODE_GROUPS[number],height:number):TestBlock[]{
  const prefix='bfour_'+group,returning=group==='manual'||group==='altctl';
  const mode=group==='manual'?'MANUAL':group==='altctl'?'ALTCTL':'POSCTL';
  const input='normal';
  const recover=(id:string)=>block(prefix+'_'+id,'manual_recover',{reference:'return',mode});
  const lane:TestBlock[]=[];
  if(returning)lane.push(recover('entry_return'));
  if(returning)for(const axis of ['pitch','roll'] as const){
    const limit=group==='altctl'?20:35,step=5;
    const point=(id:string,angle:number,relative=false)=>block(prefix+'_'+axis+'_'+id,relative?'attitude_delta':'attitude',{
      roll:axis==='roll'?angle:0,pitch:axis==='pitch'?angle:0,hold:returning?2:10,timeout:returning?12:40,
    });
    lane.push(block(prefix+'_'+axis+'_mark','mark',{text:`${mode} ${axis} ±${limit}° / ${step}°${returning?'，每点回到统一原点并确认零速':''}`}),point('zero',0));
    if(returning)lane.push(recover(axis+'_zero_return'));
    for(const [id,delta] of [['positive',step],['positive_return',-step],['negative',-step],['negative_return',step]] as const){
      lane.push({...block(prefix+'_'+axis+'_'+id,'loop',{count:limit/step}),body:[point(id+'_step',delta,true),...(returning?[recover(axis+'_'+id+'_recover')]:[])]});
    }
  }
  lane.push(block(prefix+'_heading_mark','mark',{text:'航向相对起飞基准：0 → +90° → 0 → −90° → 0，30°步进'}));
  for(const [i,target] of sweepPoints(90,30).entries()){
    lane.push(block(prefix+'_heading_'+i,'heading',{target,hold:returning?2:10}));
    if(returning)lane.push(recover('heading_'+i+'_return'));
  }
  const budget=returning?10000:3000;
  const start=[block(prefix+'_input','input_mode',{input}),block(prefix+'_neutral','neutral'),
    block(prefix+'_switch','channel',{channel:'vector-switch',action:'set',value:-100}),
    block(prefix+'_throttle','throttle',{value:50}),block(prefix+'_mode','mode',{mode})];
  // Normal-position motion retains the measured response/braking acceptance.
  const motions=group==='posctl'?BUILTIN_TESTS.filter(p=>p.mode==='POSCTL'&&p.input==='normal').flatMap(p=>positionMotion(p,height)):[];
  const setup=group==='vector'
    ? [...vectorRateEntry(prefix,height),...vectorRateChecks(prefix,['pitch','roll'])]
    : [...start,...(returning?[]:brake(prefix+'_entry',height)),...motions];
  return [...setup,{
    ...block(prefix+'_actions','parallel',{join:'any',timeout:budget}),
    lanes:[lane,[block(prefix+'_height','altitude',{target:height,duration:budget+10})]],
  },block(prefix+'_done','mark',{text:`${group} 三轴测试完成`})];
}
function fourModeDocument(id:string,height:number):TestDocument{
  const complete=id==='four_mode_complete';
  const groups=complete?[...FOUR_MODE_GROUPS]:[id.slice(5) as typeof FOUR_MODE_GROUPS[number]];
  const doc:TestDocument={version:1,name:complete?`MorphQuad 完整四模式 · ${height}m · 手动±35° / 定高±20° / 矢量速率`:`MorphQuad ${groups[0]} 三轴分组 · ${height}m`,
    aircraft:'MorphQuad',initialize:'current-instance',duration:14400,rateHz:50,throttle:0,clock:'realtime',onFinish:'land',onAbort:'land',
    requirements:{...(groups.some(g=>g==='manual'||g==='altctl')?{'manual-tilt-deg':35}:{}),...(groups.includes('altctl')?{'altitude-tilt-deg':20}:{}),...(groups.includes('vector')?vectorRequirements:{})},
    blocks:[block('bfour_prepare','mark',{text:'准备：手动起飞、统一原点与基准航向'}),...preparation(height),
      {...block('bfour_capture','parallel',{join:'any',timeout:135}),lanes:[
        [block('bfour_reference','manual_recover',{reference:'capture',mode:'MANUAL'})],
        [block('bfour_capture_height','altitude',{target:height,duration:140})],
      ]}]};
  for(const [i,group] of groups.entries())doc.blocks.push(block('bfour_'+group+'_stage','mark',{text:`测试组 ${i+1}/${groups.length}：${group}`}),...fourModeGroup(group,height));
  doc.blocks.push(block('bfour_complete','mark',{text:'测试完成，降落并确认着陆上锁'}));
  validateDocument(doc);return doc;
}
/** Local workspace template: loading does not execute or contact a device. */
export function builtinDocument(id:string,height=id.startsWith('xcd20_')?3:10):TestDocument{
  if(id.startsWith('xcd20_'))return xcd20Document(id,height);
  if(!Number.isFinite(height)||height<2||height>100)throw Error('内置测试高度须为 2～100 m');
  const preset=BUILTIN_TESTS.find(p=>p.id===id);if(!preset)throw Error('内置测试不存在');
  if(id.startsWith('four_'))return fourModeDocument(id,height);
  const doc:TestDocument={version:1,name:'',aircraft:'MorphQuad',initialize:'current-instance',duration:2440,rateHz:50,throttle:.5,clock:'realtime',onFinish:id==='complete'?'land':'hold',onAbort:'hold',blocks:[]};
  if(id==='complete'||id==='prepare'){
    doc.name=id==='complete'?`MorphQuad 完整测试 · ${height}m · 手动2s回位 · 定点打杆刹停 · 矢量±120°/10°`:`MorphQuad 手动油门起飞 ${height}m`;
    doc.duration=id==='complete'?14400:180;doc.throttle=0;
    doc.blocks=[block('bprepare_stage','mark',{text:id==='complete'?'阶段 1/9：普通输入，手动油门起飞与控高':'手动油门起飞与控高'}),...preparation(height)];
    if(id==='complete'){
      let stage=2;
      for(const p of BUILTIN_TESTS.filter(p=>p.mode&&p.axis))doc.blocks.push(block('b'+p.id+'_stage','mark',{text:`阶段 ${stage++}/9：${p.label}`}),...sweep(p,height));
      doc.blocks.push(block('bcomplete_stage','mark',{text:'9 个阶段完成，回中后降落并确认上锁'}));
    }
  }else if(id==='posctl_regression'){
    doc.name=`MorphQuad 定点专项 · ${height}m · 普通刹停 / 矢量速率与回平`;
    doc.duration=900;doc.throttle=0;doc.onFinish='land';
    doc.requirements=vectorRequirements;
    doc.blocks=[...preparation(height),...BUILTIN_TESTS.filter(p=>p.mode==='POSCTL'&&p.input==='normal').flatMap(p=>positionMotion(p,height)),
      ...vectorRateEntry('bvector_regression',height),...vectorRateChecks('bvector_regression',['pitch','roll'])];
  }else if(preset.input==='vector'){
    doc.name=`MorphQuad ${preset.label}`;
    doc.requirements=vectorRequirements;
    doc.blocks=[block('bcheck_armed','assert',{field:'armed',op:'eq',value:1,timeout:1}),block('bcheck_airborne','assert',{field:'landed',op:'eq',value:0,timeout:1}),
      ...vectorRateEntry('b'+id,height),...vectorRateChecks('b'+id,[preset.axis!])];
  }else{
    const motion=preset.mode==='POSCTL'&&preset.input==='normal';
    doc.name=`MorphQuad ${preset.label}${motion?'':preset.mode==='MANUAL'?' · 到位后2s / 每点回位零速':' · 到位后10s'}`;
    if(preset.mode==='MANUAL')doc.duration=5400;
    doc.blocks=[block('bcheck_armed','assert',{field:'armed',op:'eq',value:1,timeout:1}),block('bcheck_airborne','assert',{field:'landed',op:'eq',value:0,timeout:1}),...sweep(preset,height)];
  }
  validateDocument(doc);return doc;
}
