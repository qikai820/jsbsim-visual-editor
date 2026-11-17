// Export the same metre-scale geometry used by FlightSceneCanvas, plus an offline preview.
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(process.argv[2] || path.join(repo, 'client/public/aircraft/voliro_t'));
const temporary = await mkdtemp(path.join(tmpdir(), 'voliro-visual-'));
const shared = `
import {createVoliroTModel,VOLIRO_T_GEOMETRY as g} from './client/src/sim/sceneVoliroT';
import {createPropellerBlade,createPropellerHub} from './client/src/sim/scenePropeller';
import * as THREE from 'three';
function assembled(withProps=true){
 const model=createVoliroTModel(),root=new THREE.Group();root.name='voliro_t';root.add(model.frame);
 model.pods.forEach((pod,i)=>{pod.position.set((i?1:-1)*g.halfSpan,0,-g.frontBodyX);root.add(pod)});
 const props=[];
 function propeller(parent,y,radius,blades,index,pitch,handedness){
  const rotor=new THREE.Group();rotor.name='M'+(index+1);rotor.position.y=y;rotor.userData.rotorIndex=index;
  for(let j=0;j<blades;j++){
   const blade=new THREE.Mesh(createPropellerBlade(radius,pitch,handedness),new THREE.MeshStandardMaterial({color:j?'#353a40':'#42464b',metalness:.12,roughness:.7}));
   const angle=j*Math.PI*2/blades;blade.rotation.y=angle;rotor.add(blade);
  }
  const hub=new THREE.Mesh(createPropellerHub(blades===2?.0095:.006,blades===2?.0048:.004,blades===2?.003:.0015),new THREE.MeshStandardMaterial({color:'#363b40',roughness:.7}));rotor.add(hub);
  rotor.userData.propellerModel=blades===2?g.frontPropellerModel:'6045 three-blade';rotor.userData.handedness=handedness;
  parent.add(rotor);props.push(rotor);
 }
 model.pods.forEach((pod,i)=>{propeller(pod,g.coaxialSpacing/2,g.frontPropellerRadius,2,i?0:2,g.frontPropellerPitch,i?1:-1);propeller(pod,-g.coaxialSpacing/2,g.frontPropellerRadius,2,i?1:3,g.frontPropellerPitch,i?-1:1)});
 const tail=new THREE.Group();tail.position.z=-g.tailBodyX;root.add(tail);propeller(tail,.031,g.tailPropellerRadius,3,4,g.tailPropellerPitch,1);
 props.forEach(p=>p.visible=withProps);root.userData={geometryVersion:g.version,units:'m',axes:'viewer: +X right, +Y up, -Z forward',provenance:g.provenance};
 return {root,model,props};
}
`;
try {
  await mkdir(output, { recursive: true });
  const cjs = path.join(temporary, 'export.cjs');
  await build({ stdin: { contents: shared + `
import {GLTFExporter} from 'three/examples/jsm/exporters/GLTFExporter.js';
export async function exportModel(withProps){
 const {root}=assembled(withProps);
 root.traverse(o=>{if(o.material?.map)o.material.map=null});
 return new Promise((resolve,reject)=>new GLTFExporter().parse(root,resolve,reject,{binary:true,onlyVisible:true}));
}`, resolveDir: repo }, outfile: cjs, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); }
    readAsDataURL(blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
  };
  const { exportModel } = createRequire(import.meta.url)(cjs);
  for (const [name, props] of [['voliro_t.glb', true], ['voliro_t_bare.glb', false]]) {
    const glb = Buffer.from(await exportModel(props)); await writeFile(path.join(output, name), glb);
    console.log(name, glb.length, 'bytes');
  }
  const metadata = JSON.parse(await readFile(path.join(repo, 'client/src/sim/voliroTGeometry.json')));
  await writeFile(path.join(output, 'visual-model.json'), JSON.stringify({ ...metadata,
    asset: 'voliro_t.glb', bareAsset: 'voliro_t_bare.glb', renderer: 'sceneVoliroT.ts',
    animation: { pivotAxis: 'scene X; rotation=-common tilt', right: [0, 1], left: [2, 3], tail: 4 },
    geometryCoordinates: 'CG relative; +X right, +Y up, -Z forward' }, null, 2) + '\n');
  const preview = await build({ stdin: { contents: shared + `
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.setClearColor('#e8ecee');document.body.appendChild(renderer.domElement);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;
const scene=new THREE.Scene();scene.add(new THREE.HemisphereLight('#f3f8ff','#586354',2.7));
const light=new THREE.DirectionalLight('#fff4e5',3);light.position.set(-2,4,3);light.castShadow=true;light.shadow.mapSize.set(2048,2048);light.shadow.camera.left=-2;light.shadow.camera.right=2;light.shadow.camera.top=2;light.shadow.camera.bottom=-2;light.shadow.bias=-.0001;scene.add(light);
const model=assembled(true);scene.add(model.root);model.root.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true}});
const groundY=-Math.max(...g.gear.contactsBody.map(p=>p[2]));
const floor=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:'#e3e7e8',roughness:.85}));floor.name='voliro-preview-ground';floor.rotation.x=-Math.PI/2;floor.position.y=groundY-.003;floor.receiveShadow=true;scene.add(floor);
const grid=new THREE.GridHelper(4,40,'#c7d0d4','#d9e0e3');grid.position.y=groundY-.002;scene.add(grid);
const camera=new THREE.PerspectiveCamera(36,innerWidth/innerHeight,.01,100);camera.position.set(1.55,1.15,1.7);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,-.09,.15);controls.enableDamping=true;controls.update();
document.getElementById('props').onchange=e=>model.props.forEach(p=>p.visible=e.target.checked);
document.getElementById('tilt').oninput=e=>{const deg=Number(e.target.value);model.model.pods.forEach(p=>p.rotation.x=-deg*Math.PI/180);document.getElementById('angle').textContent=deg+'°'};
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{const v=button.dataset.view;camera.position.set(...(v==='top'?[0,2.6,.151]:v==='front'?[0,.35,-2.5]:v==='side'?[2.5,.35,.15]:[1.55,1.15,1.7]));camera.up.set(0,1,0);controls.target.set(0,-.09,.15);controls.update()};
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
window.__voliro={model,renderer,scene,camera,controls};function animate(){requestAnimationFrame(animate);controls.update();renderer.render(scene,camera)}animate();
`, resolveDir: repo }, bundle: true, platform: 'browser', format: 'iife', write: false, minify: true, logLevel: 'silent' });
  const script = preview.outputFiles[0].text.replaceAll('</script', '<\\/script');
  await writeFile(path.join(output, 'preview.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Voliro T · 实机外形模型</title><style>*{box-sizing:border-box}body{margin:0;font:14px system-ui;color:#243039}canvas{display:block}aside{position:fixed;left:28px;top:26px;width:305px;background:#ffffffed;box-shadow:0 14px 50px #18313c18;padding:24px;border:1px solid #fff;border-radius:18px}h1{font-size:22px;margin:4px 0 12px}small{font-size:11px;letter-spacing:.13em;color:#387b7c}p{line-height:1.7;color:#596b75;font-size:12px}.dims{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:16px 0;border-block:1px solid #dce3e6;margin:16px 0}.dims strong{display:block;font-size:20px;font-weight:600}.dims span{font-size:11px;color:#74848b}button{border:1px solid #ccd7db;border-radius:7px;padding:7px 10px;background:#fff;color:#345;margin:3px;cursor:pointer}label{display:block;margin:15px 0}input[type=range]{width:100%;accent-color:#23898c}.note{font-size:11px;line-height:1.7}footer{position:fixed;bottom:20px;right:24px;color:#71828b;font-size:12px}</style><aside><small>PHOTO RECONSTRUCTION · 2026.11</small><h1>Voliro T 实机外形</h1><p>碳纤维 T 形机架 · 双侧共轴电机<br>共用倾转机构 · 可逆尾桨 · 三脚起落架<br>Tattu 机腹电池 · 前端对齐前横管</p><div class="dims"><div><strong>900 mm</strong><span>左右电机中心距</span></div><div><strong>780 mm</strong><span>横杆至尾电机</span></div><div><strong>110 mm</strong><span>上下桨面间距</span></div><div><strong>21×6.3</strong><span>MSC 主桨 · 直径 533.4 mm</span></div></div><label><input id="props" type="checkbox" checked> 显示飞行状态螺旋桨</label><label>共用倾转角 <b id="angle">0°</b><input id="tilt" type="range" min="-160" max="160" value="0"></label><div><button data-view="perspective">透视</button><button data-view="top">俯视</button><button data-view="front">正视</button><button data-view="side">侧视</button></div><p class="note">电机中心、重心和接地点沿用现有仿真模型。机壳、管径及电子设备外形按照片估算；起落架接地点距重心 190 mm。MSC 主桨外形参考用户 PDF，弦宽与翼型为近似。MSC 21×6.3 推力与扭矩采用转速表；油门至转速暂定，默认上限 5000 RPM。阻力系数待校准。</p></aside><footer>鼠标拖动旋转 · 滚轮缩放 · 离线三维预览</footer><script>${script}</script></html>`);
  console.log('Offline preview and visual-model.json exported to', output);
} finally { await rm(temporary, { recursive: true, force: true }); }
