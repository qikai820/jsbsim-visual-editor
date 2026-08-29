const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const { generateXml, generateSubFileXml } = require('./xmlGenerator');
const { parseXml, parseSubFileXml } = require('./xmlParser');
const simClient = require('./simClient');
const jsbsimProcess = require('./jsbsimProcess');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In HIL mode JSBSim is owned by px4-jsbsim-bridge.  The editor remains a
// monitor/control station and must not spawn a second local JSBSim process.
const EXTERNAL_SIM = /^(1|true|yes)$/i.test(process.env.SIM_EXTERNAL || '');

// Serve static files in production
app.use(express.static(path.join(__dirname, '../dist/client')));

// ── JSBSim file search paths ──────────────────────────────────────────────
const JSBSIM_ROOT = path.resolve(__dirname, '../../jsbsim');
// Prefer the runtime-loaded RAM tree used by the bridge.  The local tree is
// only a development fallback when the target has not been mounted.
const JSBSIM_RUNTIME_ROOT = process.env.JSBSIM_RUNTIME_ROOT || '/mnt/jsbsim';
const JSBSIM_DATA_ROOT = fs.existsSync(JSBSIM_RUNTIME_ROOT)
  ? JSBSIM_RUNTIME_ROOT : JSBSIM_ROOT;
const JSBSIM_SEARCH_DIRS = [
  path.join(JSBSIM_DATA_ROOT, 'systems'),
  path.join(JSBSIM_DATA_ROOT, 'engine'),
  path.join(JSBSIM_DATA_ROOT, 'aircraft'),
];

// Recursively find all XML files under a directory
function findXmlFiles(dir, results = []) {
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findXmlFiles(full, results);
      } else if (entry.name.endsWith('.xml')) {
        results.push({ path: full, name: entry.name, relPath: path.relative(JSBSIM_ROOT, full) });
      }
    }
  } catch (e) { /* ignore permission errors */ }
  return results;
}

// Build a file index: maps filename (with and without path) to file content
let jsbsimFileCache = null;
function getJsbsimFileIndex() {
  if (jsbsimFileCache) return jsbsimFileCache;
  jsbsimFileCache = {};
  const allFiles = [];
  for (const dir of JSBSIM_SEARCH_DIRS) {
    findXmlFiles(dir, allFiles);
  }
  for (const f of allFiles) {
    try {
      const content = fs.readFileSync(f.path, 'utf8');
      // Index by basename
      jsbsimFileCache[f.name] = content;
      // Index by basename without extension
      const noExt = f.name.replace(/\.xml$/i, '');
      jsbsimFileCache[noExt] = content;
      // Index by relative path
      jsbsimFileCache[f.relPath] = content;
      // Index by relative path without extension
      jsbsimFileCache[f.relPath.replace(/\.xml$/i, '')] = content;
    } catch (e) { /* ignore read errors */ }
  }
  console.log(`[JSBSim] Indexed ${allFiles.length} XML files from ${JSBSIM_SEARCH_DIRS.length} directories`);
  return jsbsimFileCache;
}

// Resolve file references: try user-uploaded files first, then JSBSim directories
function buildFileMap(userFiles = []) {
  const fileMap = {};
  // First: user-uploaded files (highest priority)
  for (const f of userFiles) {
    if (f.name && f.xml) {
      fileMap[f.name] = f.xml;
      const base = f.name.split('/').pop();
      fileMap[base] = f.xml;
      const noExt = base.replace(/\.[^.]+$/, '');
      fileMap[noExt] = f.xml;
    }
  }
  // Second: JSBSim directory files (fill in any missing references)
  const jsbsimIndex = getJsbsimFileIndex();
  for (const [key, content] of Object.entries(jsbsimIndex)) {
    if (!fileMap[key]) {
      fileMap[key] = content;
    }
  }
  return fileMap;
}

