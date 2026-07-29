/**
 * expressionXml.js
 * Converts between JSBSim expression trees (ExprNode) and XML strings.
 * Used by xmlGenerator.js and xmlParser.js for aerodynamic function expressions.
 */

// ── XML helpers (duplicated from xmlGenerator to avoid circular deps) ───────

function indent(level) {
  return '    '.repeat(level);
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Expression → XML ────────────────────────────────────────────────────────

/**
 * Generate XML for an expression node at the given indentation level.
 * Returns a string of XML.
 */
function exprToXml(expr, level) {
  if (!expr || !expr.kind) return `${indent(level)}<value>0</value>`;

  const ind = indent(level);

  switch (expr.kind) {
    case 'value':
      return `${ind}<value>${expr.value}</value>`;

    case 'property':
      return `${ind}<property>${escapeXml(expr.name)}</property>`;

    case 'function_ref':
      return `${ind}<property>${escapeXml(expr.name)}</property>`;

    case 'table':
      return tableToXml(expr, level);

    case 'product':
      return multiArgToXml('product', expr.children, level);

    case 'sum':
      return multiArgToXml('sum', expr.children, level);

    case 'difference':
      return twoArgToXml('difference', expr.left, expr.right, level);

    case 'quotient':
      return twoArgToXml('quotient', expr.left, expr.right, level);

    case 'pow':
      return twoArgToXml('pow', expr.base, expr.exponent, level);

    case 'atan2':
      return twoArgToXml('atan2', expr.y, expr.x, level);

    case 'abs': case 'sin': case 'cos': case 'tan':
    case 'asin': case 'acos': case 'atan': case 'sqrt': case 'exp':
      return unaryToXml(expr.kind, expr.child, level);

    case 'gt': case 'lt': case 'ge': case 'le': case 'eq': case 'nq':
      return twoArgToXml(expr.kind, expr.left, expr.right, level);

    case 'ifthen':
      return `${ind}<ifthen>\n${exprToXml(expr.cond, level + 1)}\n${exprToXml(expr.then, level + 1)}\n${exprToXml(expr.else, level + 1)}\n${ind}</ifthen>`;

    case 'switch': {
      const parts = [exprToXml(expr.index, level + 1)];
      for (const c of expr.cases) parts.push(exprToXml(c, level + 1));
      parts.push(exprToXml(expr.default, level + 1));
      return `${ind}<switch>\n${parts.join('\n')}\n${ind}</switch>`;
    }

    default:
      return `${ind}<value>0</value>`;
  }
}

function multiArgToXml(tag, children, level) {
  const ind = indent(level);
  if (!children || children.length === 0) return `${ind}<${tag}/>`;
  const childXml = children.map(c => exprToXml(c, level + 1)).join('\n');
  return `${ind}<${tag}>\n${childXml}\n${ind}</${tag}>`;
}

function twoArgToXml(tag, left, right, level) {
  const ind = indent(level);
  const leftXml = exprToXml(left, level + 1);
  const rightXml = exprToXml(right, level + 1);
  return `${ind}<${tag}>\n${leftXml}\n${rightXml}\n${ind}</${tag}>`;
}

function unaryToXml(tag, child, level) {
  const ind = indent(level);
  const childXml = exprToXml(child, level + 1);
  return `${ind}<${tag}>\n${childXml}\n${ind}</${tag}>`;
}

function tableToXml(expr, level) {
  const ind = indent(level);
  const lines = [];

  if (expr.tableType === '1D' || !expr.tableType) {
    lines.push(`${ind}<table>`);
    lines.push(`${indent(level + 1)}<independentVar>${escapeXml(expr.var1 || 'aero/alpha-rad')}</independentVar>`);
    lines.push(tableDataToXml1D(expr, level + 1));
    lines.push(`${ind}</table>`);
  } else if (expr.tableType === '2D') {
    lines.push(`${ind}<table>`);
    lines.push(`${indent(level + 1)}<independentVar lookup="row">${escapeXml(expr.var1 || 'aero/alpha-rad')}</independentVar>`);
    lines.push(`${indent(level + 1)}<independentVar lookup="column">${escapeXml(expr.var2 || 'fcs/elevator-pos-rad')}</independentVar>`);
    lines.push(tableDataToXml2D(expr, level + 1));
    lines.push(`${ind}</table>`);
  } else if (expr.tableType === '3D') {
    lines.push(`${ind}<table>`);
    lines.push(`${indent(level + 1)}<independentVar lookup="row">${escapeXml(expr.var1 || 'aero/alpha-rad')}</independentVar>`);
    lines.push(`${indent(level + 1)}<independentVar lookup="column">${escapeXml(expr.var2 || 'fcs/elevator-pos-rad')}</independentVar>`);
    lines.push(tableDataToXml3D(expr, level + 1));
    lines.push(`${ind}</table>`);
  }

  return lines.join('\n');
}

function tableDataToXml1D(expr, level) {
  const ind = indent(level);
  const lines = [`${ind}<tableData>`];
  const bp = expr.breakpoints1 || [];
  const data = expr.data || [];
  for (let i = 0; i < data.length; i++) {
    const b = bp[i] !== undefined ? bp[i] : 0;
    const v = data[i] && data[i][0] !== undefined ? data[i][0] : 0;
    lines.push(`${ind}    ${b}\t${v}`);
  }
  lines.push(`${ind}</tableData>`);
  return lines.join('\n');
}

function tableDataToXml2D(expr, level) {
  const ind = indent(level);
  const lines = [`${ind}<tableData>`];
  const bp1 = expr.breakpoints1 || [];
  const bp2 = expr.breakpoints2 || [];
  const data = expr.data || [];

  // Header row
  const header = [''];
  for (const b of bp2) header.push(String(b));
  lines.push(ind + '    ' + header.join('\t'));

  // Data rows
  for (let r = 0; r < data.length; r++) {
    const row = [String(bp1[r] !== undefined ? bp1[r] : 0)];
    for (let c = 0; c < bp2.length; c++) {
      row.push(String(data[r] && data[r][c] !== undefined ? data[r][c] : 0));
    }
    lines.push(ind + '    ' + row.join('\t'));
  }
  lines.push(`${ind}</tableData>`);
  return lines.join('\n');
}

function tableDataToXml3D(expr, level) {
  const ind = indent(level);
  const lines = [];
  const bp1 = expr.breakpoints1 || [];
  const bp2 = expr.breakpoints2 || [];
  const bp3 = expr.breakpoints3 || [];
  const data = expr.data || [];
  const rowsPerTable = bp1.length || 1;
  const cols = bp2.length || 1;

  for (let t = 0; t < bp3.length; t++) {
    lines.push(`${ind}<tableData breakPoint="${bp3[t]}">`);
    // Header
    const header = [''];
    for (const b of bp2) header.push(String(b));
    lines.push(ind + '    ' + header.join('\t'));

    const startRow = t * rowsPerTable;
    for (let r = 0; r < rowsPerTable; r++) {
      const idx = startRow + r;
      const row = [String(bp1[r] !== undefined ? bp1[r] : 0)];
      for (let c = 0; c < cols; c++) {
        row.push(String(data[idx] && data[idx][c] !== undefined ? data[idx][c] : 0));
      }
      lines.push(ind + '    ' + row.join('\t'));
    }
    lines.push(`${ind}</tableData>`);
  }
  return lines.join('\n');
}

// ── XML → Expression (parsing) ──────────────────────────────────────────────

// Helpers for fast-xml-parser output
function ensureArray(val) {
  if (val === undefined || val === null) return [];
  if (Array.isArray(val)) return val;
  return [val];
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

/**
 * Parse a JSBSim function XML element into an ExprNode tree.
 * `funcObj` is the parsed object from fast-xml-parser for a <function> element.
 */
function xmlToExpr(funcObj) {
  if (!funcObj) return { kind: 'value', value: 0 };

  // Check for direct value
  if (funcObj['value'] !== undefined && !funcObj['product'] && !funcObj['sum'] &&
      !funcObj['table'] && !funcObj['difference'] && !funcObj['quotient']) {
    return { kind: 'value', value: Number(extractText(funcObj['value'])) || 0 };
  }

  // Find the body element (the first operation element)
  return parseFuncBody(funcObj);
}

function parseFuncBody(obj) {
  // Try each operation type in order
  if (obj['product']) return parseProduct(obj['product']);
  if (obj['sum']) return parseSum(obj['sum']);
  if (obj['difference']) return parseDifference(obj['difference']);
  if (obj['quotient']) return parseQuotient(obj['quotient']);
  if (obj['pow']) return parsePow(obj['pow']);
  if (obj['atan2']) return parseAtan2(obj['atan2']);

  // Unary functions
  const unaryOps = ['abs', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'exp'];
  for (const op of unaryOps) {
    if (obj[op]) return parseUnary(op, obj[op]);
  }

  // Comparisons
  const compOps = ['gt', 'lt', 'ge', 'le', 'eq', 'nq'];
  for (const op of compOps) {
    if (obj[op]) return parseComparison(op, obj[op]);
  }

  // ifthen
  if (obj['ifthen']) return parseIfThen(obj['ifthen']);

  // switch
  if (obj['switch']) return parseSwitch(obj['switch']);

  // table (standalone)
  if (obj['table']) return parseTable(obj['table']);

  // property (standalone)
  if (obj['property']) return { kind: 'property', name: extractText(obj['property']) };

  // value
  if (obj['value'] !== undefined) return { kind: 'value', value: Number(extractText(obj['value'])) || 0 };

  // v (shorthand value)
  if (obj['v'] !== undefined) return { kind: 'value', value: Number(extractText(obj['v'])) || 0 };

  // p (shorthand property)
  if (obj['p']) return { kind: 'property', name: extractText(obj['p']) };

  return { kind: 'value', value: 0 };
}

/**
 * Parse a func_group element - can be any expression node type.
 * This is the core recursive parser.
 */
function parseFuncGroup(obj) {
  if (!obj) return { kind: 'value', value: 0 };

  // If it's a string or number, it's a value
  if (typeof obj === 'number') return { kind: 'value', value: obj };
  if (typeof obj === 'string') {
    const num = Number(obj);
    if (!isNaN(num)) return { kind: 'value', value: num };
    return { kind: 'property', name: obj };
  }

  // Check for #text (inline value)
  if (obj['#text'] !== undefined) {
    const text = extractText(obj);
    const num = Number(text);
    if (!isNaN(num) && text.trim().match(/^-?\d/)) return { kind: 'value', value: num };
    return { kind: 'property', name: text };
  }

  return parseFuncBody(obj);
}

function parseChildren(obj) {
  // A multi-arg element contains multiple child elements that are each func_group items
  const children = [];
  const keys = Object.keys(obj).filter(k => !k.startsWith('@_') && k !== '#text');

  for (const key of keys) {
    const items = ensureArray(obj[key]);
    for (const item of items) {
      const wrapped = { [key]: item };
      children.push(parseFuncGroup(wrapped));
    }
  }
  return children;
}

function parseTwoChildren(obj) {
  const children = parseChildren(obj);
  return {
    left: children[0] || { kind: 'value', value: 0 },
    right: children[1] || { kind: 'value', value: 0 },
  };
}

function parseProduct(obj) {
  const children = parseChildren(obj);
  return { kind: 'product', children };
}

function parseSum(obj) {
  const children = parseChildren(obj);
  return { kind: 'sum', children };
}

function parseDifference(obj) {
  const { left, right } = parseTwoChildren(obj);
  return { kind: 'difference', left, right };
}

function parseQuotient(obj) {
  const { left, right } = parseTwoChildren(obj);
  return { kind: 'quotient', left, right };
}

function parsePow(obj) {
  const { left, right } = parseTwoChildren(obj);
  return { kind: 'pow', base: left, exponent: right };
}

function parseAtan2(obj) {
  const { left, right } = parseTwoChildren(obj);
  return { kind: 'atan2', y: left, x: right };
}

function parseUnary(op, obj) {
  const children = parseChildren(obj);
  return { kind: op, child: children[0] || { kind: 'value', value: 0 } };
}

function parseComparison(op, obj) {
  const { left, right } = parseTwoChildren(obj);
  return { kind: op, left, right };
}

function parseIfThen(obj) {
  const children = parseChildren(obj);
  return {
    kind: 'ifthen',
    cond: children[0] || { kind: 'value', value: 0 },
    then: children[1] || { kind: 'value', value: 0 },
    else: children[2] || { kind: 'value', value: 0 },
  };
}

function parseSwitch(obj) {
  const children = parseChildren(obj);
  if (children.length < 2) {
    return { kind: 'switch', index: { kind: 'value', value: 0 }, cases: [], default: { kind: 'value', value: 0 } };
  }
  return {
    kind: 'switch',
    index: children[0],
    cases: children.slice(1, -1),
    default: children[children.length - 1],
  };
}

function parseTable(tableObj) {
  if (!tableObj) return { kind: 'table', tableType: '1D', var1: '', var2: '', var3: '', data: [[0]], breakpoints1: [0], breakpoints2: [], breakpoints3: [] };

  // Parse independentVar elements
  const indVars = ensureArray(tableObj['independentVar']);
  let var1 = '', var2 = '', var3 = '';
  let tableType = '1D';

  for (const iv of indVars) {
    const text = extractText(iv);
    const lookup = iv['@_lookup'] || '';
    const tType = iv['@_tableType'] || '';

    if (tType === '2D' || tType === '3D') tableType = tType;

    if (!lookup || lookup === 'row') {
      var1 = text;
    } else if (lookup === 'column') {
      var2 = text;
      if (tableType === '1D') tableType = '2D';
    } else if (lookup === 'z' || (iv['@_axis'] === 'z')) {
      var3 = text;
      tableType = '3D';
    }
  }

  // Detect tableType from number of independentVars
  if (indVars.length >= 3) tableType = '3D';
  else if (indVars.length === 2) tableType = '2D';

  // Parse tableData
  const tableDataElements = ensureArray(tableObj['tableData']);
  const hasBreakpoints = tableDataElements.some(td => td && td['@_breakPoint'] !== undefined);

  if (hasBreakpoints) {
    tableType = '3D';
    return parseTableData3D(tableDataElements, var1, var2, var3);
  }

  if (tableDataElements.length > 0) {
    const tdText = extractText(tableDataElements[0]);
    const parsed = parseTableText(tdText);

    if (tableType === '2D' && parsed.rows.length > 1 && parsed.rows[0].length > 1) {
      return parse2DFromText(parsed, var1, var2);
    } else {
      return parse1DFromText(parsed, var1);
    }
  }

  // Empty table
  return {
    kind: 'table', tableType,
    var1, var2, var3,
    data: [[0]], breakpoints1: [0], breakpoints2: [], breakpoints3: [],
  };
}

function parseTableText(text) {
  if (!text || typeof text !== 'string') return { rows: [] };
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const vals = line.split(/[\s\t]+/).map(Number).filter(v => !isNaN(v));
    if (vals.length > 0) rows.push(vals);
  }
  return { rows };
}

function parse1DFromText(parsed, var1) {
  const breakpoints1 = [];
  const data = [];
  for (const row of parsed.rows) {
    if (row.length >= 2) {
      breakpoints1.push(row[0]);
      data.push([row[1]]);
    } else if (row.length === 1) {
      breakpoints1.push(0);
      data.push([row[0]]);
    }
  }
  if (breakpoints1.length === 0) { breakpoints1.push(0); data.push([0]); }
  return { kind: 'table', tableType: '1D', var1, var2: '', var3: '', data, breakpoints1, breakpoints2: [], breakpoints3: [] };
}

function parse2DFromText(parsed, var1, var2) {
  const headerRow = parsed.rows[0];
  const breakpoints2 = headerRow.slice(1);
  const breakpoints1 = [];
  const data = [];
  for (let r = 1; r < parsed.rows.length; r++) {
    const row = parsed.rows[r];
    breakpoints1.push(row[0]);
    data.push(row.slice(1));
  }
  return { kind: 'table', tableType: '2D', var1, var2, var3: '', data, breakpoints1, breakpoints2, breakpoints3: [] };
}

function parseTableData3D(tableDataElements, var1, var2, var3) {
  const breakpoints3 = [];
  let breakpoints1 = [];
  let breakpoints2 = [];
  let allData = [];

  for (const tdElem of tableDataElements) {
    if (!tdElem) continue;
    const bp = tdElem['@_breakPoint'] !== undefined ? Number(tdElem['@_breakPoint']) : 0;
    breakpoints3.push(bp);

    const tdText = extractText(tdElem);
    const parsed = parseTableText(tdText);

    if (parsed.rows.length > 0) {
      if (breakpoints2.length === 0) {
        breakpoints2 = parsed.rows[0].slice(1);
      }
      for (let r = 1; r < parsed.rows.length; r++) {
        const row = parsed.rows[r];
        if (breakpoints1.length < r) breakpoints1.push(row[0]);
        allData.push(row.slice(1));
      }
    }
  }

  if (breakpoints1.length === 0) breakpoints1 = [0];
  if (breakpoints2.length === 0) breakpoints2 = [0];
  if (allData.length === 0) allData = [[0]];

  return { kind: 'table', tableType: '3D', var1, var2, var3, data: allData, breakpoints1, breakpoints2, breakpoints3 };
}

module.exports = { exprToXml, xmlToExpr, parseTable, parseFuncGroup, parseTableText };
