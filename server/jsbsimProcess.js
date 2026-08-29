/**
 * JSBSim process manager for Node.js server.
 * Spawns the standalone JSBSim binary, reads telemetry via UDP socket output.
 */

const { spawn } = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const JSBSIM_ROOT = process.env.JSBSIM_ROOT || path.resolve(__dirname, '../../jsbsim');
const JSBSIM_BIN = process.env.JSBSIM_BIN || path.join(JSBSIM_ROOT, 'build/src/JSBSim');
const TELEMETRY_PORT = parseInt(process.env.JSBSIM_TELEM_PORT || '5124', 10);

// Property names — must match createOutputXml() order
const PROPERTY_NAMES = [
  'position/h-sl-ft',
  'position/lat-gc-deg',
  'position/long-gc-deg',
  'attitude/phi-deg',
  'attitude/theta-deg',
  'attitude/psi-deg',
  'velocities/u-fps',
  'velocities/v-fps',
  'velocities/w-fps',
  'velocities/p-rad_sec',
  'velocities/q-rad_sec',
  'velocities/r-rad_sec',
  'accelerations/udot-ft_sec2',
  'accelerations/vdot-ft_sec2',
  'accelerations/wdot-ft_sec2',
  'fcs/throttle-cmd-norm',
  'fcs/aileron-cmd-norm',
  'fcs/elevator-cmd-norm',
  'fcs/rudder-cmd-norm',
];

const state = {
  process: null,
  running: false,
  paused: false,
  script: null,
  model: null,
  latestTelemetry: null,
  lastScript: null,
  lastModel: null,
};

let onTelemetry = null;
let onStatusChange = null;

function setTelemetryCallback(cb) { onTelemetry = cb; }
function setStatusCallback(cb) { onStatusChange = cb; }

function createOutputXml() {
  const xmlPath = path.join(JSBSIM_ROOT, '.visual-editor-output.xml');
  const xml = `<?xml version="1.0"?>
<output name="127.0.0.1" type="SOCKET" port="${TELEMETRY_PORT}" protocol="UDP" rate="30">
  <property> position/h-sl-ft </property>
  <property> position/lat-gc-deg </property>
  <property> position/long-gc-deg </property>
  <property> attitude/phi-deg </property>
  <property> attitude/theta-deg </property>
  <property> attitude/psi-deg </property>
  <property> velocities/u-fps </property>
  <property> velocities/v-fps </property>
  <property> velocities/w-fps </property>
  <property> velocities/p-rad_sec </property>
  <property> velocities/q-rad_sec </property>
  <property> velocities/r-rad_sec </property>
  <property> accelerations/udot-ft_sec2 </property>
  <property> accelerations/vdot-ft_sec2 </property>
  <property> accelerations/wdot-ft_sec2 </property>
  <property> fcs/throttle-cmd-norm </property>
  <property> fcs/aileron-cmd-norm </property>
  <property> fcs/elevator-cmd-norm </property>
  <property> fcs/rudder-cmd-norm </property>
</output>`;
  fs.writeFileSync(xmlPath, xml);
  return xmlPath;
}

let udpSocket = null;

function startUdpListener() {
  if (udpSocket) {
    try { udpSocket.close(); } catch (e) { /* ignore */ }
  }

  udpSocket = dgram.createSocket('udp4');
  let header = null;

  udpSocket.on('message', (msg) => {
    const text = msg.toString().trim();
    if (!text) return;

    // Header line
    if (text.startsWith('<LABELS>')) {
      // JSBSim replaces underscores with spaces in property names
      const csv = text.split(',').map(s => s.trim().replace(/^<LABELS>\s*/, '').replace(/ /g, '_')).filter(Boolean);
      header = csv;
      return;
    }

    // Data line
    const parts = text.split(',');
    if (parts.length === 0) return;

    const simTime = parseFloat(parts[0]);
    if (isNaN(simTime)) return;

    const telemetry = { t: simTime };

    // Use predefined full property paths (JSBSim strips prefixes in headers)
    for (let i = 1; i < parts.length; i++) {
      const val = parseFloat(parts[i]);
      if (!isNaN(val) && PROPERTY_NAMES[i - 1]) {
        telemetry['/' + PROPERTY_NAMES[i - 1]] = val;
      }
    }

    state.latestTelemetry = telemetry;
    if (onTelemetry) onTelemetry(telemetry);
  });

  udpSocket.on('error', (err) => {
    console.error('[jsbsim] UDP listener error:', err.message);
  });

  udpSocket.bind(TELEMETRY_PORT, '127.0.0.1', () => {
    console.log(`[jsbsim] UDP telemetry listener on port ${TELEMETRY_PORT}`);
  });
}

function stopUdpListener() {
  if (udpSocket) {
    try { udpSocket.close(); } catch (e) { /* ignore */ }
    udpSocket = null;
  }
}