// POST /api/generate-xml - Convert JSON graph to JSBSim XML
// Body: { aircraft: { name, version, release }, nodes: [...], edges: [...] }
// Response: { xml: "..." }
app.post('/api/generate-xml', (req, res) => {
  try {
    const xml = generateXml(req.body);
    res.json({ xml });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/parse-xml - Parse JSBSim XML to JSON graph
// Body: { xml: "...", files?: [{ name: "xxx.xml", xml: "..." }] }
// Response: { aircraft, nodes, edges }
// Auto-resolves references from JSBSim directories if files not provided
app.post('/api/parse-xml', (req, res) => {
  try {
    const { xml, files } = req.body;
    // Build file map: user files first, then auto-search JSBSim directories
    const fileMap = buildFileMap(files || []);
    const result = parseXml(xml, fileMap);
    // Report which references were resolved
    const resolved = [];
    for (const n of result.nodes) {
      const p = n.data.params;
      if (p._source_file && fileMap[p._source_file]) {
        resolved.push(p._source_file);
      }
      if (p.file && p._source_file !== p.file && fileMap[p.file]) {
        resolved.push(p.file);
      }
    }
    if (resolved.length > 0) {
      console.log(`[parse-xml] Auto-resolved ${resolved.length} reference(s): ${[...new Set(resolved)].join(', ')}`);
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/jsbsim-files - List available JSBSim XML files
app.get('/api/jsbsim-files', (req, res) => {
  try {
    const index = getJsbsimFileIndex();
    // Return unique file paths (deduplicate by relPath)
    const seen = new Set();
    const files = [];
    for (const [key, content] of Object.entries(index)) {
      if (key.includes('/') && !seen.has(key)) {
        seen.add(key);
        files.push({ path: key, size: content.length });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    res.json({ files, total: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read the runtime JSBSim system directory from the NuttX target via FTP.
// The target keeps the loaded tree in RAM, so the desktop copy is not used.
app.get('/api/nuttx-system-files', (req, res) => {
  const host = process.env.NUTTX_HOST || '192.168.101.81';
  const user = process.env.NUTTX_FTP_USER || 'root';
  const password = process.env.NUTTX_FTP_PASSWORD || 'abc123';
  // FTP HOME is /mnt/sdcard, and the target directory is
  // /mnt/sdcard/jsbsim/systems, so use the FTP-relative path.
  const url = `ftp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/jsbsim/systems/`;
  execFile('curl', ['--noproxy', '*', '--silent', '--show-error', '--fail', '--list-only', url],
    { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        res.status(502).json({ error: `无法读取 NuttX systems: ${stderr || error.message}` });
        return;
      }
      const files = stdout.split(/\r?\n/).map(name => name.trim())
        .filter(name => name.endsWith('.xml'))
        .map(name => ({ path: `systems/${name}`, size: 0 }));
      res.json({ files, total: files.length, source: `nuttx://${host}/mnt/jsbsim/systems` });
    });
});

app.get('/api/nuttx-engine-files', (req, res) => {
  const host = process.env.NUTTX_FTP_HOST || '192.168.101.81';
  const user = process.env.NUTTX_FTP_USER || 'root';
  const password = process.env.NUTTX_FTP_PASSWORD || 'abc123';
  const url = `ftp://${host}/jsbsim/engine/`;
  execFile('curl', ['--noproxy', '*', '--silent', '--show-error', '--disable-epsv', '--user', `${user}:${password}`, '--max-time', '8', '--list-only', url], (error, stdout, stderr) => {
    if (error) return res.status(502).json({ error: stderr || error.message, files: [] });
    const files = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(s => s.toLowerCase().endsWith('.xml'));
    res.json({ files, source: 'nuttx-ftp' });
  });
});

// POST /api/generate-subfile - Generate sub-file XML (engine, thruster, system)
// Body: { type, name, params }
// Response: { xml: "..." }
app.post('/api/generate-subfile', (req, res) => {
  try {
    const xml = generateSubFileXml(req.body);
    res.json({ xml });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/parse-subfile - Parse sub-file XML to JSON
// Body: { xml: "...", fileType: "..." }
// Response: { type, name, params }
app.post('/api/parse-subfile', (req, res) => {
  try {
    const result = parseSubFileXml(req.body.xml, req.body.fileType);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/save - Save JSON project to file
app.post('/api/save', (req, res) => {
  try {
    const fs = require('fs');
    const filePath = path.join(__dirname, '../projects', req.body.filename || 'project.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));
    res.json({ success: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/project-path', (req, res) => {
  res.json({ path: path.join(__dirname, '../projects', req.body.filename || 'project.json') });
});

// POST /api/load - Load JSON project from file
app.post('/api/load', (req, res) => {
  try {
    const fs = require('fs');
    const filePath = path.join(__dirname, '../projects', req.body.filename || 'project.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data._projectPath = filePath;
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: 'Project not found' });
  }
});

// GET /api/projects - List saved projects
app.get('/api/projects', (req, res) => {
  try {
    const fs = require('fs');
    const dir = path.join(__dirname, '../projects');
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Generate Aircraft XML from Wizard ──────────────────────────────────────

app.post('/api/generate-aircraft', (req, res) => {
  try {
    const d = req.body;
    const ind = (n) => '  '.repeat(n);
    const uLen = d.unitSystem === 'METRIC' ? 'M' : 'IN';
    const uFt = d.unitSystem === 'METRIC' ? 'M' : 'FT';
    const uFt2 = d.unitSystem === 'METRIC' ? 'M2' : 'FT2';
    const uWt = d.unitSystem === 'METRIC' ? 'KG' : 'LBS';
    const uIn = d.unitSystem === 'METRIC' ? 'KG*M2' : 'SLUG*FT2';

    const loc = (name, obj) => `${ind(2)}<location name="${name}" unit="${uLen}">\n${ind(3)}<x> ${obj.x} </x>\n${ind(3)}<y> ${obj.y} </y>\n${ind(3)}<z> ${obj.z} </z>\n${ind(2)}</location>\n`;
    const loc3 = (obj) => `${ind(3)}<location unit="${uLen}">\n${ind(4)}<x> ${obj.x} </x>\n${ind(4)}<y> ${obj.y} </y>\n${ind(4)}<z> ${obj.z} </z>\n${ind(3)}</location>\n`;

    let x = `<?xml version="1.0"?>\n<fdm_config name="${d.name}" version="${d.version}" release="${d.release}">\n`;

    // File header
    x += `${ind(1)}<fileheader>\n`;
    if (d.author) x += `${ind(2)}<author>${d.author}</author>\n`;
    x += `${ind(2)}<filecreationdate>${new Date().toISOString().split('T')[0]}</filecreationdate>\n`;
    x += `${ind(2)}<version>1.0</version>\n`;
    if (d.description) x += `${ind(2)}<description>${d.description}</description>\n`;
    x += `${ind(1)}</fileheader>\n`;

    // Metrics
    x += `${ind(1)}<metrics>\n`;
    x += `${ind(2)}<wingarea unit="${uFt2}"> ${d.wingarea} </wingarea>\n`;
    x += `${ind(2)}<wingspan unit="${uFt}"> ${d.wingspan} </wingspan>\n`;
    x += `${ind(2)}<chord unit="${uFt}"> ${d.chord} </chord>\n`;
    if (d.aircraftType === 'helicopter' && d.wingIncidence) x += `${ind(2)}<wing_incidence unit="DEG"> ${d.wingIncidence} </wing_incidence>\n`;
    if (d.aircraftType !== 'multirotor') {
      x += `${ind(2)}<htailarea unit="${uFt2}"> ${d.htailarea} </htailarea>\n`;
      x += `${ind(2)}<htailarm unit="${uFt}"> ${d.htailarm} </htailarm>\n`;
      x += `${ind(2)}<vtailarea unit="${uFt2}"> ${d.vtailarea} </vtailarea>\n`;
      x += `${ind(2)}<vtailarm unit="${uFt}"> ${d.vtailarm} </vtailarm>\n`;
    }
    x += loc('AERORP', d.aerorp) + loc('EYEPOINT', d.eyepoint) + loc('VRP', d.vrp);
    x += `${ind(1)}</metrics>\n`;

    // Mass balance
    x += `${ind(1)}<mass_balance>\n`;
    x += `${ind(2)}<ixx unit="${uIn}"> ${d.ixx} </ixx>\n`;
    x += `${ind(2)}<iyy unit="${uIn}"> ${d.iyy} </iyy>\n`;
    x += `${ind(2)}<izz unit="${uIn}"> ${d.izz} </izz>\n`;
    x += `${ind(2)}<ixz unit="${uIn}"> ${d.ixz} </ixz>\n`;
    x += `${ind(2)}<emptywt unit="${uWt}"> ${d.emptywt} </emptywt>\n`;
    x += loc('CG', d.cg);
    for (const pm of d.pointmasses || []) {
      x += `${ind(2)}<pointmass name="${pm.name}">\n${ind(3)}<weight unit="${uWt}"> ${pm.weight} </weight>\n`;
      x += `${ind(3)}<location unit="${uLen}">\n${ind(4)}<x> ${pm.x} </x>\n${ind(4)}<y> ${pm.y} </y>\n${ind(4)}<z> ${pm.z} </z>\n${ind(3)}</location>\n`;
      x += `${ind(2)}</pointmass>\n`;
    }
    x += `${ind(1)}</mass_balance>\n`;

    // Ground reactions
    x += `${ind(1)}<ground_reactions>\n`;
    for (const c of d.contacts || []) {
      x += `${ind(2)}<contact name="${c.name}" type="${c.type}">\n`;
      x += `${ind(3)}<location unit="${uLen}">\n${ind(4)}<x> ${c.x} </x>\n${ind(4)}<y> ${c.y} </y>\n${ind(4)}<z> ${c.z} </z>\n${ind(3)}</location>\n`;
      x += `${ind(3)}<static_friction> ${c.staticFriction} </static_friction>\n`;
      x += `${ind(3)}<dynamic_friction> ${c.dynamicFriction} </dynamic_friction>\n`;
      x += `${ind(3)}<rolling_friction> ${c.rollingFriction} </rolling_friction>\n`;
      x += `${ind(3)}<spring_coeff> ${c.spring} </spring_coeff>\n`;
      x += `${ind(3)}<damping_coeff> ${c.damping} </damping_coeff>\n`;
      if (c.maxSteer) x += `${ind(3)}<max_steer> ${c.maxSteer} </max_steer>\n`;
      x += `${ind(3)}<brake_group> ${c.brakeGroup} </brake_group>\n`;
      x += `${ind(3)}<retractable> ${c.retractable ? 1 : 0} </retractable>\n`;
      x += `${ind(2)}</contact>\n`;
    }
    x += `${ind(1)}</ground_reactions>\n`;

    // Propulsion
    x += `${ind(1)}<propulsion>\n`;
    for (const eng of d.engines || []) {
      x += `${ind(2)}<engine file="${eng.file}" name="${eng.name}">\n`;
      x += `${ind(3)}<location unit="${uLen}">\n${ind(4)}<x> ${eng.x} </x>\n${ind(4)}<y> ${eng.y} </y>\n${ind(4)}<z> ${eng.z} </z>\n${ind(3)}</location>\n`;
      x += `${ind(3)}<orient unit="DEG">\n${ind(4)}<roll> 0 </roll>\n${ind(4)}<pitch> ${eng.pitch} </pitch>\n${ind(4)}<yaw> ${eng.yaw} </yaw>\n${ind(3)}</orient>\n`;
      for (const f of eng.feed || []) x += `${ind(3)}<feed> ${f} </feed>\n`;
      if (eng.thrusterFile) {
        x += `${ind(3)}<thruster file="${eng.thrusterFile}">\n`;
        x += `${ind(4)}<location unit="${uLen}">\n${ind(5)}<x> ${eng.x} </x>\n${ind(5)}<y> ${eng.y} </y>\n${ind(5)}<z> ${eng.z} </z>\n${ind(4)}</location>\n`;
        x += `${ind(4)}<orient unit="DEG">\n${ind(5)}<roll> 0 </roll>\n${ind(5)}<pitch> ${eng.pitch} </pitch>\n${ind(5)}<yaw> ${eng.yaw} </yaw>\n${ind(4)}</orient>\n`;
        x += `${ind(4)}<sense> ${eng.sense} </sense>\n`;
        if (eng.pFactor) x += `${ind(4)}<p_factor> ${eng.pFactor} </p_factor>\n`;
        x += `${ind(3)}</thruster>\n`;
      }
      x += `${ind(2)}</engine>\n`;
    }
    for (const t of d.tanks || []) {
      x += `${ind(2)}<tank type="${t.type}" number="${t.number}">\n`;
      x += `${ind(3)}<location unit="${uLen}">\n${ind(4)}<x> ${t.x} </x>\n${ind(4)}<y> ${t.y} </y>\n${ind(4)}<z> ${t.z} </z>\n${ind(3)}</location>\n`;
      x += `${ind(3)}<radius> ${t.radius} </radius>\n`;
      x += `${ind(3)}<capacity unit="${uWt}"> ${t.capacity} </capacity>\n`;
      x += `${ind(3)}<contents unit="${uWt}"> ${t.contents} </contents>\n`;
      x += `${ind(2)}</tank>\n`;
    }
    x += `${ind(1)}</propulsion>\n`;

    // System references
    if (d.sensors?.imu) x += `${ind(1)}<system file="SensorImu"/>\n`;
    if (d.sensors?.baro) x += `${ind(1)}<system file="SensorBaro"/>\n`;
    if (d.sensors?.gps) x += `${ind(1)}<system file="SensorGps"/>\n`;
    if (d.effectors && d.aircraftType === 'multirotor') x += `${ind(1)}<system file="Effectors"/>\n`;

    // Flight control (placeholder)
    x += `${ind(1)}<flight_control name="Autogenerated">\n`;
    x += `${ind(2)}<channel name="Placeholder">\n`;
    x += `${ind(3)}<!-- Add flight control channels here -->\n`;
    x += `${ind(2)}</channel>\n`;
    x += `${ind(1)}</flight_control>\n`;

    // Aerodynamics (placeholder)
    x += `${ind(1)}<aerodynamics>\n`;
    const axes = d.aircraftType === 'helicopter' ? ['LIFT','DRAG','SIDE','PITCH','YAW'] : ['LIFT','DRAG','SIDE','ROLL','PITCH','YAW'];
    for (const axis of axes) {
      x += `${ind(2)}<axis name="${axis}">\n`;
      x += `${ind(3)}<!-- Add ${axis.toLowerCase()} coefficients here -->\n`;
      x += `${ind(2)}</axis>\n`;
    }
    x += `${ind(1)}</aerodynamics>\n`;

    // Output
    if (d.outputName) {
      x += `${ind(1)}<output name="${d.outputName}" type="${d.outputType}" rate="${d.outputRate}">\n`;
      x += `${ind(2)}<simulation> OFF </simulation>\n`;
      x += `${ind(2)}<atmosphere> ON </atmosphere>\n`;
      x += `${ind(2)}<massprops> ON </massprops>\n`;
      x += `${ind(2)}<rates> ON </rates>\n`;
      x += `${ind(2)}<velocities> ON </velocities>\n`;
      x += `${ind(2)}<forces> ON </forces>\n`;
      x += `${ind(2)}<moments> ON </moments>\n`;
      x += `${ind(2)}<position> ON </position>\n`;
      x += `${ind(2)}<propulsion> ON </propulsion>\n`;
      x += `${ind(2)}<aerosurfaces> ON </aerosurfaces>\n`;
      x += `${ind(2)}<fcs> ON </fcs>\n`;
      x += `${ind(2)}<ground_reactions> ON </ground_reactions>\n`;
      x += `${ind(1)}</output>\n`;
    }

    x += `</fdm_config>\n`;

    res.json({ xml: x });
  } catch (e) {
    console.error('[generate-aircraft] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── List Built-in Aircraft Library ─────────────────────────────────────────

app.get('/api/aircraft-library', (req, res) => {
  try {
    const aircraftDir = path.join(JSBSIM_ROOT, 'aircraft');
    const dirs = fs.readdirSync(aircraftDir, { withFileTypes: true }).filter(d => d.isDirectory());
    const library = [];

    for (const dir of dirs) {
      const dirPath = path.join(aircraftDir, dir.name);
      const xmlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.xml'));

      // Find main aircraft file (contains <fdm_config>)
      let mainFile = null;
      for (const f of xmlFiles) {
        const content = fs.readFileSync(path.join(dirPath, f), 'utf8');
        if (content.includes('<fdm_config')) {
          mainFile = f;
          break;
        }
      }
      if (!mainFile) continue;

      const filePath = path.join(dirPath, mainFile);
      const content = fs.readFileSync(filePath, 'utf8');
      const stat = fs.statSync(filePath);

      // Extract metadata from XML
      const nameMatch = content.match(/name="([^"]+)"/);
      const versionMatch = content.match(/version="([^"]+)"/);
      const releaseMatch = content.match(/release="([^"]+)"/);
      const descMatch = content.match(/<description>([^<]+)<\/description>/);
      const authorMatch = content.match(/<author>([^<]+)<\/author>/);

      // Detect aircraft type
      let type = 'fixed_wing';
      if (content.includes('<rotor') || content.includes('rotor')) type = 'helicopter';
      if (dir.name === 'F450' || content.includes('brushless_dc_motor')) type = 'multirotor';
      if (content.includes('<rocket_engine')) type = 'rocket';

      // Count sub-files
      const subFiles = xmlFiles.filter(f => f !== mainFile);

      library.push({
        id: dir.name,
        name: nameMatch?.[1] || dir.name,
        directory: dir.name,
        mainFile,
        filePath: path.relative(JSBSIM_ROOT, filePath),
        version: versionMatch?.[1] || '',
        release: releaseMatch?.[1] || '',
        description: descMatch?.[1] || '',
        author: authorMatch?.[1] || '',
        type,
        size: stat.size,
        subFileCount: subFiles.length,
        subFiles: subFiles.slice(0, 10),
      });
    }

    // Sort by name
    library.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ library });
  } catch (e) {
    console.error('[aircraft-library] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Load Aircraft from Library ─────────────────────────────────────────────

app.post('/api/load-aircraft', (req, res) => {
  try {
    const { aircraftId } = req.body;
    if (!aircraftId) return res.status(400).json({ error: 'aircraftId required' });

    const aircraftDir = path.join(JSBSIM_ROOT, 'aircraft', aircraftId);
    if (!fs.existsSync(aircraftDir)) return res.status(404).json({ error: 'Aircraft not found' });

    // Find main XML file
    const xmlFiles = fs.readdirSync(aircraftDir).filter(f => f.endsWith('.xml'));
    let mainFile = null;
    for (const f of xmlFiles) {
      const content = fs.readFileSync(path.join(aircraftDir, f), 'utf8');
      if (content.includes('<fdm_config')) {
        mainFile = f;
        break;
      }
    }
    if (!mainFile) return res.status(404).json({ error: 'No valid aircraft XML found' });

    const mainXml = fs.readFileSync(path.join(aircraftDir, mainFile), 'utf8');

    // Collect all sub-files for reference resolution
    const refFiles = [];
    const allDirs = [aircraftDir];
    // Also check subdirectories
    const subDirs = fs.readdirSync(aircraftDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const sd of subDirs) {
      allDirs.push(path.join(aircraftDir, sd.name));
    }
    for (const dir of allDirs) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.xml') && f !== mainFile);
      for (const f of files) {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        refFiles.push({ name: f, content });
      }
    }

    // Parse using existing parser with full file map (includes JSBSim engine/system dirs)
    const fileMap = buildFileMap(refFiles);
    const result = parseXml(mainXml, fileMap);
    // Don't include raw subFile contents in response (too large)
    res.json(result);
  } catch (err) {
    console.error('[load-aircraft] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── JSBSim Simulation Control ───────────────────────────────────────────────

// Start simulation with a script, model, or both
app.post('/api/sim/start', (req, res) => {
  if (EXTERNAL_SIM) {
    return res.status(409).json({
      error: '外部仿真模式：请启动 px4-jsbsim-bridge/jsbsim_server',
      external: true,
    });
  }
  try {
    const { script, model } = req.body;
    let result;
    if (script) {
      result = jsbsimProcess.startScript(script);
    } else if (model) {
      result = jsbsimProcess.startModel(model);
    } else {
      return res.status(400).json({ error: 'Either script or model must be provided' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop simulation
app.post('/api/sim/stop', (req, res) => {
  if (EXTERNAL_SIM) {
    return res.status(409).json({ error: '外部仿真模式不支持本地停止', external: true });
  }
  try {
    res.json(jsbsimProcess.stop());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pause simulation
app.post('/api/sim/pause', (req, res) => {
  if (EXTERNAL_SIM) {
    return res.status(409).json({ error: '外部仿真模式不支持本地暂停', external: true });
  }
  try {
    res.json(jsbsimProcess.pause());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resume simulation
app.post('/api/sim/resume', (req, res) => {
  if (EXTERNAL_SIM) {
    return res.status(409).json({ error: '外部仿真模式不支持本地继续', external: true });
  }
  try {
    res.json(jsbsimProcess.resume());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restart the last simulation
app.post('/api/sim/restart', (req, res) => {
  if (EXTERNAL_SIM) {
    return res.status(409).json({ error: '外部仿真模式不支持本地重启', external: true });
  }
  try {
    res.json(jsbsimProcess.restart());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get simulation status
app.get('/api/sim/status', (req, res) => {
  if (EXTERNAL_SIM) {
    return res.json({
      external: true,
      running: simClient.state.connected,
      paused: false,
      connected: simClient.state.connected,
    });
  }
  res.json(jsbsimProcess.getStatus());
});

// List available test scripts
app.get('/api/sim/tests', (req, res) => {
  try {
    res.json({ tests: jsbsimProcess.listTests() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List available aircraft models
app.get('/api/sim/models', (req, res) => {
  try {
    res.json({ models: jsbsimProcess.listModels() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/client/index.html'));
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => console.log(`JSBSim Visual Editor server on port ${PORT}`));

// ── 实时仿真 WebSocket (/ws/sim) ─────────────────────────────────────────
// 把 simClient 收到的 UDP 遥测广播给浏览器，并把浏览器控制指令转发给仿真机。
const wss = new WebSocket.Server({ server, path: '/ws/sim' });

function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(s);
  });
}

wss.on('connection', (ws) => {
  // 连上时立即推当前状态与最新帧
  ws.send(JSON.stringify({ type: 'status', connected: simClient.state.connected }));
  if (simClient.state.latest) {
    ws.send(JSON.stringify({ type: 'telemetry', data: simClient.state.latest }));
  }
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'control') {
        simClient.sendControl(!!m.override, Array.isArray(m.channels) ? m.channels : []);
      }
    } catch (e) {
      // 忽略非法消息
    }
  });
});

// 遥测广播 ~30Hz（仅在连线时）
setInterval(() => {
  if (simClient.state.connected && simClient.state.latest) {
    broadcast({ type: 'telemetry', data: simClient.state.latest });
  }
}, 33);

// 连接状态变化立即广播
let _lastStatus = null;
setInterval(() => {
  const st = simClient.state.connected;
  if (st !== _lastStatus) {
    _lastStatus = st;
    broadcast({ type: 'status', connected: st });
  }
}, 250);

console.log('[sim] /ws/sim 实时仿真通道已启用');

// Forward JSBSim process telemetry to WebSocket clients
jsbsimProcess.setTelemetryCallback((telemetry) => {
  broadcast({ type: 'telemetry', data: telemetry });
});

jsbsimProcess.setStatusCallback((status) => {
  broadcast({ type: 'sim-process-status', ...status });
});
