import { windProfileEdits, windProfileError, type WindProfile } from './windProfile';
import type { ExprNode } from '../types';
import { getChildren } from '../utils/expressionConverter';
import { expressionMonitorKey, monitorHash } from './monitorIdentity';
import { convertUnit } from '../utils/unitConverter';
import xmlUnits from './runtimeUnitFactors.json';
import type { RuntimeEdit } from './runtimeTuningApi';
export const environmentFields = [
  ['pressure_sl_psf', 'pressureSlPsf', 'atmosphere/P-sl-psf', 'PSF'],
  ['temperature_bias_r', 'temperatureBiasR', 'atmosphere/delta-T', 'R'],
  ['relative_humidity_pct', 'relativeHumidityPct', 'atmosphere/RH', '%'],
  ['wind_north_fps', 'windNorthFps', 'atmosphere/wind-north-fps', 'FT/SEC'],
  ['wind_east_fps', 'windEastFps', 'atmosphere/wind-east-fps', 'FT/SEC'],
  ['wind_down_fps', 'windDownFps', 'atmosphere/wind-down-fps', 'FT/SEC'],
  ['turbulence_type', 'turbulenceType', 'atmosphere/turb-type', ''],
  ['turbulence_windspeed_20ft_fps', 'turbulenceWindspeed20ftFps', 'atmosphere/turbulence/milspec/windspeed_at_20ft_AGL-fps', 'FT/SEC'],
  ['turbulence_severity', 'turbulenceSeverity', 'atmosphere/turbulence/milspec/severity', ''],
] as const;
const numeric = (value: any): number | undefined => {
  if (value == null || String(value).trim() === '' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value).trim())) return;
  const n = Number(value); return Number.isFinite(n) ? n : undefined;
};
const booleanNumeric=(value:any):number|undefined => value===true || value==='true' ? 1 : value===false || value==='false' ? 0 : numeric(value);
export const componentParameterKey = (owner: string, field: string) => `_tuning/component/n${monitorHash(owner + ':' + field)}`;
const runtimeConvert = (value: number, source: string, target: string): number | undefined => {
  if (!target || source === target) return value;
  const factor = (xmlUnits.factors as Record<string, Record<string,number>>)[source]?.[target];
  return factor === undefined ? undefined : value * factor;
};
export function tableParameters(key: string, table: any): RuntimeEdit[] {
  const edits: RuntimeEdit[] = [];
  const add = (prefix: string, index: number, value: number) => { if (Number.isFinite(value)) edits.push({ key:`${prefix}/data/n${index}`, value }); };
  const rows = table.breakpoints1?.length || 0, columns = table.breakpoints2?.length || 0;
  if (table.tableType === '1D') {
    table.data.forEach((row: number[], r: number) => { add(key,2+r*2,table.breakpoints1[r]); add(key,3+r*2,row[0]); });
  } else if (table.tableType === '2D' || table.tableType === '3D') {
    const layers = table.tableType === '3D' ? table.breakpoints3.length : 1;
    for(let layer=0; layer<layers; ++layer) {
      const prefix = table.tableType === '3D' ? `${key}/sub/i${layer}` : key;
      if (table.tableType === '3D') add(key,layer+1,table.breakpoints3[layer]);
      table.breakpoints2.forEach((value:number,c:number)=>add(prefix,c+1,value));
      for(let r=0; r<rows; ++r) {
        add(prefix,(r+1)*(columns+1),table.breakpoints1[r]);
        for(let c=0; c<columns; ++c) add(prefix,(r+1)*(columns+1)+c+1,table.data[layer*rows+r]?.[c]);
      }
    }
  }
  return edits;
}
function componentTable(field: any): any {
  const children=field?.children || [], vars=children.filter((child:any)=>child.name==='independentVar');
  const blocks=children.filter((child:any)=>child.name==='tableData');
  const rows=(block:any):number[][]=>String(block.value || '').trim().split(/\r?\n/).filter(Boolean).map(line=>line.trim().split(/\s+/).map(Number));
  if (!blocks.length) return;
  const first=rows(blocks[0]);if(!first.length || first.some(row=>row.some(value=>!Number.isFinite(value)))) return;
  const type=blocks.length>1 ? '3D' : first.every(row=>row.length===2) && vars.length<=1 ? '1D' : '2D';
  const name=(axis:string)=>vars.find((item:any)=>(item.attrs?.lookup || 'row')===axis)?.value || '';
  if(type==='1D') return {kind:'table',tableType:type,var1:name('row'),var2:'',var3:'',breakpoints1:first.map(row=>row[0]),breakpoints2:[],breakpoints3:[],data:first.map(row=>[row[1]])};
  const bp2=first[0].length===first[1]?.length ? first[0].slice(1) : first[0];
  return {kind:'table',tableType:type,var1:name('row'),var2:name('column'),var3:name('table'),breakpoints1:first.slice(1).map(row=>row[0]),breakpoints2:bp2,
    breakpoints3:type==='3D'?blocks.map((block:any)=>Number(block.attrs?.breakPoint)):[],data:blocks.flatMap((block:any)=>rows(block).slice(1).map(row=>row.slice(1)))};
}
export function expressionParameters(owner: string, expression: ExprNode): RuntimeEdit[] {
  const result: RuntimeEdit[] = [];
  const visit = (node: ExprNode, path: number[]) => {
    if (node.kind === 'value' && Number.isFinite(node.value)) result.push({ key: expressionMonitorKey(owner, path).replace('_monitor/', '_tuning/'), value: node.value });
    if (node.kind === 'table') result.push(...tableParameters(expressionMonitorKey(owner,path).replace('_monitor/','_tuning/')+'/table',node));
    getChildren(node).forEach((child, index) => visit(child, [...path, index]));
  };
  visit(expression, [0]); return result;
}
export const expressionShape = (expression: any) => JSON.stringify(expression, (key, value) => {
  if (key === 'value' && typeof value === 'number') return 0;
  if (['data','breakpoints1','breakpoints2','breakpoints3'].includes(key) && Array.isArray(value)) {
    const zero = (item:any):any => Array.isArray(item) ? item.map(zero) : typeof item === 'number' ? 0 : item;
    return zero(value);
  }
  return value;
});
export type EnvironmentConfig = Record<string, any> & { windProfile?: WindProfile };
export function environmentFromProject(project: { nodes: any[] }): EnvironmentConfig | null {
  const node = project.nodes.find(node => node.data.componentType === 'environment');
  if (!node) return null;
  const result: EnvironmentConfig = Object.fromEntries(environmentFields.flatMap(([field, configKey, , unit]) => {
    const raw = node.data.params[field], value = numeric(raw?.value ?? raw);
    return value === undefined ? [] : [[configKey, raw?.unit && unit ? convertUnit(value, raw.unit, unit) : value]];
  }));
  if (node.data.params.wind_profile) result.windProfile = structuredClone(node.data.params.wind_profile);
  return result;
}
export const environmentEdits = (environment: EnvironmentConfig): RuntimeEdit[] => environmentFields.flatMap(([, field, key]) =>
  Number.isFinite(environment[field]) && !(environment.windProfile?.active && field.startsWith('wind')) ? [{ key, value: environment[field] }] : []);
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined && !(key === 'attrs' && value[key] && !Object.keys(value[key]).length))
    .map(key => [key, canonical(value[key])]));
}
export const inertiaFields = ['ixx', 'iyy', 'izz', 'ixy', 'ixz', 'iyz'] as const;
export const inertiaParameterKey = (field: typeof inertiaFields[number]) => `_tuning/inertia/${field}-slugs_ft2`;
interface Group { shape: string; edits: RuntimeEdit[]; environment?: boolean; inertia?: boolean }
type Project = { nodes: any[]; edges?: any[] };
const scalarFields: Record<string, Record<string, string>> = {
  fuselage: { emptywt: 'LBS' },
  wing: { wingarea: 'FT2', wingspan: 'FT', chord: 'FT', wing_incidence: 'RAD' },
  htail: { htailarea: 'FT2', htailarm: 'FT' }, vtail: { vtailarea: 'FT2', vtailarm: 'FT' },
  point_mass: { weight: 'LBS', radius: 'FT', length: 'FT' },
  landing_gear: { static_friction: '', dynamic_friction: '', rolling_friction: '', spring_coeff: 'LBS/FT', damping_coeff: 'LBS/FT/SEC', damping_coeff_rebound: 'LBS/FT/SEC', max_steer: 'DEG', retractable:'' },
  fuel_tank: { capacity: 'LBS', contents: 'LBS', density: 'LBS/GAL', radius: 'IN', inertia_factor: '', standpipe: 'LBS', 'unusable-volume': 'GAL', priority: '' },
  propeller: { ixx: 'SLUG*FT2', diameter: 'FT', gearratio: '', minpitch: '', maxpitch: '', minrpm: '', maxrpm: '', ct_factor: '', cp_factor: '', reverse_ct_factor: '', reverse_cp_factor: '', p_factor: '', sense: '', reversepitch: '', numblades: '', area: 'FT2' },
};
const engineFields: Record<string, Record<string, string>> = {
  electric: { power: 'WATTS' }, brushless_dc: { maxvolts: 'VOLTS', velocityconstant: '', coilresistance: 'OHMS', noloadcurrent: 'AMPERES', brake_on_stop:'' },
  turbine: { milthrust: 'LBS', maxthrust: 'LBS', bleed: '', idlen1: '', maxn1: '', idlen2: '', maxn2: '', ignitionn1: '', ignitionn2: '', n1spinup: '', n2spinup: '', n1startrate: '', n2startrate: '', n1spindown: '', n2spindown: '', 'injection-time': '', 'injection-N1-inc': '', 'injection-N2-inc': '', bypassratio:'', tsfc:'', atsfc:'' },
  turboprop: { idlen1: '', maxn1: '', maxpower: '', psfc: '', n1idle_max_delay: '', maxstartingtime: '', startern1: '', ielumaxtorque: '', itt_delay: '', betarangeend:'', reversemaxpower:'' },
  piston: { maxhp:'HP', idlerpm:'', maxrpm:'', minmp:'INHG', maxmp:'INHG', 'man-press-lag':'', displacement:'IN3', 'static-friction':'HP', cycles:'', 'volumetric-efficiency':'', 'compression-ratio':'', bore:'IN', stroke:'IN', cylinders:'', 'cylinder-head-mass':'KG', 'ram-air-factor':'', 'cooling-factor':'', 'dynamic-fmep':'PA', 'static-fmep':'PA', 'peak-piston-speed':'', bsfc:'LBS/HP*HR', 'air-intake-impedance-factor':'' },
  rocket: { isp:'', builduptime:'', minthrottle:'', maxthrottle:'', propflowmax:'LBS/SEC', mixtureratio:'' },
};
Object.assign(engineFields.piston,{ 'starter-rpm':'','starter-torque':'','oil-pressure-relief-valve-psi':'PSI','design-oil-temp-degK':'DEGK','oil-viscosity-index':'','oil-pressure-rpm-max':'',sparkfaildrop:'',minthrottle:'',maxthrottle:'',takeoffboost:'PSI','boost-loss-factor':'' },
  ...[1,2,3].map(index=>({['ratedboost'+index]:'PSI',['ratedpower'+index]:'HP',['ratedrpm'+index]:'',['ratedaltitude'+index]:'FT'})));
