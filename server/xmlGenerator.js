/**
 * xmlGenerator.js
 * Converts a JSON graph (nodes + edges) into a JSBSim-compatible XML string.
 */

// ── XML helper functions ────────────────────────────────────────────────────

function indent(level) {
  return '    '.repeat(level);
}

function xmlElement(name, attrs, content, level) {
  const ind = indent(level);
  let attrStr = '';
  if (attrs && Object.keys(attrs).length > 0) {
    attrStr = ' ' + Object.entries(attrs)
      .map(([k, v]) => `${k}="${escapeXml(String(v))}"`)
      .join(' ');
  }
  if (content === undefined || content === null || content === '') {
    return `${ind}<${name}${attrStr}/>`;
  }
  if (typeof content === 'string' && !content.includes('\n')) {
    return `${ind}<${name}${attrStr}>${escapeXml(content)}</${name}>`;
  }
  // Ensure content ends with newline before closing tag
  const contentStr = content.endsWith('\n') ? content : content + '\n';
  return `${ind}<${name}${attrStr}>\n${contentStr}${ind}</${name}>`;
}

function xmlSimple(name, value, unit, level) {
  if (value === undefined || value === null || value === '') return '';
  const attrs = unit ? { unit } : {};
  return xmlElement(name, attrs, String(value), level);
}

