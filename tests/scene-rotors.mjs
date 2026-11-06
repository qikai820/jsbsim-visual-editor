import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const directory = await mkdtemp(path.join(tmpdir(), 'scene-rotors-'));
try {
  const output = path.join(directory, 'rotors.cjs');
  await build({ stdin: { contents: `export * from './client/src/sim/sceneRotors';export * from './client/src/sim/flightSceneState';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { estimatedFrontRpm, rotorReading, visibleRotorVelocity, rotorCount, rotorLabel, FlightSceneFeed, decodeScenePose, demoPackets } = createRequire(import.meta.url)(output);
  assert.equal(estimatedFrontRpm(.33),2465);assert.equal(estimatedFrontRpm(1),5399);
  assert.equal(estimatedFrontRpm(.34),2518.5);assert.equal(estimatedFrontRpm(.165),1232.5);
  assert.equal(estimatedFrontRpm(-1),0);assert.equal(estimatedFrontRpm(2),5399);
  // At 40 FPS, 2400 RPM advances exactly one turn per frame and looks stopped.
  // Display compression must preserve direction and keep visible blade motion.
  const physical=2400*Math.PI/30;
  assert.ok(Math.abs(physical/40-Math.PI*2)<1e-9);
  const visible=visibleRotorVelocity(physical);
  assert.ok(visible/40>.05 && visible/40<Math.PI/3);
  assert.ok(visibleRotorVelocity(-physical)<0);assert.equal(visibleRotorVelocity(0),0);
  assert.equal(visibleRotorVelocity(2),2,'low-speed rotation stays at actual speed');
  assert.equal(rotorCount('voliro_t'),5);assert.equal(rotorCount('F450_PX4'),4);assert.equal(rotorCount('c172p'),1);
  assert.equal(rotorLabel('voliro_t',0),'M1 · 右上');
  const packet=demoPackets(10)[0];
  // Current Voliro has ESC/thrust signals but no RPM state.
  for (const key of Object.keys(packet.properties)) if (key.includes('/rpm[')) delete packet.properties[key];
  packet.properties['/fcs/esc-out[0]']=.33;packet.properties['/fcs/esc-out[1]']=.33;packet.properties['/fcs/esc-out[4]']=-.5;
  const pose=decodeScenePose(packet,1000);
  const front=rotorReading(pose,0,1000),lower=rotorReading(pose,1,1000),tail=rotorReading(pose,4,1000);
  assert.equal(front.source,'bench');assert.equal(front.rpm,2465);assert.ok(front.angularVelocity>0);
  assert.ok(lower.angularVelocity<0,'coaxial lower rotor spins in the opposite direction');
  assert.equal(tail.rpm,null,'tail animation never fabricates an RPM');assert.equal(tail.source,'visual');assert.ok(tail.angularVelocity<0);
  assert.equal(rotorReading({...pose,state:'paused'},0,1000).angularVelocity,0);
  assert.equal(rotorReading(pose,0,3100).angularVelocity,0,'stale ESC estimates cannot keep spinning');
  const actual={...packet,properties:{...packet.properties,'/01/jsbsim/fcs[0]/voliro_t[0]/rpm[0]':0},
    scene_property_age_ms:{...packet.scene_property_age_ms,'/01/jsbsim/fcs[0]/voliro_t[0]/rpm[0]':0}};
  const stopped=rotorReading(decodeScenePose(actual,1000),0,1000);
  assert.equal(stopped.source,'model');assert.equal(stopped.rpm,0);assert.equal(stopped.angularVelocity,0,'real zero RPM takes priority over an ESC estimate');
  const foreign={...actual,properties:{'/02/jsbsim/fcs[0]/voliro_t[0]/rpm[0]':9000},scene_property_age_ms:{'/02/jsbsim/fcs[0]/voliro_t[0]/rpm[0]':0}};
  assert.equal(decodeScenePose(foreign,1000).rpm[0],null,'RPM cannot cross aircraft instances');
  const feed=new FlightSceneFeed();feed.ingest(packet,1000);
  const seen=feed.aircraft.get('01').latest.receivedAt;
  feed.ingestMonitor({instance_id:'01',model:'voliro_t',tree_generation:'demo',timestamp:10.1,
    monitor:{version:1,revision:42,sequence:1,samples:{'fcs/voliro_t/rpm[0]':[4200,10.1,false], 'fcs/voliro_t/rpm[4]':[-6000,10.1,false],
      'fcs/voliro_t/rpm-model/version':[1,10.1,false],'fcs/voliro_t/rpm-model/tail-calibrated':[0,10.1,false]}}},1100);
  const measured=feed.aircraft.get('01').latest;
  assert.equal(measured.receivedAt,seen,'RPM-only packets cannot freshen body pose');
  assert.equal(measured.rpmModelVersion,1);assert.equal(measured.rpmTailCalibrated,false);
  assert.equal(rotorReading(measured,0,1100).rpm,4200);assert.equal(rotorReading(measured,0,1100).source,'model');
  assert.equal(rotorReading(measured,4,1100).rpm,-6000);assert.ok(rotorReading(measured,4,1100).angularVelocity<0);
  assert.equal(rotorReading(measured,0,3200).angularVelocity,0,'expired real RPM freezes instead of falling back to an estimate');
  feed.ingest({...packet,timestamp:10.2,capture_monotonic_us:10.2e6},1200);
  assert.equal(feed.aircraft.get('01').latest.rpm[0],4200,'native property slices do not blank monitored RPM');
  feed.ingest({...packet,tree_generation:'new',timestamp:0,capture_monotonic_us:11e6},1300);
  assert.equal(feed.aircraft.get('01').latest.rpm[0],null,'model reload clears previous RPM');
  const quad=demoPackets(10)[1];quad.properties={'/02/jsbsim/propulsion[0]/engine[0]/propeller-rpm[0]':3000,
    '/02/jsbsim/propulsion[0]/engine[0]/propeller-sense[0]':-1};
  quad.scene_property_age_ms=Object.fromEntries(Object.keys(quad.properties).map(key=>[key,0]));
  const quadPose=decodeScenePose(quad,2000);
  assert.equal(quadPose.rpm[0],3000);assert.equal(rotorReading(quadPose,0,2000).angularVelocity,-100*Math.PI);
  assert.equal(rotorReading(quadPose,1,2000).source,'none','other aircraft never use Voliro bench estimates');
  console.log('Rotor RPM: bench interpolation, signed/model RPM, true zero, coaxial directions, tail indication, pause/expiry, instance isolation and reload passed.');
} finally { await rm(directory,{recursive:true,force:true}); }
