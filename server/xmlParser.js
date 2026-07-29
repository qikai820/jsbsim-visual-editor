/**
 * xmlParser.js
 * Parses a JSBSim XML string into a JSON graph (nodes + edges) format.
 */

const { XMLParser } = require('fast-xml-parser');

// ── Layout helpers ──────────────────────────────────────────────────────────

let _col = 0;
let _row = 0;
let _nodeCounter = 0;
const COL_WIDTH = 300;
const ROW_HEIGHT = 200;

function resetLayout() {
  _col = 0;
  _row = 0;
  _nodeCounter = 0;
}

function nextPosition() {
  const pos = { x: 100 + _col * COL_WIDTH, y: 100 + _row * ROW_HEIGHT };
  _col++;
  if (_col > 4) {
    _col = 0;
    _row++;
  }
  return pos;
}

function nextId() {
  _nodeCounter++;
  return `node-${_nodeCounter}`;
}

// ── Value extraction helpers ────────────────────────────────────────────────

function ensureArray(val) {
  if (val === undefined || val === null) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

function extractValueWithUnit(obj) {
  if (obj === undefined || obj === null) return undefined;
  if (typeof obj === 'object' && !Array.isArray(obj)) {
    const val = obj['@_value'] !== undefined ? Number(obj['@_value']) :
                obj['#text'] !== undefined ? Number(obj['#text']) :
                typeof obj === 'number' ? obj : undefined;
    const unit = obj['@_unit'] || undefined;
    if (val !== undefined) return { value: val, unit };
    return undefined;
  }
  if (typeof obj === 'number') return { value: obj };
  if (typeof obj === 'string') return { value: Number(obj) };
  return undefined;
}

function extractLocation(obj) {
  if (!obj) return undefined;
  const x = obj['@_x'] !== undefined ? Number(obj['@_x']) : undefined;
  const y = obj['@_y'] !== undefined ? Number(obj['@_y']) : undefined;
  const z = obj['@_z'] !== undefined ? Number(obj['@_z']) : undefined;
  const unit = obj['@_unit'] || 'IN';
  if (x !== undefined || y !== undefined || z !== undefined) {
    return { x, y, z, unit };
  }
  return undefined;
}

function extractText(obj) {
  if (obj === undefined || obj === null) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'object') {
    if (obj['#text'] !== undefined) return String(obj['#text']);
    return '';
  }
  return String(obj);
}

// ── Section parsers ─────────────────────────────────────────────────────────

function parseFileHeader(fdmConfig, aircraft) {
  const fh = fdmConfig['fileheader'];
  if (!fh) return;
  if (fh['name']) aircraft.name = extractText(fh['name']);
  if (fh['version']) aircraft.version = extractText(fh['version']);
  if (fh['description']) {
    const desc = extractText(fh['description']);
    const match = desc.match(/-\s*(.+)$/);
    if (match) aircraft.release = match[1].trim();
  }
}

function parseMetrics(fdmConfig, nodes, edges) {
  const metrics = fdmConfig['metrics'];
  if (!metrics) return;

  const params = {};

  if (metrics['wingarea']) params.wingarea = extractValueWithUnit(metrics['wingarea']);
  if (metrics['wingspan']) params.wingspan = extractValueWithUnit(metrics['wingspan']);
  if (metrics['chord']) params.chord = extractValueWithUnit(metrics['chord']);
  if (metrics['htailarea']) params.htailarea = extractValueWithUnit(metrics['htailarea']);
  if (metrics['htailarm']) params.htailarm = extractValueWithUnit(metrics['htailarm']);
  if (metrics['vtailarea']) params.vtailarea = extractValueWithUnit(metrics['vtailarea']);
  if (metrics['vtailarm']) params.vtailarm = extractValueWithUnit(metrics['vtailarm']);
  if (metrics['location']) params.location = extractLocation(metrics['location']);

  // Only create a wing node if there's meaningful data
  if (Object.keys(params).length > 0) {
    const id = nextId();
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: 'Wing', componentType: 'wing', params },
      position: nextPosition(),
    });
  }

  // Check for separate htail/vtail location entries
  const wingareaEntries = ensureArray(metrics['wingarea']);
  // If there are multiple wingarea entries, treat extras as separate wing nodes
  for (let i = 1; i < wingareaEntries.length; i++) {
    const entry = wingareaEntries[i];
    const id = nextId();
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: `Wing ${i + 1}`, componentType: 'wing', params: { wingarea: extractValueWithUnit(entry) } },
      position: nextPosition(),
    });
  }
}