const systemFields: Record<string, string[]> = {
  pure_gain: ['gain'], scheduled_gain: ['gain'], aerosurface_scale: ['gain'], pid: ['kp','ki','kd'],
  summer: ['bias'], deadband: ['width','gain'], actuator: ['lag','bias','deadband_width','hysteresis_width'],
  sensor:['bias','gain','drift_rate','lag','noise'], accelerometer:['bias','gain','drift_rate','lag','noise'], gyro:['bias','gain','drift_rate','lag','noise'], magnetometer:['bias','gain','drift_rate','lag','noise'],
  linear_actuator:['module','hysteresis','lag','rate','gain','bias'],
  lag_filter: ['c1'], washout_filter: ['c1'], lead_lag_filter: ['c1','c2','c3','c4'], second_order_filter: ['c1','c2','c3','c4','c5','c6'],
};
function groups(project: Project): Map<string, Group> {
  const result = new Map<string, Group>();
  const active = (type: string) => project.nodes.filter(node => node.data.componentType === type && !node.data.params.disabled);
  const engines = active('engine'), propellers = active('propeller');
  const physicalNodes=project.nodes.filter(node => ['engine','propeller','fuel_tank','landing_gear','point_mass'].includes(node.data.componentType));
  const topology = JSON.stringify({nodes:physicalNodes.map(node => [node.id, node.data.componentType, !!node.data.params.disabled, node.data.params.file]),
    links:project.edges?.filter(edge=>physicalNodes.some(node=>node.id===edge.source) && physicalNodes.some(node=>node.id===edge.target)).map(edge=>[edge.source,edge.target,edge.sourceHandle,edge.targetHandle]) || []});
  for (const node of project.nodes) {
    const p = node.data.params;
    if (p.disabled) continue;
    const type = node.data.componentType;
    if (scalarFields[type] || type === 'engine') {
      const edits: RuntimeEdit[] = [], clone = JSON.parse(JSON.stringify(p));
      const index = active(type).findIndex(item => item.id === node.id);
      const metrics = ['wing','htail','vtail'].includes(type);
      const unique = !(metrics || type === 'fuselage') || active(type).length === 1;
      let prefix = metrics ? '_tuning/metrics' : type === 'fuselage' ? '_tuning/mass'
        : `_tuning/${({ point_mass:'pointmass', landing_gear:'gear', fuel_tank:'tank', propeller:'thruster' } as Record<string,string>)[type] || 'engine'}/i${index}`;
      if (type === 'propeller') {
        const edge = project.edges?.find(edge => edge.source === node.id && engines.some(engine => engine.id === edge.target) || edge.target === node.id && engines.some(engine => engine.id === edge.source));
        const engineIndex = edge ? engines.findIndex(engine => engine.id === (edge.source === node.id ? edge.target : edge.source)) : index;
        prefix = `_tuning/thruster/i${Number.isInteger(p._runtime_index) ? p._runtime_index : engineIndex}`;
      }
      if (type === 'engine' && project.edges?.some(edge => (edge.source===node.id || edge.target===node.id) && propellers.some(prop => prop.id===(edge.source===node.id?edge.target:edge.source)))) delete clone.location;
      for (const [field, defaultUnit] of Object.entries(unique ? type === 'engine' ? engineFields[p.engine_type] || {} : scalarFields[type] : {})) {
        const raw = p[field], value = (['retractable','brake_on_stop'].includes(field)?booleanNumeric:numeric)(raw?.value ?? raw);
        if (value === undefined) continue;
        const unit = field.startsWith('damping_coeff') && raw?.unit?.includes('2/SEC2') ? 'LBS/FT2/SEC2' : defaultUnit;
        const source = raw?.unit || p[`${field}_unit`] || (field === 'wing_incidence' ? 'DEG' : unit);
        const normalized = runtimeConvert(value, source, unit);
        if (normalized === undefined) continue;
        edits.push({ key: `${prefix}/${field}`, value: normalized }); clone[field] = '#tunable'; delete clone[`${field}_unit`];
      }
      if(type==='landing_gear') {
        const brake={NONE:0,LEFT:1,RIGHT:2,CENTER:3,NOSE:3,TAIL:3}[String(p.brake_group?.value ?? p.brake_group) as 'NONE'];
        if(brake!==undefined){edits.push({key:prefix+'/brake_group',value:brake});clone.brake_group='#tunable';}
      }
      const vectorFields = type === 'fuselage' ? [['cg','cg','IN']] : type === 'wing' ? [['location','aerorp','IN']]
        : ['point_mass','landing_gear','fuel_tank','propeller'].includes(type) ? [['location','location','IN'], ...(type === 'fuel_tank' ? [['drain_location','drain_location','IN']] : [])] : [];
      // A thruster owns its physical location; an engine's inline location is ignored by JSBSim.
      if (unique) for (const [field, key, unit] of vectorFields) {
        const raw = p[field], value = raw?.value ?? raw;
        if (!value || ['x','y','z'].some(axis => numeric(value[axis]) === undefined)) continue;
        const values = ['x','y','z'].map(axis => runtimeConvert(Number(value[axis]), raw.unit || unit, unit));
        if (values.some(value=>value === undefined)) continue;
        ['x','y','z'].forEach((axis,i) => edits.push({ key: `${prefix}/${key}-${axis}`, value: values[i]! }));
        clone[field] = '#tunable';
      }
      const functionOwner=(name:string)=> {
        const local = p.engine_type==='turbine' && ['IdleThrust','MilThrust','AugThrust','Injection','N1SpoolUp','N1SpoolDown','N2SpoolUp','N2SpoolDown'].includes(name)
          || p.engine_type==='turboprop' && name==='EnginePowerVC';
        return (local ? `propulsion/engine[${index}]/${name}` : name).replace('#',String(index));
      };
      if (Array.isArray(p.functions)) {
        for (const fn of p.functions) if(fn.name && fn.expression) edits.push(...expressionParameters(functionOwner(fn.name),fn.expression));
        clone.functions=p.functions.map((fn:any)=>({...fn,expression:expressionShape(fn.expression)}));
      }
      if (Array.isArray(p.tables)) {
        clone.tables = p.tables.map((table:any)=> {
          if(table.expression?.kind!=='table') return table;
          const key=table.function_owner ? expressionMonitorKey(functionOwner(table.function_owner),table.function_path).replace('_monitor/','_tuning/')
            : table.name ? `_tuning/table/${type==='propeller'?'thruster':'engine'}/${prefix.split('/').pop()}/${table.name}` : '';
          if(!key) return table; // Unknown owners remain explicit reload-only edits.
          edits.push(...tableParameters(key+'/table',table.expression));
          return {...table,expression:expressionShape(table.expression)};
        });
        if (clone._tables) clone._tables = '#tables';
      }
      result.set(node.id, { shape: JSON.stringify(canonical({ params:clone, topology: metrics || type==='fuselage' ? active(type).map(n=>n.id) : topology })), edits });
      continue;
    }
    if (node.data.componentType === 'inertia') {
      // Exactly one base inertia tensor exists in each loaded aircraft.
      if (project.nodes.filter(item => item.data.componentType === 'inertia' && !item.data.params.disabled).length !== 1) continue;
      const edits: RuntimeEdit[] = [];
      for (const field of inertiaFields) {
        const fallback = ['ixy', 'ixz', 'iyz'].includes(field) ? 0 : undefined;
        const raw = p[field], value = numeric(raw?.value ?? raw ?? fallback);
        const unit = raw?.unit || p[`${field}_unit`] || 'SLUG*FT2';
        if (value === undefined || !['SLUG*FT2', 'KG*M2'].includes(unit)) break;
        // Match JSBSim's XML converter, including its existing precision.
        edits.push({ key: inertiaParameterKey(field), value: unit === 'KG*M2' ? value / 1.35594 : value });
      }
      if (edits.length === 6) result.set(node.id, { shape: 'base-inertia', edits, inertia: true });
      continue;
    }
    if (node.data.componentType === 'environment') {
      const env = environmentFromProject({ nodes: [node] });
      result.set(node.id, { shape: String(p.atmosphere_model), edits: environmentEdits(env || {}), environment: true }); continue;
    }
    if (node.data.componentType === 'aero_coefficients') {
      try {
        const coefficients = typeof p.coefficients === 'string' ? JSON.parse(p.coefficients) : p.coefficients;
        for (const item of coefficients || []) if (!item.disabled && item.name && item.expression) result.set(`${node.id}:${item.name}`, {
          shape: JSON.stringify({ ...item, expression: expressionShape(item.expression) }), edits: expressionParameters(item.name, item.expression),
        });
      } catch {}
      continue;
    }
    let channels: any[];
    try { channels = typeof p.channels === 'string' ? JSON.parse(p.channels) : p.channels; } catch { continue; }
    if (!Array.isArray(channels)) continue;
    const items = (list: any[]) => { for (const item of list) {
      if (item.disabled) continue;
      if (Array.isArray(item.items)) items(item.items);
      if (!item.name) continue;
      const edits: RuntimeEdit[] = [], clone = JSON.parse(JSON.stringify(item));
      const add = (field: string, value: any, clear: () => void) => { const n = numeric(value); if (n !== undefined) { edits.push({ key: componentParameterKey(item.name, field), value: n }); clear(); } };
      if (systemFields[item.type]) {
        for (const field of systemFields[item.type]) {
          if (item.componentProps?.[field]) add(field, item.componentProps[field].value, () => { clone.componentProps[field].value = '#tunable'; });
          else if (field.startsWith('rate_limit-')) {
            const sense = field.slice('rate_limit-'.length);
            const entry = item.componentProps?.rate_limit?.children?.find((part: any) => part.attrs?.sense?.startsWith(sense));
            if (entry) add(field, entry.value, () => { clone.componentProps.rate_limit.children.find((part:any)=>part.attrs?.sense?.startsWith(sense)).value='#tunable'; });
          }
        }
      }
      const nested=(field:string,names:string[],unit='')=>{
        for(const name of names) {
          const source=item.componentProps?.[field]?.children?.find((child:any)=>child.name===name);
          const value=numeric(source?.value);if(value===undefined)continue;
          const normalized=runtimeConvert(value,item.componentProps[field].attrs?.unit || unit,unit);if(normalized===undefined)continue;
          add(field+'-'+name,normalized,()=>{clone.componentProps[field].children.find((child:any)=>child.name===name).value='#tunable';});
        }
      };
      if(item.type==='aerosurface_scale') {nested('domain',['min','max']);nested('range',['min','max']);}
      if(item.type==='aerosurface_scale' && item.componentProps?.zero_centered) {
        add('zero_centered',booleanNumeric(item.componentProps.zero_centered.value),()=>{clone.componentProps.zero_centered.value='#tunable';});
      }
      if(['sensor','accelerometer','gyro','magnetometer'].includes(item.type)) nested('quantization',['bits','min','max']);
      if(['accelerometer','gyro','magnetometer'].includes(item.type)) nested('orientation',['roll','pitch','yaw'],'RAD');
      if(['accelerometer','gyro','magnetometer'].includes(item.type) && item.componentProps?.axis) {
        add('axis',{X:1,Y:2,Z:3}[String(item.componentProps.axis.value).toUpperCase() as 'X'],()=>{clone.componentProps.axis.value='#tunable';});
      }
      if(['accelerometer','magnetometer'].includes(item.type)) nested('location',['x','y','z'],'IN');
      if(item.type==='actuator' && item.componentProps?.rate_limit) {
        const source=item.componentProps.rate_limit, target=clone.componentProps.rate_limit;
        [source,...source.repeated || []].forEach((entry:any,i:number)=>{
          const key=entry.attrs?.sense ? 'rate_limit-'+String(entry.attrs.sense).slice(0,4) : 'rate_limit';
          add(key,entry.value,()=>{(i===0?target:target.repeated[i-1]).value='#tunable';});
        });
      }
      if(item.type==='kinematic') item.componentProps?.traverse?.children?.forEach((setting:any,i:number)=>{
        for(const field of ['position','time']) {
          const value=setting.children?.find((child:any)=>child.name===field)?.value;
          add(`traverse-${i}-${field}`,value,()=>{clone.componentProps.traverse.children[i].children.find((child:any)=>child.name===field).value='#tunable';});
        }
      });
      if(item.type==='switch') for(const field of ['default','test']) {
        const source=item.componentProps?.[field];if(!source)continue;
        [source,...source.repeated || []].forEach((entry:any,i:number)=>add(field==='default'?'default-value':`test-${i}-value`,entry.attrs?.value,
          ()=>{(i===0?clone.componentProps[field]:clone.componentProps[field].repeated[i-1]).attrs.value='#tunable';}));
      }
      if(item.type==='scheduled_gain' && item.componentProps?.table) {
        const table=componentTable(item.componentProps.table);
        if(table) {edits.push(...tableParameters(componentParameterKey(item.name,'table')+'/table',table));clone.componentProps.table={attrs:item.componentProps.table.attrs,shape:expressionShape(table)};}
      }
      for (const [field, property] of [['clip-min', 'cliptoMin'], ['clip-max', 'cliptoMax']]) {
        if (item[property] !== undefined) add(field, item[property], () => { clone[property] = '#tunable'; });
        else if (item.componentProps?.[field === 'clip-min' ? 'clipto_min' : 'clipto_max']) {
          const flat = field === 'clip-min' ? 'clipto_min' : 'clipto_max';
          add(field, item.componentProps[flat].value, () => { clone.componentProps[flat].value = '#tunable'; });
        } else {
          const part = field === 'clip-min' ? 'min' : 'max';
          const entry = item.componentProps?.clipto?.children?.find((child: any) => child.name === part);
          if (entry) add(field, entry.value, () => { clone.componentProps.clipto.children.find((child: any) => child.name === part).value = '#tunable'; });
        }
      }
      if (item.type === 'constant') {
        const value = numeric(item.componentProps?.constant?.value);
        if (value !== undefined) { edits.push(...expressionParameters(item.name, { kind: 'value', value })); clone.componentProps.constant.value = '#tunable'; }
      }
      if (['function', 'fcs_function', 'aero_table'].includes(item.type)) {
        if (item.expression) { edits.push(...expressionParameters(item.name, item.expression)); clone.expression = expressionShape(item.expression); }
      } else {
        // The XML parser attaches a placeholder expression to ordinary FCS
        // components. The canvas correctly omits it on commit because their
        // XML is generated from componentProps. It is neither a structural
        // change nor a tunable literal in the running component.
        delete clone.expression;
      }
      // Identity and structure remain stable; geometry/layout does not affect the FDM.
      result.set(`${node.id}:${item.name}`, { shape: JSON.stringify(canonical(clone)), edits });
    } };
    items(channels);
  }
  return result;
}
/** A group containing structural edits is never mapped onto a running expression. */
export function projectRuntimeParameters(project: Project): RuntimeEdit[] {
  const all = [...groups(project).values()].flatMap(group=>group.edits);
  for (const node of project.nodes) if (node.data.componentType === 'environment' && node.data.params.wind_profile)
    all.push(...windProfileEdits(node.data.params.wind_profile));
  return [...new Map(all.map(edit=>[edit.key,edit])).values()];
}
export function projectParameterChanges(before: Project, after: Project, running: Project = before): RuntimeEdit[] {
  const old = groups(before), next = groups(after), original = groups(running), result: RuntimeEdit[] = [];
  for (const [id, group] of next) {
    const previous = old.get(id);
    if (!previous || previous.shape !== group.shape || (!group.environment && original.get(id)?.shape !== group.shape)) continue;
    const values = new Map(previous.edits.map(edit => [edit.key, edit.value]));
    const changed = group.edits.filter(edit => values.has(edit.key) && (group.inertia || !edit.key.startsWith('_tuning/component/')
      ? Math.abs(values.get(edit.key)! - edit.value) > 1e-10 * Math.max(Math.abs(edit.value), Math.abs(values.get(edit.key)!), 1e-12)
      : values.get(edit.key) !== edit.value));
    if (changed.length) {
      if (group.inertia) { result.push(...group.edits); continue; }
      result.push(...changed);
      // Both limits are sent together, without resending unrelated constants.
      if (changed.some(edit => group.edits.some(other => other.key !== edit.key && other.key.startsWith('_tuning/component/')))) {
        const itemName = id.slice(id.indexOf(':') + 1);
        const minKey = componentParameterKey(itemName, 'clip-min'), maxKey = componentParameterKey(itemName, 'clip-max');
        if (changed.some(edit => edit.key === minKey || edit.key === maxKey)) result.push(...group.edits.filter(edit => edit.key === minKey || edit.key === maxKey));
      }
    }
  }
  for (const node of after.nodes) {
    if (node.data.componentType !== 'environment') continue;
    const previous = before.nodes.find(item => item.id === node.id);
    const profile = node.data.params.wind_profile;
    if (previous && profile && !windProfileError(profile) && (JSON.stringify(profile) !== JSON.stringify(previous.data.params.wind_profile) ||
        !profile.active && ['wind_north_fps', 'wind_east_fps', 'wind_down_fps'].some(key => JSON.stringify(node.data.params[key]) !== JSON.stringify(previous.data.params[key])))) {
      result.push(...windProfileEdits(profile));
      if (!profile.active) result.push(...environmentEdits(environmentFromProject({ nodes: [node] }) || {}).filter(edit => edit.key.startsWith('atmosphere/wind-')));
    }
  }
  return [...new Map(result.map(edit => [edit.key, edit])).values()];
}
/** Report edits that cannot be mapped to the loaded component graph. */
export function projectParameterDiagnostics(before: Project, after: Project, running: Project = before): string[] {
  const previous = groups(before), next = groups(after), loaded = groups(running), reasons = new Set<string>();
  for (const node of after.nodes) {
    if (['scope'].includes(node.data.componentType)) continue;
    const oldNode = before.nodes.find(item=>item.id===node.id);
    if (!oldNode) { reasons.add(`${node.data.label || node.data.componentType}：新增组件需重新加载`); continue; }
    if (JSON.stringify(canonical(node.data.params)) === JSON.stringify(canonical(oldNode.data.params))) continue;
    const ids = [...new Set([...previous.keys(),...next.keys()])].filter(id=>id===node.id || id.startsWith(node.id+':'));
    if (!ids.length || ids.some(id=>previous.get(id)?.shape !== next.get(id)?.shape || loaded.get(id)?.shape !== next.get(id)?.shape))
      reasons.add(`${node.data.label || node.data.componentType}：结构或尚未支持的参数已保留，需重新加载`);
  }
  if (before.nodes.some(node=>node.data.componentType!=='scope' && !after.nodes.some(item=>item.id===node.id))) reasons.add('删除组件需重新加载');
  return [...reasons];
}
export function projectModelNames(project: any): string[] {
  const main = project.xmlFiles?.find((file: any) => file.category === 'main');
  const directory = main?.path.match(/^aircraft\/([^/]+)\//)?.[1];
  return [directory, project.aircraft?.name].filter(Boolean);
}
