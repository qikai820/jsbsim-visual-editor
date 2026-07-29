const express = require('express');
const cors = require('cors');
const path = require('path');
const { generateXml, generateSubFileXml } = require('./xmlGenerator');
const { parseXml, parseSubFileXml } = require('./xmlParser');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files in production
app.use(express.static(path.join(__dirname, '../dist/client')));

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
// Body: { xml: "..." }
// Response: { aircraft, nodes, edges }
app.post('/api/parse-xml', (req, res) => {
  try {
    const result = parseXml(req.body.xml);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
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

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/client/index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`JSBSim Visual Editor server on port ${PORT}`));
