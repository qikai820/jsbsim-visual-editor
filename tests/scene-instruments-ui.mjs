// Real instrument components with deterministic samples; no board or simulator I/O.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { uiBrowser } from './support/ui-browser.mjs';
const source = `
import React,{useState,useEffect} from 'react';import{createRoot}from'react-dom/client';
import{CircularSceneHud,SceneInstrumentSettings,SceneValueGrid}from'./src/components/flight-scene/SceneInstruments';
import{loadSceneDisplay,SCENE_DISPLAY_KEY}from'./src/sim/sceneInstruments';
import{decodeScenePose,demoPackets}from'./src/sim/flightSceneState';import{useSignalMonitorStore}from'./src/store/signalMonitorStore';
import'./src/App.css';import'./src/components/flight-scene/flightScene.css';import'./src/components/flight-scene/flightSceneWorkspace.css';
function Harness(){const[display,setDisplay]=useState(loadSceneDisplay),[selected,setSelected]=useState(0),[open,setOpen]=useState(false),[hud,setHud]=useState(false),[now,setNow]=useState(performance.now());
const[pose,setPose]=useState(()=>({...decodeScenePose(demoPackets(12)[0],performance.now()),yaw:86.2,roll:12,pitch:10}));
useEffect(()=>{localStorage.setItem(SCENE_DISPLAY_KEY,JSON.stringify(display))},[display]);useEffect(()=>{const t=setInterval(()=>setNow(performance.now()),100);return()=>clearInterval(t)},[]);
window.__pose=patch=>setPose(p=>({...p,...patch}));window.__sample=(value,generation)=>{useSignalMonitorStore.setState({samples:{'01:fcs/custom-rad':{value,seen:performance.now(),t:12,constant:false}},running:{'01':{generation:generation||'voliro_t:demo',state:'running',t:12,seen:performance.now()}}});setNow(performance.now())};
return <div className="flight-scene flight-scene-immersive" style={{height:'100vh'}}><div className={'scene-layout '+(open?'scene-panel-docked':'')}><main className="scene-main"><div className="scene-viewport"><div className={'scene-instruments '+(display.hud?'with-hud':'')}>
{display.numbers&&<SceneValueGrid layout={display.values} pose={pose} ground={582.6} now={now} demo={false} editing={open} selected={selected} onSelect={i=>{setSelected(i);setOpen(true)}} onConfigure={()=>setOpen(v=>!v)} onMove={(from,to)=>{setDisplay(d=>{const cells=[...d.values.cells];[cells[from],cells[to]]=[cells[to],cells[from]];return{...d,values:{...d.values,cells}}});setSelected(to)}}/>}
{display.hud&&<CircularSceneHud pose={pose} noseUp={display.noseUp} now={now} onConfigure={()=>{setHud(true);setOpen(true)}}/>}</div></div></main>
{open&&<SceneInstrumentSettings display={display} selected={selected} onSelected={setSelected} onChange={setDisplay} onClose={()=>setOpen(false)} unavailableKeys={[]} initialHud={hud}/>}</div></div>};createRoot(document.getElementById('root')).render(<Harness/>);`;
const ui = await uiBrowser(source, { port: 5198, width: 1916, height: 976 });
const { ev, until, click, send } = ui;
const cell = i => `document.querySelector('[data-value-cell="${i}"]')`;
const field = label => `document.querySelector('[aria-label="${label}"]')`;
async function value(label, next, tag = 'input', blur = false) {
  await ev(`(()=>{const input=${field(label)};Object.getOwnPropertyDescriptor(${tag === 'select' ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(input,${JSON.stringify(String(next))});input.dispatchEvent(new Event(${JSON.stringify(tag === 'select' ? 'change' : 'input')},{bubbles:true}));${blur ? "input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}))" : ''}})()`);
}
try {
  await until(`document.querySelectorAll('[data-value-cell]').length===10`);
  let proportions = await ev(`(()=>{const v=document.querySelector('.scene-viewport').getBoundingClientRect(),n=document.querySelector('.scene-values').getBoundingClientRect(),h=document.querySelector('.scene-round-hud').getBoundingClientRect();return{numbers:n.width/v.width,hud:h.width/v.width}})()`);
  assert.ok(Math.abs(proportions.numbers - .4) < .005); assert.ok(Math.abs(proportions.hud - .096) < .005);
  assert.equal(await ev(`document.querySelector('.scene-round-hud').dataset.pitch`), '-10', 'nose-up pitch sweeps the right arc upwards');
  await click(field('配置数值行列'));
  await click(field('增加一行')); await click(field('增加一列'));
  await until(`document.querySelectorAll('[data-value-cell]').length===18`);
  await click(cell(12)); await value('数值数据项', 'rpm0', 'select'); await value('数值显示名称', '前右上桨');
  await until(`${cell(12)}.textContent.includes('前右上桨')`);
  await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='← 前移')`);
  await until(`${cell(11)}.textContent.includes('前右上桨')`);
  await click(field('减少一行')); await click(field('减少一列'));
  await until(`document.querySelector('summary')?.textContent.includes('未放置指标')`);
  await ev(`Array.from(document.querySelectorAll('summary')).find(s=>s.textContent.includes('未放置指标')).click()`);
  await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='＋ 前右上桨')`);
  await until(`${cell(10)}?.textContent.includes('前右上桨')`);
  await click(cell(14)); await value('数值数据项', 'custom', 'select');
  await value('JSBSim 属性路径', 'fcs/custom-rad', 'input', true); await value('数值显示名称', '自定义角度');
  await ev(`window.__sample(3)`); await until(`${cell(14)}.querySelector('.scene-value-number').textContent==='3.0'`);
  await ev(`window.__sample(9,'another-model:demo')`); await until(`${cell(14)}.querySelector('.scene-value-number').textContent==='—'`);
  await ev(`window.__sample(3)`);
  const start = await ev(`(()=>{const r=${cell(10)}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const end = await ev(`(()=>{const r=${cell(13)}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start }); await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (end.x - start.x) * i / 8, y: start.y + (end.y - start.y) * i / 8, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
  await until(`${cell(13)}.textContent.includes('前右上桨')`);
  await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='完成')`);
  await click(`document.querySelector('.scene-round-hud')`); await value('航向显示模式', 'nose', 'select');
  await until(`Math.abs(Number(document.querySelector('.scene-round-hud').dataset.dial)+86.2)<1e-6`);
  assert.equal(await ev(`document.querySelector('.scene-round-hud g[transform]')?.getAttribute('transform')`), 'translate(85 99) rotate(0)');
  await click(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='完成')`);
  const previousTimeOrigin = await ev('performance.timeOrigin');
  await send('Page.reload'); await until(`performance.timeOrigin !== ${previousTimeOrigin} && ${cell(13)}?.textContent.includes('前右上桨') && ${cell(14)}?.textContent.includes('自定义角度')`);
  await until(`${cell(0)}?.classList.contains('stale')`);
  for (const width of [1916, 1024, 736, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 700 ? 800 : 976, deviceScaleFactor: 1, mobile: false });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(await ev(`document.documentElement.scrollWidth<=window.innerWidth`), `no horizontal overflow at ${width}`);
    assert.ok(await ev(`(()=>{const a=document.querySelector('.scene-values').getBoundingClientRect(),b=document.querySelector('.scene-round-hud').getBoundingClientRect();return a.right<=b.left||a.left>=b.right||a.top>=b.bottom||a.bottom<=b.top})()`), `instruments do not overlap at ${width}`);
  }
  assert.equal(ui.errors.length, 0, JSON.stringify(ui.errors));
  const shot = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/jsbsim-instruments-ui.png', Buffer.from(shot.data, 'base64'));
  console.log('Scene instruments UI: reference proportions, row/column edits, spare restoration, custom sampling/generation isolation, pointer reordering, compass modes, stale values and saved layouts passed.');
} finally { await ui.close(); }
