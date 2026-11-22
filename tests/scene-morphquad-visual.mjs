// Actual editor model in WebGL, with isolated telemetry and no native/board I/O.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { uiBrowser } from './support/ui-browser.mjs';

const output = process.argv[2] || '/tmp/jsbsim-morphquad-visual';
await mkdir(output,{recursive:true});
const source = `import React from 'react';import{createRoot}from'react-dom/client';
import{Canvas,useFrame,useThree}from'@react-three/fiber';import{OrbitControls}from'@react-three/drei';
import{Box3,Vector3}from'three';import{MorphQuadAirframe}from'./src/components/flight-scene/FlightSceneCanvas';
import{FlightSceneFeed,demoPackets}from'./src/sim/flightSceneState';import{gimbalKey}from'./src/sim/sceneMorphQuad';
const feed=new FlightSceneFeed();let time=30;const packet={...demoPackets(time)[7],instance_id:'01',state:'paused'};
window.feed=feed;window.frames=0;window.angles=(angles)=>{packet.timestamp=++time;packet.capture_monotonic_us=time*1e6;
 for(let i=0;i<4;i++){packet.properties[gimbalKey(i,'outer')]=angles[i][0];packet.properties[gimbalKey(i,'inner')]=angles[i][1];}
 feed.ingest({...packet,properties:{...packet.properties}},performance.now());};window.angles(Array.from({length:4},()=>[0,0]));
window.Box3=Box3;window.Vector3=Vector3;
function Probe(){const s=useThree();window.view=s;useFrame(()=>window.frames++);return null;}
createRoot(document.getElementById('root')).render(<main style={{height:'100vh',display:'flex',flexDirection:'column',background:'#f1f2f2',fontFamily:'sans-serif',color:'#26313b'}}>
 <style>{'html,body,#root{margin:0;height:100%;overflow:hidden}*{box-sizing:border-box}'}</style>
 <header style={{padding:'22px 32px 8px'}}><h1 style={{margin:0,fontSize:28}}>MorphQuad · 编辑器三维模型</h1>
 <p style={{margin:'8px 0',fontSize:16}}>旋翼中心 380 × 406 mm　｜　6 英寸三叶共轴对桨　｜　四组独立双轴云台</p></header>
 <div style={{flex:1,minHeight:0}}><Canvas shadows dpr={1} camera={{position:[.60,.46,.65],fov:40,near:.01,far:20}} gl={{antialias:true}}>
 <color attach="background" args={['#f1f2f2']}/><hemisphereLight args={['#ffffff','#9ca3aa',2]}/>
 <directionalLight position={[1,2,1]} intensity={3} color="#fff7ed"/>
 <directionalLight position={[-1,1,-1]} intensity={1.5} color="#e6f1ff"/>
 <MorphQuadAirframe feed={feed} id="01" color="#25bbc1" showThrust={false}/>
 <mesh rotation={[-Math.PI/2,0,0]} position={[0,-.206,0]}><planeGeometry args={[20,20]}/><meshStandardMaterial color="#e3e5e7" roughness={1}/></mesh>
 <OrbitControls makeDefault target={[0,-.025,0]} minDistance={.25} maxDistance={3}/><Probe/>
 </Canvas></div><footer style={{padding:'10px 32px 20px',fontSize:14,color:'#5c6670'}}>实际 WebGL 渲染 · 公开尺寸约束，未公开的零部件尺寸按照片估计</footer>
</main>);`;
const ui=await uiBrowser(source,{port:5198,width:1500,height:1050});
const {ev,until,send}=ui;
const snapshot=async name=>writeFile(`${output}/${name}.png`,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
const close=(a,b)=>Math.abs(a-b)<1e-6;
try {
  await until(`window.frames>5&&window.view.scene.getObjectByName('scene-rotor-01-7')`);
  const stats=await ev(`(()=>{const root=view.scene.getObjectByName('scene-morphquad-01');root.updateWorldMatrix(true,true);
    const box=new Box3().setFromObject(root);let triangles=0,draws=0;
    root.traverse(o=>{if(o.isMesh){draws++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);}});
    return{bounds:[box.min.toArray(),box.max.toArray()],triangles,draws,renderer:view.gl.info.render.calls,
      centres:Array.from({length:4},(_,i)=>view.scene.getObjectByName('scene-gimbal-outer-01-'+i).parent.position.toArray()),
      rotors:Array.from({length:8},(_,i)=>{const o=view.scene.getObjectByName('scene-rotor-01-'+i);return{blades:o.children[0].count,p:o.getWorldPosition(new Vector3()).toArray(),color:o.children[0].instanceColor.array[0]};})};})()`);
  assert.deepEqual(stats.centres,[[.203,0,-.19],[-.203,0,-.19],[-.203,0,.19],[.203,0,.19]]);
  assert(close(stats.centres[0][0]-stats.centres[1][0],.406));
  assert(close(stats.centres[3][2]-stats.centres[0][2],.380));
  assert(close(stats.bounds[0][1],-.205));
  assert(Math.abs(stats.bounds[1][1]-stats.bounds[0][1]-.310)<.001,JSON.stringify(stats.bounds));
  for(let i=0;i<8;i++){assert.equal(stats.rotors[i].blades,3);assert(close(stats.rotors[i].p[1],i%2?-.035:.035));}
  assert(stats.draws<=50&&stats.triangles<25000,JSON.stringify(stats));
  const initialGeometries=await ev('view.gl.info.memory.geometries');
  await snapshot('perspective');
  await ev(`view.camera.position.set(0,1.05,.0001);view.controls.target.set(0,0,0);view.controls.update()`);
  await until('view.camera.position.y>1');await snapshot('plan');
  const angles=[[Math.PI,0],[.5,.35],[-2.2,.4],[0,-1.5]];
  await ev(`window.angles(${JSON.stringify(angles)})`);
  await until(`Math.abs(view.scene.getObjectByName('scene-gimbal-outer-01-0').rotation.x+Math.PI)<1e-6`);
  for(const [i,[a,b]] of angles.entries()) {
    const actual=await ev(`(()=>{const inner=view.scene.getObjectByName('scene-gimbal-inner-01-${i}');return new Vector3(0,1,0).transformDirection(inner.matrixWorld).toArray();})()`);
    const expected=[Math.sin(b),Math.cos(a)*Math.cos(b),-Math.sin(a)*Math.cos(b)];
    assert(actual.every((v,j)=>close(v,expected[j])),'independent gimbal thrust direction '+i);
  }
  await ev(`view.camera.position.set(.60,.46,.65);view.controls.target.set(0,-.025,0);view.controls.update()`);
  await snapshot('articulated');
  assert.equal(await ev('view.gl.info.memory.geometries'),initialGeometries,'telemetry and camera motion reuse GPU geometry');
  assert.equal(ui.errors.length,0,JSON.stringify(ui.errors));
  await writeFile(`${output}/verification.json`,JSON.stringify(stats,null,2));
  console.log('PASS: published 380 × 406 mm centres, 310 mm height, eight three-blade coaxial rotors, four independent two-axis transforms, stable GPU resources and real editor WebGL screenshots.',JSON.stringify({draws:stats.draws,triangles:stats.triangles,output}));
} finally {await ui.close();}
