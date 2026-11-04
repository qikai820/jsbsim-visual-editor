import type { ExprNode } from '../types';
import { getChildren } from '../utils/expressionConverter';
import { expressionMonitorKey, monitorHash } from './monitorIdentity';
import { convertUnit } from '../utils/unitConverter';
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
export const componentParameterKey = (owner: string, field: string) => `_tuning/component/n${monitorHash(owner + ':' + field)}`;
export function expressionParameters(owner: string, expression: ExprNode): RuntimeEdit[] {
  const result: RuntimeEdit[] = [];
  const visit = (node: ExprNode, path: number[]) => {
    if (node.kind === 'value' && Number.isFinite(node.value)) result.push({ key: expressionMonitorKey(owner, path).replace('_monitor/', '_tuning/'), value: node.value });
    getChildren(node).forEach((child, index) => visit(child, [...path, index]));
  };
  visit(expression, [0]); return result;
}
export const expressionShape = (expression: any) => JSON.stringify(expression, (key, value) => key === 'value' && typeof value === 'number' ? 0 : value);
export function environmentFromProject(project: { nodes: any[] }): Record<string, number> | null {
  const node = project.nodes.find(node => node.data.componentType === 'environment');
  if (!node) return null;
  return Object.fromEntries(environmentFields.flatMap(([field, configKey, , unit]) => {
    const raw = node.data.params[field], value = numeric(raw?.value ?? raw);
    return value === undefined ? [] : [[configKey, raw?.unit && unit ? convertUnit(value, raw.unit, unit) : value]];
  }));
}
export const environmentEdits = (environment: Record<string, number>): RuntimeEdit[] => environmentFields.flatMap(([, field, key]) =>
  Number.isFinite(environment[field]) ? [{ key, value: environment[field] }] : []);
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined && !(key === 'attrs' && value[key] && !Object.keys(value[key]).length))
    .map(key => [key, canonical(value[key])]));
}
interface Group { shape: string; edits: RuntimeEdit[]; environment?: boolean }
function groups(project: { nodes: any[] }): Map<string, Group> {
  const result = new Map<string, Group>();
  for (const node of project.nodes) {
    const p = node.data.params;
    if (node.data.componentType === 'environment') {
      const env = environmentFromProject({ nodes: [node] });
      result.set(node.id, { shape: String(p.atmosphere_model), edits: environmentEdits(env || {}), environment: true }); continue;
    }
    if (node.data.componentType === 'aero_coefficients') {
      try {
        const coefficients = typeof p.coefficients === 'string' ? JSON.parse(p.coefficients) : p.coefficients;
        for (const item of coefficients || []) if (item.name && item.expression) result.set(`${node.id}:${item.name}`, {
          shape: JSON.stringify({ ...item, expression: expressionShape(item.expression) }), edits: expressionParameters(item.name, item.expression),
        });
      } catch {}
      continue;
    }
    let channels: any[];
    try { channels = typeof p.channels === 'string' ? JSON.parse(p.channels) : p.channels; } catch { continue; }
    if (!Array.isArray(channels)) continue;
    const items = (list: any[]) => { for (const item of list) {
      if (Array.isArray(item.items)) items(item.items);
      if (!item.name) continue;
      const edits: RuntimeEdit[] = [], clone = JSON.parse(JSON.stringify(item));
      const add = (field: string, value: any, clear: () => void) => { const n = numeric(value); if (n !== undefined) { edits.push({ key: componentParameterKey(item.name, field), value: n }); clear(); } };
      if (['pure_gain', 'scheduled_gain', 'aerosurface_scale', 'pid'].includes(item.type)) {
        for (const field of item.type === 'pid' ? ['kp', 'ki', 'kd'] : ['gain']) {
          if (item.componentProps?.[field]) add(field, item.componentProps[field].value, () => { clone.componentProps[field].value = '#tunable'; });
        }
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
export function projectParameterChanges(before: { nodes: any[] }, after: { nodes: any[] }, running: { nodes: any[] } = before): RuntimeEdit[] {
  const old = groups(before), next = groups(after), original = groups(running), result: RuntimeEdit[] = [];
  for (const [id, group] of next) {
    const previous = old.get(id);
    if (!previous || previous.shape !== group.shape || (!group.environment && original.get(id)?.shape !== group.shape)) continue;
    const values = new Map(previous.edits.map(edit => [edit.key, edit.value]));
    const changed = group.edits.filter(edit => values.has(edit.key) && values.get(edit.key) !== edit.value);
    if (changed.length) {
      result.push(...changed);
      // Both limits are sent together, without resending unrelated constants.
      if (changed.some(edit => group.edits.some(other => other.key !== edit.key && other.key.startsWith('_tuning/component/')))) {
        const itemName = id.slice(id.indexOf(':') + 1);
        const minKey = componentParameterKey(itemName, 'clip-min'), maxKey = componentParameterKey(itemName, 'clip-max');
        if (changed.some(edit => edit.key === minKey || edit.key === maxKey)) result.push(...group.edits.filter(edit => edit.key === minKey || edit.key === maxKey));
      }
    }
  }
  return [...new Map(result.map(edit => [edit.key, edit])).values()];
}
export function projectModelNames(project: any): string[] {
  const main = project.xmlFiles?.find((file: any) => file.category === 'main');
  const directory = main?.path.match(/^aircraft\/([^/]+)\//)?.[1];
  return [directory, project.aircraft?.name].filter(Boolean);
}