function xmlLocation(x, y, z, unit, name, level) {
  const ind = indent(level);
  const unitAttr = unit ? ` unit="${unit}"` : '';
  const tag = name || 'location';
  const xVal = x !== undefined && x !== null ? x : 0;
  const yVal = y !== undefined && y !== null ? y : 0;
  const zVal = z !== undefined && z !== null ? z : 0;
  return `${ind}<${tag}${unitAttr}>\n${indent(level + 1)}<x>${xVal}</x>\n${indent(level + 1)}<y>${yVal}</y>\n${indent(level + 1)}<z>${zVal}</z>\n${ind}</${tag}>`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Node grouping ───────────────────────────────────────────────────────────

function groupNodesByType(nodes) {
  const groups = {};
  for (const node of nodes) {
    const type = (node.data && node.data.componentType) || node.type || 'unknown';
    if (!groups[type]) groups[type] = [];
    groups[type].push(node);
  }
  return groups;
}

function getParams(node) {
  return (node.data && node.data.params) || {};
}

function getVal(p) {
  if (p === undefined || p === null) return undefined;
  if (typeof p === 'object' && p !== null && 'value' in p) return p.value;
  return p;
}

function getUnit(p) {
  if (p !== null && typeof p === 'object' && 'unit' in p) return p.unit;
  return undefined;
}

// ── Section builders ────────────────────────────────────────────────────────

function buildFileHeader(aircraft) {
  const lines = [];
  lines.push(xmlElement('name', {}, aircraft.name || 'Unnamed Aircraft', 1));
  if (aircraft.version) {
    lines.push(xmlElement('version', {}, aircraft.version, 1));
  }
  if (aircraft.release) {
    lines.push(xmlElement('description', {}, `Aircraft configuration - ${aircraft.release}`, 1));
  }
  const content = lines.join('\n');
  return xmlElement('fileheader', {}, content, 0);
}

function buildMetrics(groups) {
  const lines = [];
  const wingNodes = groups['wing'] || [];
  const htailNodes = groups['htail'] || [];
  const vtailNodes = groups['vtail'] || [];

  for (const wing of wingNodes) {
    const p = getParams(wing);
    if (p.wingarea !== undefined) lines.push(xmlSimple('wingarea', getVal(p.wingarea), getUnit(p.wingarea) || 'FT2', 1));
    if (p.wingspan !== undefined) lines.push(xmlSimple('wingspan', getVal(p.wingspan), getUnit(p.wingspan) || 'FT', 1));
    if (p.chord !== undefined) lines.push(xmlSimple('chord', getVal(p.chord), getUnit(p.chord) || 'FT', 1));
    if (p.wing_incidence !== undefined) lines.push(xmlSimple('wing_incidence', getVal(p.wing_incidence), getUnit(p.wing_incidence) || 'DEG', 1));
    if (p.location) {
      lines.push(xmlLocation(p.location.x, p.location.y, p.location.z, p.location.unit || 'IN', 'location', 1));
    }
  }

  for (const ht of htailNodes) {
    const p = getParams(ht);
    if (p.area !== undefined) lines.push(xmlSimple('htailarea', getVal(p.area), getUnit(p.area) || 'FT2', 1));
    if (p.arm !== undefined) lines.push(xmlSimple('htailarm', getVal(p.arm), getUnit(p.arm) || 'FT', 1));
    if (p.htailarea !== undefined) lines.push(xmlSimple('htailarea', getVal(p.htailarea), getUnit(p.htailarea) || 'FT2', 1));
    if (p.htailarm !== undefined) lines.push(xmlSimple('htailarm', getVal(p.htailarm), getUnit(p.htailarm) || 'FT', 1));
  }

  for (const vt of vtailNodes) {
    const p = getParams(vt);
    if (p.area !== undefined) lines.push(xmlSimple('vtailarea', getVal(p.area), getUnit(p.area) || 'FT2', 1));
    if (p.arm !== undefined) lines.push(xmlSimple('vtailarm', getVal(p.arm), getUnit(p.arm) || 'FT', 1));
    if (p.vtailarea !== undefined) lines.push(xmlSimple('vtailarea', getVal(p.vtailarea), getUnit(p.vtailarea) || 'FT2', 1));
    if (p.vtailarm !== undefined) lines.push(xmlSimple('vtailarm', getVal(p.vtailarm), getUnit(p.vtailarm) || 'FT', 1));
  }

  const content = lines.length > 0 ? lines.join('\n') : '';
  return xmlElement('metrics', {}, content, 0);
}

function buildMassBalance(groups) {
  const lines = [];
  const fuselageNodes = groups['fuselage'] || [];
  const inertiaNodes = groups['inertia'] || [];
  const pointMassNodes = groups['point_mass'] || [];

  // Fuselage contributes emptywt and cg
  for (const fus of fuselageNodes) {
    const p = getParams(fus);
    if (p.emptywt) {
      const val = typeof p.emptywt === 'object' ? p.emptywt.value : p.emptywt;
      const unit = typeof p.emptywt === 'object' ? p.emptywt.unit : undefined;
      lines.push(xmlSimple('emptywt', val, unit, 1));
    }
    if (p.cg) {
      lines.push(xmlLocation(p.cg.x, p.cg.y, p.cg.z, p.cg.unit, 'location', 1).replace('<location', '<location name="CG"'));
    }
  }

  // Inertia node
  for (const iner of inertiaNodes) {
    const p = getParams(iner);
    if (p.ixx !== undefined) lines.push(xmlSimple('ixx', getVal(p.ixx), getUnit(p.ixx) || 'SLUG*FT2', 1));
    if (p.iyy !== undefined) lines.push(xmlSimple('iyy', getVal(p.iyy), getUnit(p.iyy) || 'SLUG*FT2', 1));
    if (p.izz !== undefined) lines.push(xmlSimple('izz', getVal(p.izz), getUnit(p.izz) || 'SLUG*FT2', 1));
    if (p.ixy !== undefined) lines.push(xmlSimple('ixy', getVal(p.ixy), getUnit(p.ixy) || 'SLUG*FT2', 1));
    if (p.ixz !== undefined) lines.push(xmlSimple('ixz', getVal(p.ixz), getUnit(p.ixz) || 'SLUG*FT2', 1));
    if (p.iyz !== undefined) lines.push(xmlSimple('iyz', getVal(p.iyz), getUnit(p.iyz) || 'SLUG*FT2', 1));
  }

  // Point masses
  for (const pm of pointMassNodes) {
    const p = getParams(pm);
    const pmLines = [];
    if (p.weight !== undefined) {
      pmLines.push(xmlSimple('weight', getVal(p.weight), getUnit(p.weight) || 'LBS', 2));
    }
    if (p.location) {
      pmLines.push(xmlLocation(p.location.x, p.location.y, p.location.z, p.location.unit || 'IN', 'location', 2));
    }
    const attrs = p.name ? { name: p.name } : {};
    lines.push(xmlElement('pointmass', attrs, pmLines.join('\n'), 1));
  }

  const content = lines.length > 0 ? lines.join('\n') : '';
  return xmlElement('mass_balance', {}, content, 0);
}

function buildGroundReactions(groups) {
  const lines = [];
  const gearNodes = groups['landing_gear'] || [];

  for (const gear of gearNodes) {
    const p = getParams(gear);
    const gearLines = [];

    if (p.location) {
      gearLines.push(xmlLocation(p.location.x, p.location.y, p.location.z, p.location.unit || 'IN', 'location', 2));
    }
    if (p.static_friction !== undefined && p.static_friction !== '') {
      gearLines.push(xmlElement('static_friction', {}, String(getVal(p.static_friction)), 2));
    }
    if (p.dynamic_friction !== undefined && p.dynamic_friction !== '') {
      gearLines.push(xmlElement('dynamic_friction', {}, String(getVal(p.dynamic_friction)), 2));
    }
    if (p.rolling_friction !== undefined && p.rolling_friction !== '') {
      gearLines.push(xmlElement('rolling_friction', {}, String(getVal(p.rolling_friction)), 2));
    }
    if (p.spring_coeff !== undefined) {
      gearLines.push(xmlSimple('spring_coeff', getVal(p.spring_coeff), getUnit(p.spring_coeff) || 'LBS/FT', 2));
    }
    if (p.damping_coeff !== undefined) {
      gearLines.push(xmlSimple('damping_coeff', getVal(p.damping_coeff), getUnit(p.damping_coeff) || 'LBS/FT/SEC', 2));
    }
    if (p.max_steer !== undefined) {
      gearLines.push(xmlSimple('max_steer', getVal(p.max_steer), getUnit(p.max_steer) || 'DEG', 2));
    }
    if (p.brake_group) {
      gearLines.push(xmlElement('brake_group', {}, String(p.brake_group), 2));
    }
    if (p.retractable !== undefined && p.retractable !== '') {
      gearLines.push(xmlElement('retractable', {}, String(p.retractable), 2));
    }

    const attrs = {};
    if (p.name) attrs['name'] = p.name;
    if (p.type) attrs['type'] = p.type;
    lines.push(xmlElement('contact', attrs, gearLines.join('\n'), 1));
  }

  const content = lines.length > 0 ? lines.join('\n') : '';
  return xmlElement('ground_reactions', {}, content, 0);
}

function buildExternalReactions() {
  // Placeholder section
  return xmlElement('external_reactions', {}, '', 0);
}

function buildPropulsion(groups, input) {
  const lines = [];
  const engineNodes = groups['engine'] || [];
  const propellerNodes = groups['propeller'] || [];
  const fuelTankNodes = groups['fuel_tank'] || [];

  // Engines
  for (const eng of engineNodes) {
    const p = getParams(eng);
    const engLines = [];

    // Feed tanks
    if (p.feed) {
      const feeds = typeof p.feed === 'string' ? p.feed.split(',').map(s => s.trim()) : [String(p.feed)];
      for (const f of feeds) {
        engLines.push(xmlElement('feed', {}, f, 2));
      }
    }

    // Thruster
    if (p.thruster_file) {
      const thrLines = [];
      // Find connected propeller node via edges
      const propNode = propellerNodes.find(pr => {
        return input.edges && input.edges.some(e =>
          (e.source === eng.id && e.target === pr.id) ||
          (e.source === pr.id && e.target === eng.id)
        );
      });
      if (propNode) {
        const pp = getParams(propNode);
        if (pp.location) {
          thrLines.push(xmlLocation(pp.location.x, pp.location.y, pp.location.z, pp.location.unit, 'location', 3));
        }
        if (pp.sense !== undefined) {
          thrLines.push(xmlElement('sense', {}, String(pp.sense), 3));
        }
        if (pp.p_factor !== undefined) {
          thrLines.push(xmlElement('p_factor', {}, String(pp.p_factor), 3));
        }
      }
      engLines.push(xmlElement('thruster', { file: p.thruster_file }, thrLines.join('\n'), 2));
    }

    const attrs = {};
    if (p.file) attrs['file'] = p.file;
    lines.push(xmlElement('engine', attrs, engLines.join('\n'), 1));
  }

  // Propellers (as thrusters)
  for (const prop of propellerNodes) {
    const p = getParams(prop);
    const propLines = [];

    if (p.location) {
      propLines.push(xmlLocation(p.location.x, p.location.y, p.location.z, p.location.unit, 'location', 2));
    }
    if (p.sense !== undefined && p.sense !== '') {
      propLines.push(xmlElement('sense', {}, String(p.sense), 2));
    }
    if (p.p_factor !== undefined && p.p_factor !== '') {
      propLines.push(xmlElement('p_factor', {}, String(p.p_factor), 2));
    }

    const attrs = {};
    if (p.file) attrs['file'] = p.file;
    lines.push(xmlElement('thruster', attrs, propLines.join('\n'), 1));
  }

  // Fuel tanks
  for (const tank of fuelTankNodes) {
    const p = getParams(tank);
    const tankLines = [];

    if (p.location) {
      tankLines.push(xmlLocation(p.location.x, p.location.y, p.location.z, p.location.unit, 'location', 2));
    }
    if (p.capacity !== undefined) {
      tankLines.push(xmlSimple('capacity', getVal(p.capacity), getUnit(p.capacity) || 'LBS', 2));
    }
    if (p.contents !== undefined) {
      tankLines.push(xmlSimple('contents', getVal(p.contents), getUnit(p.contents) || 'LBS', 2));
    }

    const attrs = { type: 'FUEL' };
    if (p.name) attrs['type'] = 'FUEL';
    lines.push(xmlElement('tank', attrs, tankLines.join('\n'), 1));
  }

  const content = lines.length > 0 ? lines.join('\n') : '';
  return xmlElement('propulsion', {}, content, 0);
}

function buildSystemReferences(groups) {
  const systemNodes = groups['system'] || [];
  if (systemNodes.length === 0) return '';

  const lines = [];
  for (const sys of systemNodes) {
    const p = getParams(sys);
    const file = p.file || sys.data?.label || 'unknown';
    const properties = p.properties || '';

    if (properties) {
      const propList = typeof properties === 'string'
        ? properties.split(',').map(s => s.trim()).filter(Boolean)
        : Array.isArray(properties) ? properties : [];
      const propLines = propList.map(prop => xmlElement('property', {}, prop, 2));
      lines.push(xmlElement('system', { file }, propLines.join('\n'), 1));
    } else {
      lines.push(xmlElement('system', { file }, undefined, 1));
    }
  }

  return lines.join('\n');
}

function buildFlightControl() {
  // Placeholder section
  return xmlElement('flight_control', {}, '', 0);
}

function buildAerodynamics(groups) {
  const aeroNodes = groups['aero_coefficients'] || [];
  if (aeroNodes.length === 0) return xmlElement('aerodynamics', {}, '', 0);

  const { exprToXml } = require('./expressionXml');
  const lines = [];

  for (const aero of aeroNodes) {
    const p = getParams(aero);
    const rawCoeffs = p.coefficients || '[]';
    let coeffs;
    try { coeffs = JSON.parse(rawCoeffs); } catch { coeffs = []; }
    if (!Array.isArray(coeffs)) continue;

    for (const c of coeffs) {
      if (!c.name) continue;

      const axisMap = { DRAG: 'drag', SIDE: 'side', LIFT: 'lift', ROLL: 'roll', PITCH: 'pitch', YAW: 'yaw' };
      const axis = axisMap[c.axis] || 'lift';
      const funcName = c.name;

      let bodyXml;

      if (c.expression) {
        // New expression tree format
        bodyXml = exprToXml(c.expression, 3);
      } else {
        // Legacy flat format - backward compatibility
        if (c.tableType === 'constant') {
          bodyXml = xmlElement('value', {}, String(c.value || 0), 3);
        } else if (c.tableType === '1D' || c.tableType === '2D' || c.tableType === '3D') {
          const tableExpr = {
            kind: 'table',
            tableType: c.tableType,
            var1: c.var1 || 'aero/alpha-rad',
            var2: c.var2 || '',
            var3: c.var3 || '',
            data: c.data || [[0]],
            breakpoints1: c.breakpoints1 || [0],
            breakpoints2: c.breakpoints2 || [],
            breakpoints3: c.breakpoints3 || [],
          };
          const prodLines = [];
          prodLines.push(xmlElement('property', {}, c.var1 || 'aero/alpha-rad', 3));
          prodLines.push(exprToXml(tableExpr, 3));
          bodyXml = xmlElement('product', {}, prodLines.join('\n'), 3);
        } else {
          bodyXml = xmlElement('value', {}, '0', 3);
        }
      }

      const descXml = c.description
        ? xmlElement('description', {}, c.description, 3)
        : '';
      const funcContent = [descXml, bodyXml].filter(Boolean).join('\n');
      const funcXml = xmlElement('function', { name: funcName }, funcContent, 2);
      lines.push({ axis, xml: funcXml });
    }
  }

  // Group functions by axis
  const axisGroups = {};
  for (const item of lines) {
    if (!axisGroups[item.axis]) axisGroups[item.axis] = [];
    axisGroups[item.axis].push(item.xml);
  }

  const axisBlocks = [];
  for (const [axisName, funcs] of Object.entries(axisGroups)) {
    axisBlocks.push(xmlElement('axis', { name: axisName.toUpperCase() }, funcs.join('\n'), 1));
  }

  const content = axisBlocks.length > 0 ? axisBlocks.join('\n') : '';
  return xmlElement('aerodynamics', {}, content, 0);
}

function buildOutput(groups) {
  const outputNodes = groups['output'] || [];
  if (outputNodes.length === 0) return '';

  const blocks = [];
  for (const out of outputNodes) {
    const p = getParams(out);
    const lines = [];

    const dataGroups = ['simulation', 'atmosphere', 'massprops', 'rates', 'velocities',
      'forces', 'moments', 'position', 'propulsion', 'aerosurfaces', 'fcs',
      'ground_reactions', 'coefficients'];

    for (const group of dataGroups) {
      if (p[group] !== undefined) {
        lines.push(xmlElement(group, {}, String(p[group]), 1));
      }
    }

    const properties = p.properties || '';
    if (properties) {
      const propList = typeof properties === 'string'
        ? properties.split(',').map(s => s.trim()).filter(Boolean)
        : Array.isArray(properties) ? properties : [];
      for (const prop of propList) {
        const propName = typeof prop === 'string' ? prop : (prop.name || '');
        if (propName) lines.push(xmlElement('property', {}, propName, 1));
      }
    }

    const attrs = {};
    if (p.name) attrs['name'] = p.name;
    if (p.type) attrs['type'] = p.type;
    if (p.port !== undefined) attrs['port'] = String(p.port);
    if (p.rate !== undefined) attrs['rate'] = String(p.rate);

    blocks.push(xmlElement('output', attrs, lines.join('\n'), 0));
  }
  return blocks.join('\n\n');
}

// ── Main generator ──────────────────────────────────────────────────────────

function generateXml(input) {
  const aircraft = input.aircraft || { name: 'Unnamed Aircraft', version: '1.0', release: '1.0' };
  const nodes = input.nodes || [];
  const groups = groupNodesByType(nodes);

  const sections = [];

  // XML declaration
  sections.push('<?xml version="1.0"?>');

  // Root element with fdm_config
  const fdmAttrs = {
    name: aircraft.name || 'Unnamed Aircraft',
    version: aircraft.version || '2.0',
  };
  if (aircraft.release) {
    fdmAttrs.release = aircraft.release;
  }

  // Build all sections
  const sectionContent = [];
  sectionContent.push(buildFileHeader(aircraft));
  sectionContent.push(buildMetrics(groups));
  sectionContent.push(buildMassBalance(groups));
  sectionContent.push(buildGroundReactions(groups));
  sectionContent.push(buildExternalReactions());
  sectionContent.push(buildPropulsion(groups, input));
  const systemRefs = buildSystemReferences(groups);
  if (systemRefs) sectionContent.push(systemRefs);
  sectionContent.push(buildFlightControl());
  sectionContent.push(buildAerodynamics(groups));
  const outputXml = buildOutput(groups);
  if (outputXml) sectionContent.push(outputXml);

  const innerXml = sectionContent.join('\n\n');

  // Wrap in root fdm_config element
  const rootOpen = `<fdm_config ${Object.entries(fdmAttrs)
    .map(([k, v]) => `${k}="${escapeXml(String(v))}"`)
    .join(' ')}>`;
  const rootClose = '</fdm_config>';

  sections.push(rootOpen);
  sections.push(innerXml);
  sections.push(rootClose);

  return sections.join('\n\n') + '\n';
}

function generateSubFileXml(subFile) {
  if (!subFile) throw new Error('Invalid sub-file data');

  // Support both frontend format (fileType/fileName/data) and direct format (type/name/params)
  const fileType = subFile.fileType || subFile.type;
  const name = (subFile.data && subFile.data.name) || subFile.fileName || subFile.name || 'unnamed';
  const d = subFile.data || subFile.params || {};
  const lines = ['<?xml version="1.0"?>'];

  if (fileType === 'engine') {
    const engineType = d.engineType || 'piston';
    if (engineType === 'piston' || engineType === 'electric') {
      const content = [];
      if (d.maxHP !== undefined) content.push(xmlSimple('maxhp', d.maxHP, '', 1));
      if (d.displacement !== undefined) content.push(xmlSimple('displacement', d.displacement, 'IN3', 1));
      if (d.cycles !== undefined) content.push(xmlSimple('cycles', d.cycles, '', 1));
      if (d.bsfc !== undefined) content.push(xmlSimple('bsfc', d.bsfc, 'LBS/HP*HR', 1));
      if (d.starterTorque !== undefined) content.push(xmlSimple('startertorque', d.starterTorque, '', 1));
      if (d.idleRPM !== undefined) content.push(xmlSimple('idlerpm', d.idleRPM, '', 1));
      if (d.maxRPM !== undefined) content.push(xmlSimple('maxrpm', d.maxRPM, '', 1));
      if (d.minMP !== undefined) content.push(xmlSimple('minmp', d.minMP, 'INHG', 1));
      if (d.maxMP !== undefined) content.push(xmlSimple('maxmp', d.maxMP, 'INHG', 1));
      lines.push(xmlElement('piston_engine', { name }, content.join('\n'), 0));
    } else if (engineType === 'turbine') {
      const content = [];
      if (d.maxThrust !== undefined) content.push(xmlSimple('maxthrust', d.maxThrust, 'LBS', 1));
      if (d.idleRPM !== undefined) content.push(xmlSimple('idlen1', d.idleRPM, '', 1));
      if (d.maxRPM !== undefined) content.push(xmlSimple('maxn1', d.maxRPM, '', 1));
      lines.push(xmlElement('turbine_engine', { name }, content.join('\n'), 0));
    } else if (engineType === 'rocket') {
      const content = [];
      if (d.maxThrust !== undefined) content.push(xmlSimple('maxthrust', d.maxThrust, 'LBS', 1));
      lines.push(xmlElement('rocket_engine', { name }, content.join('\n'), 0));
    }
  } else if (fileType === 'thruster') {
    const thrusterType = d.thrusterType || 'propeller';
    if (thrusterType === 'propeller') {
      const content = [];
      if (d.diameter !== undefined) content.push(xmlSimple('diameter', d.diameter, 'IN', 1));
      if (d.numBlades !== undefined) content.push(xmlSimple('numblades', d.numBlades, '', 1));
      if (d.gearRatio !== undefined) content.push(xmlSimple('gearratio', d.gearRatio, '', 1));
      lines.push(xmlElement('propeller', { name }, content.join('\n'), 0));
    } else if (thrusterType === 'direct') {
      lines.push(xmlElement('direct', { name }, undefined, 0));
    } else if (thrusterType === 'nozzle') {
      lines.push(xmlElement('nozzle', { name }, undefined, 0));
    }
  } else if (fileType === 'system') {
    const content = [];
    const properties = d.properties || [];
    const propList = Array.isArray(properties) ? properties :
      (typeof properties === 'string' ? properties.split(',').map(s => s.trim()).filter(Boolean) : []);
    for (const prop of propList) {
      const propName = typeof prop === 'string' ? prop : (prop.name || '');
      if (propName) content.push(xmlElement('property', {}, propName, 1));
    }
    lines.push(xmlElement('system', { name }, content.length > 0 ? content.join('\n') : undefined, 0));
  } else {
    throw new Error(`Unknown sub-file type: ${fileType}`);
  }

  return lines.join('\n') + '\n';
}

module.exports = { generateXml, generateSubFileXml };
