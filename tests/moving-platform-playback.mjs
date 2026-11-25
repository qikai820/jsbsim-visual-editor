// Regression for coupled aircraft/vessel playout, not a physics/flight test.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const work=await mkdtemp(path.join(tmpdir(),'ship-playback-'));
try {
  const file=path.join(work,'playback.cjs');
  await build({stdin:{contents:`export * from './client/src/sim/flightSceneState';export * from './client/src/sim/sceneMovingPlatform';export{Vector3}from'three';`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},outfile:file,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const require=createRequire(import.meta.url),api=require(file);
  const {FlightSceneFeed,PLATFORM_POSE_KEYS,PLATFORM_GEOMETRY_KEYS,sceneAttitude,Vector3}=api;
  const angles=t=>[.04*Math.sin(t),.03*Math.cos(1.2*t),.2*t];
  const quat=t=>{const a=angles(t);return sceneAttitude({roll:a[0]*180/Math.PI,pitch:a[1]*180/Math.PI,yaw:a[2]*180/Math.PI})};
  const relative=t=>[.15+.12*Math.sin(t*.3),-.1+.1*Math.sin(t*.4),-.0024+.08*Math.sin(t*.6)];
  function packet(ms,rate=1,skew=50,period=400) {
    const t=ms*rate/1000;
    const local=new Vector3(relative(t)[1],-relative(t)[2],-relative(t)[0]).applyQuaternion(quat(t));
    const world=new Vector3(3*t,2+.1*Math.sin(t*.7),.4*Math.sin(t*.3)).add(local);
    const positionMs=Math.floor(ms/period)*period,angleMs=Math.max(0,Math.floor((ms-skew)/period)*period+skew);
    const times=[positionMs,positionMs,positionMs,angleMs,angleMs,angleMs];
    const properties={'/moving-platform/enabled':1,'/position/terrain-elevation-asl-ft':500/.3048},ages={},sampleTimes={};
    for(const[key,value]of Object.entries(properties)){ages[key]=0;sampleTimes[key]=t;}
    PLATFORM_GEOMETRY_KEYS.forEach((key,i)=>{properties['/'+key]=[2,4,3,.25,1.5,.36,0,.1][i];ages['/'+key]=0;sampleTimes['/'+key]=t;});
    PLATFORM_POSE_KEYS.forEach((key,i)=>{const at=times[i]*rate/1000;properties['/'+key]=i<3?relative(at)[i]:angles(at)[i-3];ages['/'+key]=ms-times[i];sampleTimes['/'+key]=at;});
    const a=angles(t);
    return{instance_id:'01',model:'XCD20',tree_generation:1,state:'running',timestamp:t,capture_monotonic_us:ms*1000,
      latitude_deg:-world.z/6335439.3273*180/Math.PI,longitude_deg:world.x/6378137*180/Math.PI,altitude_m:500+world.y,
      roll_deg:a[0]*180/Math.PI,pitch_deg:a[1]*180/Math.PI,yaw_deg:a[2]*180/Math.PI,
      properties,scene_property_age_ms:ages,scene_property_time_sec:sampleTimes};
  }
  function replay(name,rate,deliverAt,period=400) {
    const feed=new FlightSceneFeed(),deliveries=Array.from({length:241},(_,i)=>({capture:i*50,arrival:deliverAt(i*50,i)})).sort((a,b)=>a.arrival-b.arrival||a.capture-b.capture);
    let next=0,last,held=0,backwards=0,largest=0,relativeError=0,lag=0;
    for(let ms=0;ms<=12000;ms+=1000/60) {
      while(next<deliveries.length&&deliveries[next].arrival<=ms){const d=deliveries[next++];feed.ingest({...packet(d.capture,rate,50,period),age_ms:d.arrival-d.capture},1000+d.arrival);}
      const sample=feed.sample('01',1000+ms);if(!sample?.platform)continue;
      assert.equal(sample.time,sample.platform.time,'aircraft and vessel share one simulation time');
      if(last&&ms>2500){const step=sample.platform.position.distanceTo(last.platform.position);if(step<1e-8)held++;
        if(sample.platform.position.x<last.platform.position.x-1e-8)backwards++;
        largest=Math.max(largest,step);lag=Math.max(lag,ms-sample.time*1000/rate);
        const offset=sample.position.clone().sub(sample.platform.position).applyQuaternion(sample.platform.quaternion.clone().invert());
        const expected=relative(sample.time),actual=[-offset.z,offset.x,-offset.y];
        relativeError=Math.max(relativeError,...actual.map((n,i)=>Math.abs(n-expected[i])));
      }
      last=sample;
    }
    assert.equal(held,0,`${name}: no held vessel frames between normal measurements`);
    assert.equal(backwards,0,`${name}: no playback rewinds`);
    assert(largest<.09*rate,`${name}: frame step ${largest} m is a packet jump`);
    assert(relativeError<.006,`${name}: coupled relative position error ${relativeError} m`);
    assert(lag<1000,`${name}: unbounded buffering ${lag} ms`);
    return{name,held,backwards,largestStepM:+largest.toFixed(4),maxRelativeErrorMm:+(relativeError*1000).toFixed(3),maxLagMs:Math.round(lag)};
  }
  const results=[replay('20 Hz body / 2.5 Hz interleaved vessel',1,ms=>ms),
    replay('120 ms IPC batching',1,ms=>Math.ceil(ms/120)*120),
    replay('variable delivery delay',1,(ms,i)=>ms+[0,10,65,20,90,0][i%6]),
    replay('simulation running at 2x wall speed',2,ms=>ms),
    replay('2 Hz vessel channels',1,ms=>ms,500)];

  const lifecycle=new FlightSceneFeed();for(let ms=0;ms<=3000;ms+=50){lifecycle.ingest(packet(ms),1000+ms);lifecycle.sample('01',1000+ms);}
  const frozen=lifecycle.sample('01',6100).platform.position.clone();
  lifecycle.ingest({...packet(6000),properties:{},scene_property_age_ms:{},scene_property_time_sec:{}},7100);
  assert(lifecycle.sample('01',7100).platform.position.distanceTo(frozen)<1e-9,'stale vessel must not follow fresh aircraft');
  lifecycle.recenter('01');assert(lifecycle.sample('01',7110).platform,'recentring preserves the frozen measured vessel');
  lifecycle.ingest({...packet(6100),tree_generation:2,properties:{},scene_property_age_ms:{}},7200);
  assert.equal(lifecycle.sample('01',7200).platform,null,'a generation change cannot retain the previous vessel transform');
  const pause=new FlightSceneFeed();for(let ms=0;ms<=3000;ms+=50){pause.ingest(packet(ms),1000+ms);pause.sample('01',1000+ms);}
  pause.ingest({...packet(3000),state:'paused',capture_monotonic_us:3001000},4050);
  const paused=pause.sample('01',4050);assert.deepEqual(pause.sample('01',4400).platform.position.toArray(),paused.platform.position.toArray());
  const wrap=new FlightSceneFeed();for(let ms=0;ms<=600;ms+=100){const p=packet(ms),a=ms<300?Math.PI-.01:-Math.PI+.01;
    for(let i=3;i<6;i++){p.properties['/'+PLATFORM_POSE_KEYS[i]]=i===5?a:0;p.scene_property_age_ms['/'+PLATFORM_POSE_KEYS[i]]=0;p.scene_property_time_sec['/'+PLATFORM_POSE_KEYS[i]]=ms/1000;}wrap.ingest(p,1000+ms);}
  const q=wrap.sample('01',1650).platform.quaternion;assert(q.angleTo(sceneAttitude({roll:0,pitch:0,yaw:180}))<.03,'heading crosses ±pi along the short quaternion arc');

  // Replay the read-only snapshots captured from the user's existing cache.
  let observed;
  try {
    const frames=JSON.parse(await readFile('/tmp/ship-observation-before.json','utf8'));
    const updated=new FlightSceneFeed();let oldApi;
    try{oldApi=require('/tmp/ship-smoothing-baseline.cjs')}catch{}
    const old=oldApi?new oldApi.FlightSceneFeed():null;let next=0,last,oldShip,oldKey,largest=0,oldLargest=0,maxPairError=0,largestFrame;
    const first=frames[0].arrived,end=frames.at(-1).arrived-first;
    for(let ms=0;ms<=end;ms+=1000/60){while(next<frames.length&&frames[next].arrived-first<=ms){const f=frames[next++];updated.ingest(f.packet,1000+f.arrived-first);old?.ingest(f.packet,1000+f.arrived-first);}
      const render=updated.sample('01',1000+ms);if(!render?.platform)continue;
      if(last&&ms>1000){const step=render.platform.position.distanceTo(last.platform.position);if(step>largest){largest=step;largestFrame={ms,before:last.time,after:render.time,oldP:last.position.toArray(),p:render.position.toArray(),buffer:updated.aircraft.get('01').platformTimeline.bufferMs,platformTimes:updated.aircraft.get('01').platformTimeline.samples.map(s=>s.time),age:1000+ms-updated.aircraft.get('01').platformTimeline.sampleAt};}}
      if(old){const entry=old.aircraft.get('01'),p=entry?.latest.platform;if(p&&p.sampleAt!==oldKey){oldKey=p.sampleAt;const a=p.angles.map(v=>v*180/Math.PI);const rotation=oldApi.sceneAttitude({roll:a[0],pitch:a[1],yaw:a[2]});const relative=new Vector3(p.relative[1],-p.relative[2],-p.relative[0]).applyQuaternion(rotation);const point=oldApi.localPosition(entry.latest,old.origin).sub(relative);if(oldShip&&ms>1000)oldLargest=Math.max(oldLargest,point.distanceTo(oldShip));oldShip=point;}}
      maxPairError=Math.max(maxPairError,Math.abs(render.platform.time-render.time));last=render;
    }
    observed={frames:frames.length,beforeLargestVesselStepM:+oldLargest.toFixed(4),afterLargestVesselStepM:+largest.toFixed(4),pairTimeSkewMs:maxPairError*1000};
    if(largest>.15)console.log('largest recorded frame',largestFrame);
    assert.equal(maxPairError,0);assert(largest<.15,'recorded stream must not cause packet-sized vessel jumps: '+JSON.stringify(observed));
    if(oldLargest>.2)assert(largest<oldLargest*.25,'recorded vessel jumps must be reduced substantially');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const report={passed:true,synthetic:results,observed};await writeFile('/tmp/moving-platform-playback-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await rm(work,{recursive:true,force:true});}