function parseMassBalance(fdmConfig, nodes, edges) {
  const mb = fdmConfig['mass_balance'];
  if (!mb) return;

  // Extract emptywt
  if (mb['emptywt']) {
    const fuselageParams = { emptywt: extractValueWithUnit(mb['emptywt']) };

    // Look for pointmass with cg location (the fuselage CG)
    const pointMasses = ensureArray(mb['pointmass']);
    let cgFound = false;
    for (const pm of pointMasses) {
      if (pm['location'] && !pm['weight'] && !pm['@_name']) {
        fuselageParams.cg = extractLocation(pm['location']);
        cgFound = true;
        break;
      }
    }

    if (Object.keys(fuselageParams).length > 0) {
      const id = nextId();
      nodes.push({
        id,
        type: 'aircraftComponent',
        data: { label: 'Fuselage', componentType: 'fuselage', params: fuselageParams },
        position: nextPosition(),
      });
    }
  }

  // Extract inertia values
  const inertiaParams = {};
  if (mb['ixx']) inertiaParams.ixx = extractValueWithUnit(mb['ixx']);
  if (mb['iyy']) inertiaParams.iyy = extractValueWithUnit(mb['iyy']);
  if (mb['izz']) inertiaParams.izz = extractValueWithUnit(mb['izz']);
  if (mb['ixy']) inertiaParams.ixy = extractValueWithUnit(mb['ixy']);
  if (mb['ixz']) inertiaParams.ixz = extractValueWithUnit(mb['ixz']);
  if (mb['iyz']) inertiaParams.iyz = extractValueWithUnit(mb['iyz']);

  if (Object.keys(inertiaParams).length > 0) {
    const id = nextId();
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: 'Inertia', componentType: 'inertia', params: inertiaParams },
      position: nextPosition(),
    });
  }

  // Extract named point masses
  const pointMasses = ensureArray(mb['pointmass']);
  for (const pm of pointMasses) {
    const name = pm['@_name'] || '';
    // Skip the CG pointmass (no name, no weight)
    if (!name && !pm['weight']) continue;

    const pmParams = {};
    if (name) pmParams.name = name;
    if (pm['weight']) pmParams.weight = extractValueWithUnit(pm['weight']);
    if (pm['location']) pmParams.location = extractLocation(pm['location']);

    if (Object.keys(pmParams).length > 0) {
      const id = nextId();
      nodes.push({
        id,
        type: 'aircraftComponent',
        data: { label: pmParams.name || 'Point Mass', componentType: 'point_mass', params: pmParams },
        position: nextPosition(),
      });
    }
  }
}

function parseGroundReactions(fdmConfig, nodes, edges) {
  const gr = fdmConfig['ground_reactions'];
  if (!gr) return;

  const contacts = ensureArray(gr['contact']);
  for (const contact of contacts) {
    const params = {};
    const name = contact['@_name'] || '';
    const type = contact['@_type'] || 'BOGEY';

    if (name) params.name = name;
    params.type = type;
    if (contact['location']) params.location = extractLocation(contact['location']);
    if (contact['static_friction'] !== undefined) {
      params.static_friction = Number(extractText(contact['static_friction']));
    }
    if (contact['dynamic_friction'] !== undefined) {
      params.dynamic_friction = Number(extractText(contact['dynamic_friction']));
    }
    if (contact['spring_coeff']) params.spring_coeff = extractValueWithUnit(contact['spring_coeff']);
    if (contact['damping_coeff']) params.damping_coeff = extractValueWithUnit(contact['damping_coeff']);
    if (contact['max_steer']) params.max_steer = extractValueWithUnit(contact['max_steer']);
    if (contact['brake_group']) params.brake_group = extractText(contact['brake_group']);
    if (contact['retractable'] !== undefined) {
      params.retractable = Number(extractText(contact['retractable']));
    }

    const id = nextId();
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: params.name || 'Landing Gear', componentType: 'landing_gear', params },
      position: nextPosition(),
    });
  }
}

