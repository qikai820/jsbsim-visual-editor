import {copy, DEFS, type Params, type TestBlock, type TestDocument, validateDocument} from './model';

export const XCD20_TEST_IDS=['xcd20_normal_takeoff','xcd20_rail_takeoff'] as const;
export function xcd20Document(id:string,height=3):TestDocument {
  if(!XCD20_TEST_IDS.includes(id as typeof XCD20_TEST_IDS[number]))throw Error('未知 XCD20 测试');
  if(!Number.isFinite(height)||height<3||height>10)throw Error('XCD20 测试高度须为 3～10 m');
  const rail=id==='xcd20_rail_takeoff';let serial=0;
  const b=(name:string,type:TestBlock['type'],p:Params={}):TestBlock=>({id:'b'+name+'_'+(++serial),type,p:{...copy(DEFS[type].p),...p}});
  const mark=(s:string)=>b('mark','mark',{text:s});
  const wait=(seconds:number)=>b('wait','wait',{duration:seconds});
  const check=(field:string,value:number,op='eq',timeout=5)=>b('check','assert',{field,op,value,timeout});
  const observe=(field:string,min:number,max:number,duration:number,reference='absolute')=>b('observe','observe',{field,min,max,duration,reference});
  const together=(lanes:TestBlock[][],timeout:number,join='all'):TestBlock=>({...b('parallel','parallel',{join,timeout}),lanes});
  const heightAssist=(target:number,duration:number)=>b('height','altitude',{target,duration,tolerance:.15,hover:50,min:10,max:70,slew:10,response:8,damping:20,trim:1.5,deadzone:6});
  const hover=(mode:number,seconds=10,position=false):TestBlock=>together([
    [observe('mode',mode,mode,seconds)],
    [observe('height-above-launch-m',height-.3,height+.3,seconds)],
    [observe('climb-rate-mps',-.3,.3,seconds)],
    [observe('roll-abs-deg',0,8,seconds)],[observe('pitch-abs-deg',0,8,seconds)],
    ...(position?[[observe('local-x-m',-.7,.7,seconds,'start')],[observe('local-y-m',-.7,.7,seconds,'start')],[observe('groundspeed-mps',0,.3,seconds)]]:[]),
  ].reduce<TestBlock[][]>((lanes,lane)=>{
    // The editor supports at most four parallel lanes. Keep all checks active
    // by grouping watches in nested parallel blocks, never sampling just once.
    lanes.push(lane);return lanes;
  },[]).reduce<TestBlock[][]>((lanes,lane,index,all)=>{
    if(index%3===0)lanes.push([together(all.slice(index,index+3).length===1?[all[index],[wait(seconds)]]:all.slice(index,index+3),seconds+2)]);
    return lanes;
  },[]),seconds+4);
  const settle=(target:number):TestBlock[]=>[
    b('near_height','wait_state',{field:'height-above-launch-m',op:'ge',value:target-.2,timeout:75}),wait(3),
    together([[observe('height-above-launch-m',target-.3,target+.3,1)],[observe('climb-rate-mps',-.2,.2,1)]],3),
  ];
  const riseByStick=(mode:number):TestBlock[]=>[
    mark('以当前模式推升降杆起飞；不发送 NAV_TAKEOFF'),
    together([[heightAssist(height,120)],settle(height)],100,'any'),
    b('center_throttle','throttle',{value:50}),wait(1),check('mode',mode),
  ];
  const ground=(mode:string):TestBlock[]=>[
    mark('新测试段：确认落地上锁，重新记录起飞高度'),check('armed',0),check('landed',1),
    b('neutral','neutral'),b('low','throttle',{value:0}),b('mode','mode',{mode,timeout:10}),
    b('launch_reference','launch_reference'),b('arm','arm',{timeout:10}),wait(3),
  ];
  const finish=():TestBlock[]=>[
    b('neutral','neutral'),b('land','land',{timeout:60}),check('landed',1),
    b('low','throttle',{value:0}),b('disarm','disarm',{timeout:10}),check('armed',0),wait(3),
  ];
  const positionMotion=():TestBlock[]=>['pitch','roll'].flatMap(axis=>[1,-1].flatMap(sign=>[
    mark(`POSCTL ${axis} ${sign>0?'+':'−'}35%：先建立运动，再松杆检查刹停`),
    together([[b('pulse','pulse',{axis,value:35*sign,duration:4})],[b('moving','wait_state',{field:'groundspeed-mps',op:'ge',value:.5,timeout:4})]],5),
    b('neutral','neutral'),
    b('braking','wait_state',{field:'groundspeed-mps',op:'le',value:.3,timeout:15}),
    hover(3,5,true),
  ]));
  const blocks:TestBlock[]=[mark(rail?'双杆：SLIDE=1；自动起飞完成后切定点；模型真值仅用于测试核验':'普通：SLIDE=0；手动/定高/定点各自从地面起飞'),b('normal_input','input_mode',{input:'normal'})];
  if(!rail){
    blocks.push(mark('N01 手动起飞；高度辅助仅模拟驾驶员推油门，不代表飞控自动定高'),...ground('MANUAL'),
      b('manual_takeoff','manual_takeoff',{target:height,climb:.5,tolerance:.2,settle:2,timeout:90,hover:50,max:70,slew:8}));
    const pulses=['pitch','roll','yaw'].flatMap(axis=>[1,-1].flatMap(sign=>[
      mark(`MANUAL ${axis} ${sign>0?'+':'−'}20%`),
      together([[b('pulse','pulse',{axis,value:20*sign,duration:1})],[b('response','wait_state',{field:axis==='yaw'?'yaw-rate-abs-rad-s':axis+'-abs-deg',op:'ge',value:axis==='yaw'?.02:2,timeout:1})]],2),
      b('neutral','neutral'),wait(2),
      together([[observe('mode',1,1,1)],[observe('roll-abs-deg',0,8,1)],[observe('pitch-abs-deg',0,8,1)]],2),
    ]));
    blocks.push(together([[heightAssist(height,120)],pulses],85,'any'),...finish());
    blocks.push(mark('N02 定高：起飞后关闭测试器控高，使用中位油门检查飞控自身定高'),...ground('ALTCTL'),...riseByStick(2),hover(2));
    for(const target of [height+.5,height])blocks.push(
      mark(`ALTCTL 升降至本次起飞高度 ${target}m，之后中位油门保持`),
      together([[heightAssist(target,100)],settle(target)],80,'any'),b('center','throttle',{value:50}),
      together([[observe('height-above-launch-m',target-.3,target+.3,5)],[observe('mode',2,2,5)],[observe('climb-rate-mps',-.3,.3,5)]],7));
    blocks.push(...finish(),mark('N03 定点：当前模式从地面起飞，松杆后由飞控位置环制动'),...ground('POSCTL'),...riseByStick(3),hover(3,10,true),...positionMotion(),...finish());
  }else{
    blocks.push(check('armed',0),check('sim/rail-contact-mask',3),check('sim/rail-valid-mask',3),
      b('neutral','neutral'),b('low','throttle',{value:0}),b('mode','mode',{mode:'POSCTL',timeout:10}),
      b('launch_reference','launch_reference'),b('arm','arm',{timeout:10}),wait(3),
      mark('R01 双杆自动起飞：飞控自身融合估计；不注入船速/接触状态'),b('takeoff','takeoff',{altitude:height,timeout:60}),
      // Keep the existing low input unchanged throughout AUTO_TAKEOFF.
      // A throttle step here can trigger the configured pilot-override guard.
      b('auto_complete','wait_state',{field:'mode',op:'eq',value:4,timeout:30}),
      // mode=4 is decoded AUTO_LOITER, distinct from AUTO_TAKEOFF=9.
      check('sim/rail-contact-mask',0,'eq',.2),check('sim/rail-released-mask',3,'eq',.2),
      observe('sim/rail-contact-mask',0,0,1),
      mark('R02 自动起飞完成且物理已脱杆：准备中位输入并切入 POSCTL'),
      // Prepare manual zero-climb input before the mode command is acknowledged.
      // This is deliberately after AUTO completion and physical rod release.
      b('center','throttle',{value:50}),b('posctl','mode',{mode:'POSCTL',timeout:10}),
      b('neutral','neutral'),wait(2),hover(3,10,true),...positionMotion(),...finish());
  }
  blocks.push(mark('所有测试段完成并确认上锁；结果不代表真实船上飞行验收'));
  const doc:TestDocument={version:1,name:rail?'XCD20 双杆自动起飞 → 定点悬停与刹停':'XCD20 普通起飞 · 手动 / 定高 / 定点',aircraft:'XCD20_FlightIdentified',initialize:'current-instance',duration:rail?480:1200,rateHz:50,throttle:0,clock:'realtime',onFinish:'land',onAbort:rail?'hold':'land',requirements:{'xcd20-takeoff':rail?1:0},blocks};
  validateDocument(doc);return doc;
}
