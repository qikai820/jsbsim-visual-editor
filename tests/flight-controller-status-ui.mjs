// Transport selection and stale-state UI with mocked board reports.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { uiBrowser } from './support/ui-browser.mjs';

const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import SimMenu from './src/components/SimMenu';
import './src/App.css';
createRoot(document.getElementById('root')).render(
  <div className="toolbar" style={{justifyContent:'flex-end',padding:20}}><SimMenu statusOnly /></div>
);`;
const setup = `
window.health={external:true,connected:true,running:false,state:'stopped',healthAgeMs:50};
window.__TAURI_INTERNALS__={
  metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
  transformCallback:()=>1,
  invoke:async(command)=>command==='sim_status'?window.health:{}
};`;
const ui = await uiBrowser(source, { setup, port:5193, width:1100, height:760 });
const { ev, until, click, send } = ui;
const button = `document.querySelector('.sim-flight-controller')`;
const popup = `document.querySelector('#sim-flight-controller-popover')`;
const field = name => `Array.from(${popup}.querySelectorAll('dt')).find(e=>e.textContent===${JSON.stringify(name)}).nextElementSibling.textContent`;
const usb = {
  usb_connected:true, device_path:'/dev/ttyACM0', heartbeat_alive:true,
  heartbeat_count:100, heartbeat_age_ms:50, armed:false, autopilot:12,
  vehicle_type:2, base_mode:0, custom_mode:3 << 16,
  usb_info_available:true, usb_vendor_id:0x26ac, usb_product_id:0x0032,
  usb_product:'USB Test FC', status_stale:false,
};
const network = {
  ...usb, usb_connected:false, network_configured:true, network_connected:true,
  network_peer:'192.168.1.10:14560', network_local_port:14560,
  vendor_name:'Test Vendor', model_name:'Ethernet FC', board_id_available:true,
  board_id:0x0035, actuator_rate_available:true, actuator_rate_hz:249.8, armed:true,
};
async function report(status) {
  await ev(`window.health.flightController=${JSON.stringify(status)}`);
}
try {
  await until(`${button}?.textContent.includes('飞控 待更新')`);
  await report({ ...usb, usb_connected:false, heartbeat_alive:false });
  await until(`${button}.textContent.includes('USB 未连接')`);
  await click(button);
  assert.equal(await ev(field('网口连接')), '未上报', 'older firmware does not invent network status');
  await report(usb);
  await until(`${button}.classList.contains('online')`);
  assert.equal(await ev(field('飞控型号')), 'USB Test FC');
  assert.equal(await ev(field('模式')), '位置');

  await report(network);
  await until(`${button}.textContent.includes('网口 已连接') && ${button}.classList.contains('online')`);
  assert.equal(await ev(field('当前链路')), '网口（UDP HIL）');
  assert.equal(await ev(field('飞控地址')), '192.168.1.10:14560');
  assert.equal(await ev(field('本地 HIL 端口')), '14560');
  assert.equal(await ev(field('飞控型号')), 'Test Vendor Ethernet FC');
  assert.equal(await ev(field('飞控固件')), 'PX4');
  assert.equal(await ev(field('USB 连接')), '未连接');
  assert.equal(await ev(field('心跳')), '在线');
  assert.equal(await ev(field('解锁状态')), '已解锁');
  assert.equal(await ev(field('HIL_ACTUATOR_CONTROLS')), '249.8 Hz');

  // A physical USB device must not override the model's selected UDP link
  // or supply its identity when it belongs to another flight controller.
  await report({ ...network, usb_connected:true, vendor_name:'', model_name:'' });
  await until(`(${field('飞控型号')}).includes('PX4 FMU v6X')`);
  assert.match(await ev(`${button}.textContent`), /网口 已连接/);
  assert.equal(await ev(field('USB 连接')), '已连接');

  await report({ ...network, network_connected:false, heartbeat_alive:false, actuator_rate_available:false });
  await until(`${button}.textContent.includes('网口 未连接') && ${button}.classList.contains('offline')`);
  assert.equal(await ev(field('飞控地址')), '--');
  assert.equal(await ev(field('心跳')), '离线');
  assert.equal(await ev(field('模式')), '--');
  assert.equal(await ev(field('解锁状态')), '未知');
  assert.equal(await ev(field('HIL_ACTUATOR_CONTROLS')), '--');

  await report({ ...network, heartbeat_alive:false, model_name:'', vendor_name:'' });
  await until(`${button}.textContent.includes('网口 已连接')`);
  assert.equal(await ev(field('心跳')), '离线', 'actuator-only stream proves the link, not a heartbeat');
  assert.equal(await ev(field('飞控型号')), '未识别', 'neither stale Board ID nor USB product identify the UDP FC');
  assert.equal(await ev(field('模式')), '--');

  await report({ ...network, status_stale:true, status_age_ms:6100 });
  await until(`${button}.textContent.includes('网口 待更新') && ${button}.classList.contains('stale')`);
  for (const name of ['网口连接', 'USB 连接', '心跳']) assert.equal(await ev(field(name)), '待更新');
  for (const name of ['飞控地址', '飞控型号', '模式', '本地 HIL 端口']) assert.equal(await ev(field(name)), '--');

  await report(network);
  await until(`${button}.textContent.includes('网口 已连接')`);
  await ev('window.health.connected=false');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.match(await ev(`${button}.textContent`), /网口 已连接/, 'short desktop transport gaps retain the separately aged FC report');
  await ev('window.health.connected=true');
  const clip = await ev(`(()=>{const a=${button}.getBoundingClientRect(),b=${popup}.getBoundingClientRect();return{x:b.x-12,y:a.y-12,width:b.width+24,height:b.bottom-a.y+24,scale:1};})()`);
  const screenshot = await send('Page.captureScreenshot', { format:'png', clip });
  await writeFile('/tmp/jsbsim-flight-controller-network.png', Buffer.from(screenshot.data, 'base64'));

  await report({ ...usb, network_configured:false, network_connected:false });
  await until(`${button}.textContent.includes('USB 已连接')`);
  await report(null);
  await until(`${button}.textContent.includes('飞控 待更新')`);
  assert.deepEqual(ui.errors, []);
  console.log('PASS: USB/UDP selection, FC details, identity isolation, actuator-only link, timeout/stale display, old firmware and desktop gaps. Mocked board telemetry.');
} finally {
  await ui.close();
}