function parsePropulsion(fdmConfig, nodes, edges) {
  const prop = fdmConfig['propulsion'];
  if (!prop) return;

  const engineIds = [];
  const propellerIds = [];
  const tankIds = [];

  // Engines
  const engines = ensureArray(prop['engine']);
  for (const eng of engines) {
    const params = {};
    const name = eng['@_name'] || '';
    if (name) params.name = name;
    if (eng['feed']) params.file = extractText(eng['feed']);
    if (eng['thruster']) {
      const thruster = eng['thruster'];
      if (typeof thruster === 'object' && thruster['#text']) {
        params.thruster_file = extractText(thruster);
      } else if (typeof thruster === 'string') {
        params.thruster_file = thruster;
      }
    }
    if (eng['location']) params.location = extractLocation(eng['location']);
    if (eng['orient']) {
      const orient = eng['orient'];
      params.orient = {
        roll: orient['@_roll'] !== undefined ? Number(orient['@_roll']) : undefined,
        pitch: orient['@_pitch'] !== undefined ? Number(orient['@_pitch']) : undefined,
        yaw: orient['@_yaw'] !== undefined ? Number(orient['@_yaw']) : undefined,
      };
    }

    const id = nextId();
    engineIds.push(id);
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: params.name || 'Engine', componentType: 'engine', params },
      position: nextPosition(),
    });
  }

  // Propellers / Thrusters
  const thrusters = ensureArray(prop['thruster']);
  for (const thr of thrusters) {
    const params = {};
    const file = thr['@_file'] || '';
    if (file) params.file = file;
    if (thr['location']) params.location = extractLocation(thr['location']);
    if (thr['sense'] !== undefined) params.sense = Number(extractText(thr['sense']));
    if (thr['p_factor'] !== undefined) params.p_factor = Number(extractText(thr['p_factor']));

    const id = nextId();
    propellerIds.push(id);
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: file || 'Propeller', componentType: 'propeller', params },
      position: nextPosition(),
    });
  }

  // Fuel tanks
  const tanks = ensureArray(prop['tank']);
  for (const tank of tanks) {
    const params = {};
    const name = tank['@_name'] || '';
    if (name) params.name = name;
    if (tank['location']) params.location = extractLocation(tank['location']);
    if (tank['capacity']) params.capacity = extractValueWithUnit(tank['capacity']);
    if (tank['contents']) params.contents = extractValueWithUnit(tank['contents']);

    const id = nextId();
    tankIds.push(id);
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: params.name || 'Fuel Tank', componentType: 'fuel_tank', params },
      position: nextPosition(),
    });
  }

  // Create edges: engine → propeller (if counts match, pair them up)
  for (let i = 0; i < Math.min(engineIds.length, propellerIds.length); i++) {
    edges.push({
      id: `e${edges.length + 1}`,
      source: propellerIds[i],
      target: engineIds[i],
      sourceHandle: 'propulsion',
      targetHandle: 'propulsion',
    });
  }
}

function parseSystemReferences(fdmConfig, nodes, edges) {
  // Parse <system file="xxx"> elements from fdm_config
  const systemElements = ensureArray(fdmConfig['system']);
  for (const sys of systemElements) {
    const file = sys['@_file'] || '';
    const params = {};
    if (file) params.file = file;

    // Extract properties
    const properties = ensureArray(sys['property']);
    if (properties.length > 0) {
      const propNames = properties.map(p => extractText(p)).filter(Boolean);
      if (propNames.length > 0) {
        params.properties = propNames.join(',');
      }
    }

    const id = nextId();
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: file || 'System', componentType: 'system', params },
      position: nextPosition(),
    });
  }
}

function parseAerodynamics(fdmConfig, nodes, edges) {
  const aero = fdmConfig['aerodynamics'];
  if (!aero) return;

  const { xmlToExpr } = require('./expressionXml');
  const coefficients = [];
  const axes = ensureArray(aero['axis']);

  for (const axis of axes) {
    if (!axis) continue;
    const axisName = (axis['@_name'] || 'LIFT').toUpperCase();
    const functions = ensureArray(axis['function']);

    for (const func of functions) {
      if (!func) continue;
      const name = func['@_name'] || '';
      const description = func['description'] ? extractText(func['description']) : '';

      // Parse the function body into an expression tree
      const expression = xmlToExpr(func);

      if (name || expression.kind !== 'value' || expression.value !== 0) {
        coefficients.push({
          name,
          description,
          axis: axisName,
          expression,
        });
      }
    }
  }

  if (coefficients.length > 0) {
    const id = nextId();
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: {
        label: 'Aero Coefficients',
        componentType: 'aero_coefficients',
        params: { coefficients: JSON.stringify(coefficients) },
      },
      position: nextPosition(),
    });
  }
}

