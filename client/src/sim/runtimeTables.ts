import { getChildren } from '../utils/expressionConverter';
/** Keep the two imported table representations consistent for editing and Save. */
function synchronizeRawTablePatch(params: Record<string,any>, patch: Record<string,any>): Record<string,any> {
  if (!Array.isArray(params.tables)) return patch;
  const parse = (raw:any):any[] => { try { return typeof raw==='string' ? JSON.parse(raw) : raw || []; } catch { return []; } };
  if ('_tables' in patch && !('tables' in patch)) {
    const raw = parse(patch._tables);
    const tables = params.tables.map((item:any) => {
      const source = raw.find(table=>table.name===item.name), expr=item.expression;
      if (!source?.data?.length || expr?.kind!=='table') return item;
      const rows:number[][]=source.data;
      if (expr.tableType==='1D') return {...item,expression:{...expr,breakpoints1:rows.map(row=>row[0]),data:rows.map(row=>[row[1]])}};
      const grid = rows.slice(1).map(row=>row.slice(1));
      const bp2=rows[0].length===rows[1]?.length ? rows[0].slice(1) : rows[0];
      const data = expr.tableType==='3D' ? Array.from({length:expr.breakpoints3.length},(_,layer)=>
        layer===0 ? grid : grid.map((row,r)=>row.map((_,c)=>expr.data[layer*expr.breakpoints1.length+r]?.[c] ?? 0))).flat() : grid;
      return {...item,expression:{...expr,breakpoints1:rows.slice(1).map(row=>row[0]),breakpoints2:bp2,data}};
    });
    return {...patch,tables};
  }
  if ('tables' in patch && !('_tables' in patch) && Array.isArray(patch.tables)) {
    const raw = parse(params._tables).map((item:any)=>{
      const expr = patch.tables.find((table:any)=>table.name===item.name)?.expression;
      if (expr?.kind!=='table') return item;
      if (expr.tableType==='1D') return {...item,data:expr.breakpoints1.map((bp:number,r:number)=>[bp,expr.data[r]?.[0] ?? 0])};
      const corner = item.data?.[0]?.length===item.data?.[1]?.length;
      return {...item,data:[corner ? [0,...expr.breakpoints2] : expr.breakpoints2,
        ...expr.breakpoints1.map((bp:number,r:number)=>[bp,...expr.data[r]])]};
    });
    return {...patch,_tables:raw};
  }
  return patch;
}


export function synchronizeTablePatch(params:Record<string,any>, patch:Record<string,any>):Record<string,any> {
  const result=synchronizeRawTablePatch(params,patch);
  if(!Array.isArray(params.functions) || !Array.isArray(params.tables))return result;
  const functions=structuredClone(result.functions || params.functions);
  const tables=structuredClone(result.tables || params.tables);
  const locate=(item:any)=> {
    const fn=functions.find((fn:any)=>fn.name===item.function_owner);
    let node=fn?.expression;
    for(const index of (item.function_path || []).slice(1)) node=node && getChildren(node)[index];
    return node;
  };
  if('functions' in result) {
    for(const table of tables) { const node=locate(table);if(node?.kind==='table')table.expression=structuredClone(node); }
  } else if('tables' in result) {
    for(const table of tables) { const node=locate(table);if(node?.kind==='table')Object.assign(node,structuredClone(table.expression)); }
  } else return result;
  return {...synchronizeRawTablePatch(params,Object.fromEntries(Object.entries({...result,tables}).filter(([key])=>key!=='_tables'))),functions};
}
