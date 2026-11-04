// Coordinate and data preservation tests; no simulator connection.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const dir = await mkdtemp(path.join(tmpdir(), 'lut-data-'));
try {
  const output = path.join(dir, 'table.cjs');
  await build({entryPoints:[fileURLToPath(new URL('../client/src/utils/tableData.ts',import.meta.url))],outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const { tableSlice, tableValue, setTableValue, resizeTableAxis, convertTableDimension, validateTable,
    pasteTableValues, expressionTables, formatTableNumber, valueColor } = createRequire(import.meta.url)(output);
  const table = {kind:'table',tableType:'3D',var1:'aero/alpha',var2:'fcs/elevator',var3:'velocities/mach',
    breakpoints1:[-2,0,5],breakpoints2:[-1,2],breakpoints3:[0,.8],
    data:[[0,1],[10,11],[20,21],[100,101],[110,111],[120,121]]};
  const original = JSON.stringify(table);
  assert.deepEqual(validateTable(table), []);
  assert.deepEqual(tableSlice(table,2,1).values, [[100,101],[110,111],[120,121]]);
  assert.deepEqual(tableSlice(table,0,1).values, [[10,110],[11,111]]);
  assert.deepEqual(tableSlice(table,1,1).values, [[1,101],[11,111],[21,121]]);
  for (const axis of [0,1,2]) {
    const view = tableSlice(table,axis,1);
    const target = view.pointAt(1,1);
    const changed = setTableValue(table,target,-.0000123456789);
    assert.equal(tableValue(changed,target),-.0000123456789);
    assert.equal(JSON.stringify(table),original,'editing never mutates its source');
    const appended = resizeTableAxis(table,axis);
    const key = `breakpoints${axis+1}`;
    assert.equal(appended[key].length,table[key].length+1);
    for (let z=0;z<2;z++) for(let r=0;r<3;r++) for(let c=0;c<2;c++) {
      assert.equal(tableValue(appended,[r,c,z]),tableValue(table,[r,c,z]),'appending preserves all existing cells');
    }
    const trimmed = resizeTableAxis(appended,axis,appended[key].length-1);
    assert.deepEqual(trimmed,table,'removing the appended boundary restores the full table');
    const removed = resizeTableAxis(table,axis,0);
    for (let z=0;z<removed.breakpoints3.length;z++) for(let r=0;r<removed.breakpoints1.length;r++) for(let c=0;c<removed.breakpoints2.length;c++) {
      const old=[r,c,z];old[axis]++;
      assert.equal(tableValue(removed,[r,c,z]),tableValue(table,old),'removing maps the remaining coordinates correctly');
    }
    const pasted = pasteTableValues(table,axis,1,0,0,'-1e-3\t2\n3\t4');
    assert.equal(tableValue(pasted,view.pointAt(0,0)),-.001);
    assert.equal(tableValue(pasted,view.pointAt(1,1)),4);
    const other = [...view.pointAt(0,0)];other[axis]=0;
    assert.equal(tableValue(pasted,other),tableValue(table,other),'bulk paste only changes the active plane');
  }
  for(const text of ['\t1','1\t','1\t\t2','1\tNaN','1\tInfinity','1\t2\n3','1\t2\t3','1\t2\n3\t4\n5\t6\n7\t8']) {
    assert.throws(()=>pasteTableValues(table,2,0,0,0,text));
    assert.equal(JSON.stringify(table),original,'invalid paste cannot partially modify data');
  }
  assert.equal(formatTableNumber(.0000000123456789),'1.23456789e-8');
  assert.equal(tableValue(pasteTableValues(table,2,0,0,0,'1, 2\r\n3, 4\r\n'),[1,1,0]),4);
  const plane=convertTableDimension(table,'2D',[1,1,1]);
  assert.deepEqual(plane.data,table.data.slice(3));assert.equal(plane.var3,'');
  const line=convertTableDimension(table,'1D',[1,1,1]);
  assert.deepEqual(line.data,[[101],[111],[121]]);assert.equal(line.var2,'');
  const expanded=convertTableDimension(line,'3D',[0,0,0]);
  assert.deepEqual(expanded.data,[[101,101],[111,111],[121,121],[101,101],[111,111],[121,121]]);
  assert.match(validateTable({...table,breakpoints1:[0,0,1]}).join(),/严格递增/);
  assert.match(validateTable({...table,data:table.data.slice(1)}).join(),/数量/);
  assert.match(validateTable({...table,var3:''}).join(),/自变量/);
  const expression={kind:'ifthen',cond:{kind:'value',value:1},then:{kind:'pow',base:table,exponent:{kind:'value',value:2}},
    else:{kind:'switch',index:{kind:'value',value:0},cases:[table],default:table}};
  const entries=expressionTables(expression);assert.equal(entries.length,3);
  const replaced=entries[1].replace({...table,var1:'new/signal'});
  assert.equal(replaced.else.cases[0].var1,'new/signal');assert.equal(replaced.then.base.var1,table.var1);
  assert.equal(replaced.else.default.var1,table.var1);
  assert.equal(valueColor(5,5,5),valueColor(10,0,20),'constant tables use the middle of the scale');
  console.log('PASS: all slice orientations, immutable edits, axis resize across layers, transactional paste, dimensional conversion, validation and nested table replacement.');
} finally {await rm(dir,{recursive:true,force:true});}