function parseOutput(fdmConfig, nodes, edges) {
  const outputs = ensureArray(fdmConfig['output']);
  for (const out of outputs) {
    if (!out) continue;
    const params = {};
    params.name = out['@_name'] || 'localhost';
    params.type = out['@_type'] || 'SOCKET';
    if (out['@_port'] !== undefined) params.port = Number(out['@_port']);
    if (out['@_rate'] !== undefined) params.rate = Number(out['@_rate']);

    const dataGroups = ['simulation', 'atmosphere', 'massprops', 'rates', 'velocities',
      'forces', 'moments', 'position', 'propulsion', 'aerosurfaces', 'fcs',
      'ground_reactions', 'coefficients'];
    for (const group of dataGroups) {
      if (out[group] !== undefined) {
        params[group] = extractText(out[group]).trim() || 'OFF';
      }
    }

    const properties = ensureArray(out['property']);
    if (properties.length > 0) {
      params.properties = properties.map(p => extractText(p).trim()).filter(Boolean).join(',');
    }

    const id = nextId();
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: `Output: ${params.name}`, componentType: 'output', params },
      position: nextPosition(),
    });
  }
}

function createLogicalEdges(nodes, edges) {
  // Group nodes by type for edge creation
  const byType = {};
  for (const node of nodes) {
    const t = (node.data && node.data.componentType) || node.type;
    if (!byType[t]) byType[t] = [];
    byType[t].push(node);
  }

  // Wing → Fuselage (metrics connect to mass)
  const fuselageNodes = byType['fuselage'] || [];
  const wingNodes = byType['wing'] || [];
  const htailNodes = byType['htail'] || [];
  const vtailNodes = byType['vtail'] || [];
  const gearNodes = byType['landing_gear'] || [];
  const inertiaNodes = byType['inertia'] || [];
  const fuelTankNodes = byType['fuel_tank'] || [];

  // Existing edge source/target set to avoid duplicates
  const edgeSet = new Set(edges.map(e => `${e.source}->${e.target}`));

  function addEdge(source, target, sourceHandle, targetHandle) {
    const key = `${source}->${target}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({
        id: `e${edges.length + 1}`,
        source,
        target,
        sourceHandle: sourceHandle || 'default',
        targetHandle: targetHandle || 'default',
      });
    }
  }

  // Connect wings, htail, vtail to fuselage
  if (fuselageNodes.length > 0) {
    const fusId = fuselageNodes[0].id;
    for (const w of wingNodes) addEdge(w.id, fusId, 'metrics', 'metrics');
    for (const h of htailNodes) addEdge(h.id, fusId, 'metrics', 'metrics');
    for (const v of vtailNodes) addEdge(v.id, fusId, 'metrics', 'metrics');
  }

  // Connect inertia to fuselage
  if (fuselageNodes.length > 0) {
    const fusId = fuselageNodes[0].id;
    for (const iner of inertiaNodes) addEdge(iner.id, fusId, 'mass', 'mass');
  }

  // Connect fuel tanks to first engine (if exists)
  const engineNodes = byType['engine'] || [];
  if (engineNodes.length > 0) {
    const engId = engineNodes[0].id;
    for (const tank of fuelTankNodes) addEdge(tank.id, engId, 'fuel', 'propulsion');
  }

  // Connect landing gear to fuselage
  if (fuselageNodes.length > 0) {
    const fusId = fuselageNodes[0].id;
    for (const gear of gearNodes) addEdge(gear.id, fusId, 'gear', 'structure');
  }
}

// ── Main parser ─────────────────────────────────────────────────────────────

function parseXml(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') {
    throw new Error('Invalid XML input');
  }

  resetLayout();

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseAttributeValue: false,
    parseTagValue: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlString);

  // Find the root fdm_config element
  const fdmConfig = parsed['fdm_config'] || parsed['fdm_configuration'] || null;
  if (!fdmConfig) {
    throw new Error('No fdm_config element found in XML');
  }

  // Extract aircraft metadata
  const aircraft = {
    name: fdmConfig['@_name'] || 'Unnamed Aircraft',
    version: fdmConfig['@_version'] || '1.0',
    release: fdmConfig['@_release'] || '',
  };

  const nodes = [];
  const edges = [];

  // Parse each section
  parseFileHeader(fdmConfig, aircraft);
  parseMetrics(fdmConfig, nodes, edges);
  parseMassBalance(fdmConfig, nodes, edges);
  parseGroundReactions(fdmConfig, nodes, edges);
  parsePropulsion(fdmConfig, nodes, edges);
  parseSystemReferences(fdmConfig, nodes, edges);
  parseAerodynamics(fdmConfig, nodes, edges);
  parseOutput(fdmConfig, nodes, edges);

  // Create logical edges between related nodes
  createLogicalEdges(nodes, edges);

  return { aircraft, nodes, edges };
}

function parseSubFileXml(xmlString, fileType) {
  if (!xmlString || typeof xmlString !== 'string') {
    throw new Error('Invalid XML input');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseAttributeValue: false,
    parseTagValue: true,
    trimValues: true,
  });

  const parsed = parser.parse(xmlString);

  if (fileType === 'piston_engine' || (!fileType && parsed['piston_engine'])) {
    const root = parsed['piston_engine'];
    if (!root) throw new Error('No piston_engine element found');
    const result = { type: 'piston_engine', name: root['@_name'] || '', params: {} };
    if (root['maxhp'] !== undefined) result.params.maxhp = extractValueWithUnit(root['maxhp']);
    if (root['displacement'] !== undefined) result.params.displacement = extractValueWithUnit(root['displacement']);
    if (root['cycles'] !== undefined) result.params.cycles = Number(extractText(root['cycles']));
    if (root['bsfc'] !== undefined) result.params.bsfc = extractValueWithUnit(root['bsfc']);
    if (root['idlerpm'] !== undefined) result.params.idlerpm = Number(extractText(root['idlerpm']));
    if (root['maxrpm'] !== undefined) result.params.maxrpm = Number(extractText(root['maxrpm']));
    if (root['minmp'] !== undefined) result.params.minmp = extractValueWithUnit(root['minmp']);
    if (root['maxmp'] !== undefined) result.params.maxmp = extractValueWithUnit(root['maxmp']);
    return result;
  }

  if (fileType === 'turbine_engine' || (!fileType && parsed['turbine_engine'])) {
    const root = parsed['turbine_engine'];
    if (!root) throw new Error('No turbine_engine element found');
    const result = { type: 'turbine_engine', name: root['@_name'] || '', params: {} };
    if (root['maxthrust'] !== undefined) result.params.maxthrust = extractValueWithUnit(root['maxthrust']);
    if (root['idlen1'] !== undefined) result.params.idlen1 = Number(extractText(root['idlen1']));
    if (root['maxn1'] !== undefined) result.params.maxn1 = Number(extractText(root['maxn1']));
    if (root['idlen2'] !== undefined) result.params.idlen2 = Number(extractText(root['idlen2']));
    if (root['maxn2'] !== undefined) result.params.maxn2 = Number(extractText(root['maxn2']));
    return result;
  }

  if (fileType === 'thruster_propeller' || (!fileType && parsed['propeller'])) {
    const root = parsed['propeller'];
    if (!root) throw new Error('No propeller element found');
    const result = { type: 'thruster_propeller', name: root['@_name'] || '', params: {} };
    if (root['diameter'] !== undefined) result.params.diameter = extractValueWithUnit(root['diameter']);
    if (root['numblades'] !== undefined) result.params.numblades = Number(extractText(root['numblades']));
    if (root['gearratio'] !== undefined) result.params.gearratio = Number(extractText(root['gearratio']));
    return result;
  }

  if (fileType === 'thruster_direct' || (!fileType && parsed['direct'])) {
    const root = parsed['direct'];
    if (!root) throw new Error('No direct element found');
    return { type: 'thruster_direct', name: root['@_name'] || '', params: {} };
  }

  if (fileType === 'system' || (!fileType && parsed['system'])) {
    const root = parsed['system'];
    if (!root) throw new Error('No system element found');
    const result = { type: 'system', name: root['@_name'] || '', params: {} };
    const properties = ensureArray(root['property']);
    if (properties.length > 0) {
      const propNames = properties.map(p => extractText(p)).filter(Boolean);
      if (propNames.length > 0) {
        result.params.properties = propNames.join(',');
      }
    }
    return result;
  }

  throw new Error('Unknown or unsupported sub-file type');
}

module.exports = { parseXml, parseSubFileXml };
