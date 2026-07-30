const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { generateXml, generateSubFileXml } = require('./xmlGenerator');
const { parseXml, parseSubFileXml } = require('./xmlParser');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files in production
app.use(express.static(path.join(__dirname, '../dist/client')));

// ── JSBSim file search paths ──────────────────────────────────────────────
const JSBSIM_ROOT = path.resolve(__dirname, '../../jsbsim');
const JSBSIM_SEARCH_DIRS = [
  path.join(JSBSIM_ROOT, 'systems'),
  path.join(JSBSIM_ROOT, 'engine'),
  path.join(JSBSIM_ROOT, 'aircraft'),
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

// POST /api/load - Load JSON project from file
app.post('/api/load', (req, res) => {
  try {
    const fs = require('fs');
    const filePath = path.join(__dirname, '../projects', req.body.filename || 'project.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/client/index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`JSBSim Visual Editor server on port ${PORT}`));