function startScript(scriptPath) {
  stop();

  const fullPath = path.join(JSBSIM_ROOT, scriptPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Script not found: ${fullPath}`);
  }

  const outputXml = createOutputXml();
  startUdpListener();

  const child = spawn(JSBSIM_BIN, [
    '--root=.',
    `--script=${fullPath}`,
    `--logdirectivefile=${outputXml}`,
  ], {
    cwd: JSBSIM_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  state.process = child;
  state.running = true;
  state.paused = false;
  state.script = scriptPath;
  state.model = null;
  state.lastScript = scriptPath;
  state.lastModel = null;

  child.on('exit', (code) => {
    console.log(`[jsbsim] Process exited with code ${code}`);
    // Guard: only react if this is still the process we're tracking.
    // On restart/stop+start the old process may exit asynchronously after
    // a new one has already taken over state.process.
    if (state.process === child) {
      state.running = false;
      state.process = null;
      if (onStatusChange) onStatusChange({ running: false, exitCode: code });
    }
  });

  child.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error('[jsbsim]', msg);
  });

  if (onStatusChange) onStatusChange({ running: true, script: scriptPath });
  return { running: true, script: scriptPath };
}

function startModel(modelName) {
  stop();

  // The model picker returns paths such as `aircraft/737/737.xml`, while
  // JSBSim's --aircraft option expects the aircraft directory/name only.
  // Passing the path makes JSBSim fail during initialization when switching
  // models.
  const rawModel = String(modelName || '').replace(/\\/g, '/');
  const modelFile = path.posix.basename(rawModel).replace(/\.xml$/i, '');
  const modelDir = path.posix.basename(path.posix.dirname(rawModel));
  const aircraft = modelDir && modelDir !== '.' ? modelDir : modelFile;
  if (!aircraft || aircraft === '.') throw new Error('Invalid aircraft model');
  const aircraftXml = path.join(JSBSIM_ROOT, 'aircraft', aircraft, `${aircraft}.xml`);
  if (!fs.existsSync(aircraftXml)) {
    throw new Error(`Aircraft model not found: ${aircraft}`);
  }

  const outputXml = createOutputXml();
  startUdpListener();

  const child = spawn(JSBSIM_BIN, [
    '--root=.',
    `--aircraft=${aircraft}`,
    `--logdirectivefile=${outputXml}`,
    '--end=600',
  ], {
    cwd: JSBSIM_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  state.process = child;
  state.running = true;
  state.paused = false;
  state.model = aircraft;
  state.script = null;
  state.lastModel = aircraft;
  state.lastScript = null;

  child.on('exit', (code) => {
    console.log(`[jsbsim] Process exited with code ${code}`);
    // Guard: only react if this is still the process we're tracking.
    // On restart/stop+start the old process may exit asynchronously after
    // a new one has already taken over state.process.
    if (state.process === child) {
      state.running = false;
      state.process = null;
      if (onStatusChange) onStatusChange({ running: false, exitCode: code });
    }
  });

  child.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error('[jsbsim]', msg);
  });

  if (onStatusChange) onStatusChange({ running: true, model: aircraft });
  return { running: true, model: aircraft };
}

function pause() {
  if (!state.running) {
    throw new Error('仿真未运行');
  }
  if (state.paused) return { running: true, paused: true };
  if (state.process) {
    state.process.kill('SIGSTOP');
    state.paused = true;
  }
  if (onStatusChange) onStatusChange({ running: true, paused: true });
  return { running: true, paused: true };
}

function resume() {
  if (!state.running) {
    throw new Error('仿真未运行');
  }
  if (!state.paused) return { running: true, paused: false };
  if (state.process) {
    state.process.kill('SIGCONT');
    state.paused = false;
  }
  if (onStatusChange) onStatusChange({ running: true, paused: false });
  return { running: true, paused: false };
}

function restart() {
  if (state.lastScript) {
    return startScript(state.lastScript);
  }
  if (state.lastModel) {
    return startModel(state.lastModel);
  }
  throw new Error('没有可重新运行的仿真');
}

function stop() {
  stopUdpListener();

  if (state.process) {
    state.process.kill('SIGTERM');
    state.process = null;
  }

  state.running = false;
  state.script = null;
  state.model = null;

  if (onStatusChange) onStatusChange({ running: false });
  return { running: false };
}

function getStatus() {
  return {
    running: state.running,
    paused: state.paused,
    script: state.script,
    model: state.model,
    latestTelemetry: state.latestTelemetry,
  };
}

function listTests() {
  const scriptsDir = path.join(JSBSIM_ROOT, 'scripts');
  if (!fs.existsSync(scriptsDir)) return [];

  return fs.readdirSync(scriptsDir)
    .filter(f => f.endsWith('.xml'))
    .map(f => ({
      name: f.replace(/\.xml$/, ''),
      file: f,
      path: `scripts/${f}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listModels() {
  const aircraftDir = path.join(JSBSIM_ROOT, 'aircraft');
  if (!fs.existsSync(aircraftDir)) return [];

  const models = [];
  const dirs = fs.readdirSync(aircraftDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const dir of dirs) {
    const dirPath = path.join(aircraftDir, dir.name);
    const xmlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.xml'));

    for (const f of xmlFiles) {
      const content = fs.readFileSync(path.join(dirPath, f), 'utf8');
      if (content.includes('<fdm_config')) {
        models.push({
          name: dir.name,
          file: f,
          path: `aircraft/${dir.name}/${f}`,
        });
        break;
      }
    }
  }

  return models.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  state,
  startScript,
  startModel,
  stop,
  pause,
  resume,
  restart,
  getStatus,
  listTests,
  listModels,
  setTelemetryCallback,
  setStatusCallback,
};
