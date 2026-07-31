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
  // Attribute format: <location x="1" y="2" z="3" unit="IN"/>
  const x = obj['@_x'] !== undefined ? Number(obj['@_x']) : undefined;
  const y = obj['@_y'] !== undefined ? Number(obj['@_y']) : undefined;
  const z = obj['@_z'] !== undefined ? Number(obj['@_z']) : undefined;
  const unit = obj['@_unit'] || 'IN';
  // Child element format: <location unit="IN"><x>1</x><y>2</y><z>3</z></location>
  const cx = obj['x'] !== undefined ? Number(extractText(obj['x'])) : undefined;
  const cy = obj['y'] !== undefined ? Number(extractText(obj['y'])) : undefined;
  const cz = obj['z'] !== undefined ? Number(extractText(obj['z'])) : undefined;
  const fx = x !== undefined ? x : cx;
  const fy = y !== undefined ? y : cy;
  const fz = z !== undefined ? z : cz;
  if (fx !== undefined || fy !== undefined || fz !== undefined) {
    return { x: fx, y: fy, z: fz, unit };
  }
  return undefined;
}

function extractOrient(obj) {
  if (!obj) return undefined;
  const r = obj['@_roll'] !== undefined ? Number(obj['@_roll']) :
            obj['roll'] !== undefined ? Number(extractText(obj['roll'])) : undefined;
  const p = obj['@_pitch'] !== undefined ? Number(obj['@_pitch']) :
            obj['pitch'] !== undefined ? Number(extractText(obj['pitch'])) : undefined;
  const y = obj['@_yaw'] !== undefined ? Number(obj['@_yaw']) :
            obj['yaw'] !== undefined ? Number(extractText(obj['yaw'])) : undefined;
  if (r !== undefined || p !== undefined || y !== undefined) {
    return { roll: r, pitch: p, yaw: y };
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

// ── Table data extraction (shared by all parsers) ──────────────────────────

function parseTableData(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  return lines.map(line => {
    const vals = line.split(/[\s,]+/).map(Number).filter(v => !isNaN(v));
    return vals;
  });
}

// Extract tables from an XML element and add to params._tables
function extractTables(el, params) {
  if (!el || typeof el !== 'object') return params;
  for (const [key, val] of Object.entries(el)) {
    if (key === 'table') {
      const tables = ensureArray(val);
      for (const tbl of tables) {
        if (!tbl) continue;
        const tblName = tbl['@_name'] || '';
        const tblType = tbl['@_type'] || 'internal';
        const tableData = tbl['tableData'] ? parseTableData(String(tbl['tableData'])) : [];
        if (tblName && tableData.length > 0) {
          if (!params._tables) params._tables = [];
          params._tables.push({ name: tblName, type: tblType, data: tableData });
        }
      }
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      // Recurse into child elements to find nested tables
      extractTables(val, params);
    }
  }
  return params;
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
  // metrics can contain several named <location> (AERORP/EYEPOINT/VRP).
  // The wing reference point is AERORP; fall back to EYEPOINT/VRP/any.
  const metricLocs = ensureArray(metrics['location']);
  const wingLoc =
    metricLocs.find(l => (l['@_name'] || '').toUpperCase() === 'AERORP') ||
    metricLocs.find(l => (l['@_name'] || '').toUpperCase() === 'EYEPOINT') ||
    metricLocs.find(l => (l['@_name'] || '').toUpperCase() === 'VRP') ||
    metricLocs[0];
  if (wingLoc) params.location = extractLocation(wingLoc);

  // Extract any table data from metrics section
  extractTables(metrics, params);

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

    // Also accept a direct <location name="CG"> child of mass_balance
    if (!cgFound) {
      const mbLocs = ensureArray(mb['location']);
      const cgLoc =
        mbLocs.find(l => (l['@_name'] || '').toUpperCase() === 'CG') || mbLocs[0];
      if (cgLoc) fuselageParams.cg = extractLocation(cgLoc);
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

function parsePropulsion(fdmConfig, nodes, edges, fileMap = {}, parser = null) {
  const prop = fdmConfig['propulsion'];
  if (!prop) return;

  const engineIds = [];
  const propellerIds = [];
  const tankIds = [];

  // Helper to extract numeric params from any XML element
  function extractElementParams(el, merged) {
    if (!el || typeof el !== 'object') return merged;
    if (el['@_name']) merged.name = el['@_name'];
    for (const [key, val] of Object.entries(el)) {
      if (key.startsWith('@_') || key === '#text' || key === 'table') continue;
      if (typeof val === 'number') {
        merged[key] = val;
      } else if (typeof val === 'string' && val.trim() && !isNaN(Number(val.trim()))) {
        merged[key] = Number(val.trim());
      } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        const text = val['#text'];
        if (text !== undefined && !isNaN(Number(text))) {
          merged[key] = Number(text);
        }
        if (val['@_unit']) merged[key + '_unit'] = val['@_unit'];
      }
    }
    // Extract tables using shared function
    extractTables(el, merged);
    return merged;
  }

  // Helper to resolve a referenced file and merge its params (generic - handles any root element)
  function resolveFileParams(fileName, fallbackParams = {}) {
    if (!fileName || !fileMap[fileName]) return fallbackParams;
    try {
      const refXml = fileMap[fileName];
      const refParsed = parser ? parser.parse(refXml) : null;
      if (!refParsed) return fallbackParams;

      // Find the root element (skip xml declaration)
      let rootEl = null;
      let rootTag = null;
      for (const [key, val] of Object.entries(refParsed)) {
        if (key === '?xml' || key.startsWith('?')) continue;
        rootEl = val;
        rootTag = key;
        break;
      }
      if (!rootEl) return fallbackParams;

      const merged = { ...fallbackParams };
      merged._root_tag = rootTag;
      extractElementParams(rootEl, merged);

      // Recursively resolve nested file references (e.g. <thruster file="xxx"> inside engine)
      for (const [key, val] of Object.entries(rootEl)) {
        if (key.startsWith('@_') || key === '#text') continue;
        if (typeof val === 'object' && val !== null && !Array.isArray(val) && val['@_file']) {
          const nestedFile = val['@_file'];
          if (fileMap[nestedFile]) {
            const nestedParams = resolveFileParams(nestedFile, {});
            Object.assign(merged, nestedParams);
            merged[key + '_file'] = nestedFile;
          }
          // Also extract inline params from the nested element
          extractElementParams(val, merged);
        }
      }

      return merged;
    } catch (e) {
      console.warn('[parsePropulsion] Failed to resolve file:', fileName, e.message);
      return fallbackParams;
    }
  }

  // Engines
  const engines = ensureArray(prop['engine']);
  for (const eng of engines) {
    // ── Engine node ──
    let engParams = {};
    const inlineName = eng['@_name'] || '';
    if (inlineName) engParams.name = inlineName;
    const engineFile = eng['@_file'] || '';

    // Resolve engine file (only engine-level params)
    if (engineFile) {
      engParams = resolveFileParams(engineFile, engParams);
      engParams._source_file = engineFile;
      engParams.file = engineFile;
    }

    // Map _root_tag to engine_type
    const rootTagToType = {
      piston_engine: 'piston',
      turbine_engine: 'turbine',
      turboprop_engine: 'turboprop',
      rocket_engine: 'rocket',
      electric_engine: 'electric',
      brushless_dc_motor: 'brushless_dc',
      FG_ROCKET: 'rocket',
    };
    if (engParams._root_tag && rootTagToType[engParams._root_tag]) {
      engParams.engine_type = rootTagToType[engParams._root_tag];
    }

    if (eng['feed']) engParams.feed = extractText(eng['feed']);
    if (eng['location']) engParams.location = extractLocation(eng['location']);
    if (eng['orient']) {
      engParams.orient = extractOrient(eng['orient']);
    }
    // Restore inline name
    if (inlineName) engParams.name = inlineName;

    const engId = nextId();
    engineIds.push(engId);
    nodes.push({
      id: engId,
      type: 'aircraftComponent',
      data: {
        label: (() => {
          const typeIcons = {
            piston: '🔧', turbine: '🔥', turboprop: '🔥', rocket: '🚀',
            electric: '⚡', brushless_dc: '⚡',
          };
          const typeLabels = {
            piston: '活塞', turbine: '涡轮', turboprop: '涡桨', rocket: '火箭',
            electric: '电动', brushless_dc: '无刷直流',
          };
          const icon = engParams.engine_type ? (typeIcons[engParams.engine_type] || '⚙️') : '⚙️';
          const typeLabel = engParams.engine_type ? (typeLabels[engParams.engine_type] || '') : '';
          const name = engParams.name || engineFile || 'Engine';
          return typeLabel ? `${icon} ${name} [${typeLabel}]` : `${icon} ${name}`;
        })(),
        componentType: 'engine',
        params: engParams,
      },
      position: nextPosition(),
    });

    // ── Thruster/Propeller node (from nested <thruster> inside <engine>) ──
    if (eng['thruster']) {
      const thruster = eng['thruster'];
      const thrusterFile = thruster['@_file'] || '';
      let thrParams = {};

      if (thrusterFile) {
        thrParams = resolveFileParams(thrusterFile, thrParams);
        thrParams._source_file = thrusterFile;
        thrParams.file = thrusterFile;
      }

      // Extract inline thruster params (location, orient, sense, p_factor)
      if (thruster['location']) thrParams.location = extractLocation(thruster['location']);
      if (thruster['orient']) {
        thrParams.orient = extractOrient(thruster['orient']);
      }
      if (thruster['sense'] !== undefined) thrParams.sense = Number(extractText(thruster['sense']));
      if (thruster['p_factor'] !== undefined) thrParams.p_factor = Number(extractText(thruster['p_factor']));

      // Engine without its own <location> inherits it from the linked thruster
      if (!engParams.location && thrParams.location) engParams.location = thrParams.location;

      // Name: use inline name or file name
      const thrName = thruster['@_name'] || thrusterFile || (inlineName ? inlineName + ' 螺旋桨' : 'Propeller');

      const thrId = nextId();
      propellerIds.push(thrId);
      nodes.push({
        id: thrId,
        type: 'aircraftComponent',
        data: { label: thrParams.name || thrName, componentType: 'propeller', params: thrParams },
        position: nextPosition(),
      });

      // Edge: propeller → engine
      edges.push({
        id: `e${edges.length + 1}`,
        source: thrId,
        target: engId,
        sourceHandle: 'thrust',
        targetHandle: 'propulsion',
      });
    }
  }

  // Propellers / Thrusters
  const thrusters = ensureArray(prop['thruster']);
  for (const thr of thrusters) {
    let params = {};
    const file = thr['@_file'] || '';

    // Resolve thruster file
    if (file) {
      params = resolveFileParams(file, params);
      params._source_file = file;
    }

    if (thr['location']) params.location = extractLocation(thr['location']);
    if (thr['sense'] !== undefined) params.sense = Number(extractText(thr['sense']));
    if (thr['p_factor'] !== undefined) params.p_factor = Number(extractText(thr['p_factor']));

    const id = nextId();
    propellerIds.push(id);
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: params.name || file || 'Propeller', componentType: 'propeller', params },
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

  // Edges between engines and propellers are now created inline during parsing
}

function parseComponentSection(fdmConfig, nodes, edges, sectionKey, componentType, fileMap = {}, parser = null) {
  // Parse <system>/<flight_control> sections. They are structurally identical:
  // a set of <channel> elements containing components such as summer/pure_gain/
  // pid/actuator/function. flight_control was previously never parsed, so its
  // module never appeared in the visual editor.
  const elements = ensureArray(fdmConfig[sectionKey]);
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const file = el['@_file'] || '';
    const params = {};
    if (file) params.file = file;

    // Use el itself as the section definition (works for both inline and resolved content)
    const sysDef = el;

    // Extract system name
    if (sysDef['@_name']) params.name = sysDef['@_name'];

    // Extract channels and their components
    const channels = ensureArray(sysDef['channel']);
    const channelData = [];
    for (const ch of channels) {
      if (!ch) continue;
      const chName = ch['@_name'] || '';
      const chItems = [];

      // Extract functions from channel (with expression trees)
      const funcs = ensureArray(ch['function']);
      for (const f of funcs) {
        if (!f) continue;
        const fName = f['@_name'] || '';
        const item = { type: 'function', name: fName };
        // Parse function body into expression tree
        try {
          const { xmlToExpr } = require('./expressionXml');
          item.expression = xmlToExpr(f);
        } catch (e) {
          item.expression = { kind: 'value', value: 0 };
        }
        chItems.push(item);
      }

      // Extract other channel elements (sensor, kinematic, switch, pid, actuator, etc.)
      for (const [key, val] of Object.entries(ch)) {
        if (key.startsWith('@_') || key === '#text' || key === 'function') continue;
        const items = ensureArray(val);
        for (const item of items) {
          if (!item) continue;
          const itemName = item['@_name'] || '';
          const chItem = { type: key, name: itemName };

          // Extract component-specific properties as an expression tree
          const props = {};
          const knownFields = ['input', 'lag', 'noise', 'drift_rate', 'gain', 'bias',
            'delay', 'output', 'property', 'trigger', 'width', 'center', 'deadband',
            'constant', 'clipto', 'min', 'max', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6',
            'clipto_min', 'clipto_max'];

          for (const field of knownFields) {
            if (item[field] !== undefined) {
              if (typeof item[field] === 'object' && item[field] !== null) {
                // Handle elements with attributes (like noise with distribution)
                const text = item[field]['#text'] !== undefined ? item[field]['#text'] : null;
                const attrs = {};
                for (const [ak, av] of Object.entries(item[field])) {
                  if (ak.startsWith('@_')) attrs[ak.slice(2)] = av;
                }
                props[field] = { value: text !== null ? String(text) : '', attrs };
              } else {
                props[field] = { value: String(item[field]), attrs: {} };
              }
            }
          }

          // Also extract any <property> children
          const propChildren = ensureArray(item['property']);
          if (propChildren.length > 0) {
            props.properties = propChildren.map(p => {
              if (typeof p === 'string') return p;
              return p['@_name'] || extractText(p);
            }).filter(Boolean);
          }

          if (Object.keys(props).length > 0) {
            chItem.componentProps = props;
          }

          // Also try to extract expression from function-like elements
          try {
            const { xmlToExpr } = require('./expressionXml');
            chItem.expression = xmlToExpr(item);
          } catch (e) { /* ignore */ }

          chItems.push(chItem);
        }
      }

      if (chName || chItems.length > 0) {
        channelData.push({ name: chName, items: chItems });
      }
    }

    if (channelData.length > 0) {
      params.channels = JSON.stringify(channelData);
    }

    // Extract top-level functions
    const topFuncs = ensureArray(sysDef['function']);
    if (topFuncs.length > 0 && channelData.length === 0) {
      const items = topFuncs.map(f => {
        const item = { type: 'function', name: f['@_name'] || '' };
        try {
          const { xmlToExpr } = require('./expressionXml');
          item.expression = xmlToExpr(f);
        } catch (e) {
          item.expression = { kind: 'value', value: 0 };
        }
        return item;
      }).filter(i => i.name);
      if (items.length > 0) {
        params.channels = JSON.stringify([{ name: '', items }]);
      }
    }

    // Extract properties
    const sysProps = ensureArray(sysDef['property']);
    if (sysProps.length > 0) {
      const propNames = sysProps.map(p => {
        if (typeof p === 'string') return p;
        return p['@_name'] || extractText(p);
      }).filter(Boolean);
      if (propNames.length > 0) {
        params.properties = propNames.join(',');
      }
    }

    // Extract tables
    extractTables(sysDef, params);

    const id = nextId();
    nodes.push({
      id,
      type: 'aircraftComponent',
      data: { label: params.name || file || (componentType === 'flight_control' ? 'Flight Control' : 'System'), componentType, params },
      position: nextPosition(),
    });
  }
}

function parseSystemReferences(fdmConfig, nodes, edges, fileMap = {}, parser = null) {
  parseComponentSection(fdmConfig, nodes, edges, 'system', 'system', fileMap, parser);
}

function parseFlightControl(fdmConfig, nodes, edges, fileMap = {}, parser = null) {
  parseComponentSection(fdmConfig, nodes, edges, 'flight_control', 'flight_control', fileMap, parser);
}

function parseAerodynamics(fdmConfig, nodes, edges, fileMap = {}, parser = null) {
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

// ── Section file resolver ──────────────────────────────────────────────────

// Resolve a section-level file reference like <metrics file="Metrics.xml"/>
// Returns the parsed section content, or the original element if no file ref
function resolveSectionFile(element, sectionName, fileMap, parser) {
  if (!element || !parser) return element;
  const file = element['@_file'];
  if (!file || !fileMap[file]) return element;

  try {
    const refXml = fileMap[file];
    const refParsed = parser.parse(refXml);
    // The sub-file should have the section as root element
    const sectionContent = refParsed[sectionName];
    if (sectionContent) {
      // Merge: inline attributes from the reference + content from the file
      const merged = { ...sectionContent };
      // Copy any attributes from the original reference element
      for (const [key, val] of Object.entries(element)) {
        if (key.startsWith('@_') && key !== '@_file') {
          merged[key] = val;
        }
      }
      return merged;
    }
    return element;
  } catch (e) {
    console.warn(`[resolveSectionFile] Failed to resolve ${sectionName} file="${file}":`, e.message);
    return element;
  }
}

// ── Location-based layout ──────────────────────────────────────────────────

function applyLocationLayout(nodes) {
  // Collect nodes with location data
  const located = [];
  const unlocated = [];

  for (const node of nodes) {
    const p = node.data?.params;
    if (p?.location && typeof p.location === 'object') {
      const x = typeof p.location.x === 'number' ? p.location.x : null;
      const y = typeof p.location.y === 'number' ? p.location.y : null;
      const z = typeof p.location.z === 'number' ? p.location.z : null;
      const unit = p.location.unit || 'IN';
      if (x !== null && y !== null) {
        located.push({ node, x, y, z, unit });
        continue;
      }
    }
    unlocated.push(node);
  }

  if (located.length === 0) {
    // No location data at all — arrange all nodes in categorized columns
    const NODE_H = 80;
    const GAP_Y = 20;
    const startX = 100;

    const byType = {};
    for (const node of nodes) {
      const t = node.data?.componentType || 'other';
      if (!byType[t]) byType[t] = [];
      byType[t].push(node);
    }

    const typeOrder = ['wing', 'fuselage', 'inertia', 'landing_gear', 'engine', 'propeller',
      'fuel_tank', 'point_mass', 'system', 'output', 'aero_coefficients'];

    let curY = 100;
    for (const type of typeOrder) {
      const nodesOfType = byType[type];
      if (!nodesOfType) continue;
      for (const node of nodesOfType) {
        node.position = { x: startX, y: curY };
        curY += NODE_H + GAP_Y;
      }
      if (nodesOfType) curY += GAP_Y;
    }
    return;
  }

  // Convert units to a common scale
  const MARGIN = 120;
  const NODE_W = 250;
  const NODE_H = 100;
  const GAP_Y = 20;

  // Normalize all locations to inches
  function toInches(val, unit) {
    if (unit === 'M' || unit === 'MTR') return val * 39.3701;
    if (unit === 'CM') return val * 0.393701;
    if (unit === 'FT') return val * 12;
    return val; // default IN
  }

  const locatedNorm = located.map(({ node, x, y, z, unit }) => ({
    node,
    x: toInches(x, unit),
    y: toInches(y, unit),
  }));

  // Find bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { x, y } of locatedNorm) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const SCALE = Math.max(400 / rangeX, 300 / rangeY, 1.5);

  // Position located nodes: map JSBSim coords to screen coords, rotated 90° clockwise
  // JSBSim: X=forward, Y=right
  // After 90° CW rotation: forward→right, right→down
  // screenX ∝ Y(lateral), screenY ∝ -X(forward)
  const W = Math.max(rangeY * SCALE, 400);
  const H = Math.max(rangeX * SCALE, 300);
  for (const { node, x, y } of locatedNorm) {
    const normY = (y - minY) / rangeY;       // 0=top(lateral left), 1=bottom(lateral right)
    const normX = (x - minX) / rangeX;       // 0=aft, 1=forward
    const screenX = MARGIN + normY * W;
    const screenY = MARGIN + (1 - normX) * H;
    node.position = { x: Math.round(screenX), y: Math.round(screenY) };
  }

  // Position unlocated nodes on the right side, categorized by type, top to bottom
  // NODE_W, NODE_H already declared above

  // Group unlocated nodes by componentType
  const byType = {};
  for (const node of unlocated) {
    const t = node.data?.componentType || 'other';
    if (!byType[t]) byType[t] = [];
    byType[t].push(node);
  }

  // Calculate right-side starting X (after all located nodes)
  const maxLocatedX = Math.max(...located.map(l => l.node.position.x), 0);
  let startX = Math.max(maxLocatedX + NODE_W + 120, 600);

  // Category labels and order
  const typeOrder = ['wing', 'fuselage', 'inertia', 'landing_gear', 'engine', 'propeller',
    'fuel_tank', 'point_mass', 'system', 'output', 'aero_coefficients'];
  const typeLabels = {
    wing: '🪽 机翼', fuselage: '🛩️ 机身', inertia: '🔬 惯量', landing_gear: '🛞 起落架',
    engine: '⚙️ 发动机', propeller: '🔄 螺旋桨', fuel_tank: '⛽ 油箱',
    point_mass: '⚖️ 集中质量', system: '🔗 系统', output: '📡 输出',
    aero_coefficients: '🌊 气动系数',
  };

  // Two-column layout for unlocated nodes
  const COL_GAP = 40;
  const col2X = startX + NODE_W + COL_GAP;

  // Flatten all unlocated nodes in category order
  const orderedNodes = [];
  const categoryBreaks = []; // track where each category starts
  for (const type of typeOrder) {
    const nodesOfType = byType[type];
    if (!nodesOfType || nodesOfType.length === 0) continue;
    categoryBreaks.push({ type, startIdx: orderedNodes.length, count: nodesOfType.length });
    orderedNodes.push(...nodesOfType);
  }
  // Handle remaining types
  for (const [type, nodesOfType] of Object.entries(byType)) {
    if (typeOrder.includes(type)) continue;
    categoryBreaks.push({ type, startIdx: orderedNodes.length, count: nodesOfType.length });
    orderedNodes.push(...nodesOfType);
  }

  // Assign positions in two columns
  let curY1 = 100; // column 1 (left) current Y
  let curY2 = 100; // column 2 (right) current Y
  let useCol2 = false;

  for (let i = 0; i < orderedNodes.length; i++) {
    // Decide which column: alternate between col1 and col2, or fill col1 first then col2
    // Strategy: fill col1 until it reaches a threshold, then start col2
    const totalHeight = Math.max(curY1, curY2);
    if (curY1 <= curY2) {
      orderedNodes[i].position = { x: startX, y: curY1 };
      curY1 += NODE_H + GAP_Y;
    } else {
      orderedNodes[i].position = { x: col2X, y: curY2 };
      curY2 += NODE_H + GAP_Y;
    }
  }

  // Add extra gap between categories (adjust last node of each category)
  // Already handled by sequential placement above
}

// ── Main parser ─────────────────────────────────────────────────────────────

function parseXml(xmlString, fileMap = {}) {
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

  // Resolve section-level file references (e.g. <metrics file="Metrics.xml"/>)
  const sectionNames = ['metrics', 'mass_balance', 'ground_reactions', 'propulsion',
    'aerodynamics', 'flight_control', 'system', 'output'];
  for (const section of sectionNames) {
    const el = fdmConfig[section];
    if (!el) continue;
    // Handle both single element and array
    if (Array.isArray(el)) {
      for (let i = 0; i < el.length; i++) {
        el[i] = resolveSectionFile(el[i], section, fileMap, parser);
      }
    } else if (typeof el === 'object') {
      fdmConfig[section] = resolveSectionFile(el, section, fileMap, parser);
    }
  }

  // Parse each section (pass fileMap for resolving references)
  parseFileHeader(fdmConfig, aircraft);
  parseMetrics(fdmConfig, nodes, edges);
  parseMassBalance(fdmConfig, nodes, edges);
  parseGroundReactions(fdmConfig, nodes, edges);
  parsePropulsion(fdmConfig, nodes, edges, fileMap, parser);
  parseSystemReferences(fdmConfig, nodes, edges, fileMap, parser);
  parseFlightControl(fdmConfig, nodes, edges, fileMap, parser);
  parseAerodynamics(fdmConfig, nodes, edges, fileMap, parser);
  parseOutput(fdmConfig, nodes, edges);

  // Create logical edges between related nodes
  createLogicalEdges(nodes, edges);

  // Apply location-based layout
  applyLocationLayout(nodes);

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
