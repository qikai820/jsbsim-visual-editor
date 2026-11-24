import type { AircraftNode, ComponentType } from '../types';
import { useFlowStore } from '../store/flowStore';
import { getComponentDef } from '../utils/componentDefs';
import { convertUnit, getUnitOptions } from '../utils/unitConverter';
import type { VoiceBinding } from './model';

interface FieldRule {
  aliases: string[];
  positive?: boolean;
}

const parameterGroups: Partial<Record<ComponentType, { aliases: string[]; fields: Record<string, FieldRule> }>> = {
  fuselage: { aliases: ['机身'], fields: { emptywt: { aliases: ['空机质量', '空机重量', '空机重', '空重'], positive: true } } },
  wing: { aliases: ['机翼', '主翼'], fields: {
    wingarea: { aliases: ['翼面积', '面积'], positive: true },
    wingspan: { aliases: ['翼展'], positive: true },
    chord: { aliases: ['弦长'], positive: true },
    wing_incidence: { aliases: ['安装角'] },
  } },
  inertia: { aliases: ['惯量', '转动惯量'], fields: {
    ixx: { aliases: ['滚转惯量', '滚转'], positive: true },
    iyy: { aliases: ['俯仰惯量', '俯仰'], positive: true },
    izz: { aliases: ['偏航惯量', '偏航'], positive: true },
  } },
  environment: { aliases: ['环境', '风场'], fields: {
    wind_north_fps: { aliases: ['北向风', '北向风速'] },
    wind_east_fps: { aliases: ['东向风', '东向风速'] },
    wind_down_fps: { aliases: ['地向风', '地向风速', '下向风', '下向风速', '向下风速'] },
  } },
};
const unitAliases: Record<string, string> = {
  kg: 'KG', 千克: 'KG', 公斤: 'KG', lbs: 'LBS', lb: 'LBS', 磅: 'LBS',
  m: 'M', 米: 'M', cm: 'CM', 厘米: 'CM', mm: 'MM', 毫米: 'MM', ft: 'FT', 英尺: 'FT', in: 'IN', 英寸: 'IN',
  m2: 'M2', 'm^2': 'M2', 平方米: 'M2', cm2: 'CM2', 平方厘米: 'CM2', ft2: 'FT2', 'ft^2': 'FT2', 平方英尺: 'FT2',
  '°': 'DEG', deg: 'DEG', 度: 'DEG', rad: 'RAD', 弧度: 'RAD',
  'kg*m2': 'KG*M2', 'kg·m2': 'KG*M2', 'kg*m^2': 'KG*M2', 千克平方米: 'KG*M2', 公斤平方米: 'KG*M2',
  'slug*ft2': 'SLUG*FT2', 'slug·ft2': 'SLUG*FT2',
  'm/s': 'M/SEC', 'm/sec': 'M/SEC', '米/秒': 'M/SEC', 米每秒: 'M/SEC',
  'ft/s': 'FT/SEC', 'ft/sec': 'FT/SEC', '英尺/秒': 'FT/SEC', 英尺每秒: 'FT/SEC',
  'km/h': 'KM/H', 公里每小时: 'KM/H', 千米每小时: 'KM/H', kts: 'KTS', 节: 'KTS',
};
const spokenUnits = Object.keys(unitAliases).sort((left, right) => right.length - left.length);

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s/g, '');
const cleanCommand = (text: string) => normalize(text).replace(/[。.!?！？]+$/, '');
const parameterTarget = (text: string) => text.replace(/^(?:当前(?:编辑器中的|模型|工程)|本机模型)的?/, '').replace(/(?:的)?(?:当前值|数值|是多少|多少)$/, '');
const refersToSelection = (text: string) => /^(?:当前选中|选中|当前|这|这个|该)(?:的)?(?:模块|组件|节点)?$/.test(text);

type Project = ReturnType<typeof useFlowStore.getState>;
type Parameter = { node: AircraftNode; key: string; label: string; value: number; unit: string; storedUnit: string; rule: FieldRule };
type ParameterModule = { node: AircraftNode; name: string; aliases: string[]; parameters: Parameter[] };

function currentParameter(node: AircraftNode, key: string, rule: FieldRule): Parameter[] {
  const field = getComponentDef(node.data.componentType)?.params[key];
  const raw = node.data.params[key];
  const numeric = raw && typeof raw === 'object' ? raw.value : raw;
  if (field?.type !== 'number' || !['number', 'string'].includes(typeof numeric) || String(numeric).trim() === '') return [];
  const value = Number(numeric);
  const storedUnit = (raw && typeof raw === 'object' ? raw.unit : '') || node.data.params[`${key}_unit`] || field.unit || '';
  if (!Number.isFinite(value) || typeof storedUnit !== 'string') return [];
  const unit = unitAliases[normalize(storedUnit)] || storedUnit.toUpperCase();
  if (field.unit && !getUnitOptions(field.unit).some(option => option.value === unit)) return [];
  return [{ node, key, label: field.label, value, unit, storedUnit, rule }];
}

function editorModules(project: Project): ParameterModule[] {
  return project.nodes.flatMap(node => {
    const group = parameterGroups[node.data.componentType];
    if (!group || node.data.params.disabled) return [];
    const name = node.data.label || group.aliases[0];
    const aliases = [name, node.data.params.name, node.id, node.data.componentType, ...group.aliases]
      .filter((alias): alias is string => typeof alias === 'string' && !!alias.trim()).map(normalize);
    return [{ node, name, aliases, parameters: Object.entries(group.fields).flatMap(([key, rule]) => currentParameter(node, key, rule)) }];
  });
}

function chooseModule(candidates: ParameterModule[], selected: string | null): ParameterModule {
  const match = candidates.find(module => module.node.id === selected);
  if (match) return match;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw Error(`找到多个匹配模块（${candidates.map(module => module.name).join('、')}），请在画布上选中目标后重试`);
  throw Error('没有找到支持该参数的模块，请选中目标模块并查询可用参数');
}

function findParameter(modules: ParameterModule[], target: string, selected: string | null): Parameter {
  const name = parameterTarget(target).replace(/^当前(?!选中|模块|组件|节点)的?/, '');
  const candidates = modules.flatMap(module => module.parameters.flatMap(parameter => {
    const fields = [...parameter.rule.aliases, parameter.key, parameter.label].map(normalize);
    const qualifiers = [...module.aliases, ...(module.node.id === selected ? ['当前模块', '当前选中模块', '选中的模块', '这个模块', '该模块', '当前组件', '这个组件', '该组件'] : [])];
    const qualified = qualifiers.some(qualifier => fields.some(field => name === qualifier + field || name === `${qualifier}的${field}`));
    return qualified || fields.includes(name) ? [{ module, parameter, qualified }] : [];
  }));
  const matched = candidates.some(candidate => candidate.qualified) ? candidates.filter(candidate => candidate.qualified) : candidates;
  const module = chooseModule([...new Set(matched.map(candidate => candidate.module))], selected);
  return matched.find(candidate => candidate.module === module)!.parameter;
}

const chineseDigits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const chineseScales: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const digitString = (text: string) => [...text].map(char => String(chineseDigits[char])).join('');

function chineseInteger(text: string): number {
  if (/^[零〇一二两三四五六七八九]+$/.test(text)) return Number(digitString(text));
  const parts = text.split('万');
  if (parts.length === 2) return chineseInteger(parts[0]) * 10000 + (parts[1] ? chineseInteger(parts[1].replace(/^[零〇]/, '')) : 0);
  let result = 0, previousScale = 10000;
  const pieces = text.match(/[零〇]?[一二两三四五六七八九]?[十百千]|[零〇]?[一二两三四五六七八九]/g) || [];
  if (pieces.join('') !== text) return NaN;
  for (const [index, piece] of pieces.entries()) {
    const char = piece.slice(-1), scale = chineseScales[char] || 1;
    const prefix = piece.slice(0, -1);
    const digit = prefix.replace(/^[零〇]/, '');
    if (scale >= previousScale || (!digit && scale > 1 && !(scale === 10 && index === 0 && !prefix))) return NaN;
    if (scale === 1 && index !== pieces.length - 1) return NaN;
    if (scale === 1 && previousScale > 10 && index > 0 && !prefix) return NaN;
    result += (scale === 1 ? chineseDigits[char] : digit ? chineseDigits[digit] : 1) * scale;
    previousScale = scale;
  }
  return pieces.length ? result : NaN;
}

function spokenValue(text: string) {
  const input = text.replace(/^每秒(.+?)(米|英尺)$/, '$1$2/秒');
  // Match a known unit first: 千 belongs to the unit in “两千克”.
  const spokenUnit = spokenUnits.find(unit => input.endsWith(unit)) || '';
  const numericText = spokenUnit ? input.slice(0, -spokenUnit.length) : input;
  const match = numericText.match(/^(百分之)?([+正负-]?)(\d+(?:[.点][\d零〇一二三四五六七八九]+)?|[零〇一二两三四五六七八九十百千万]+(?:[.点][\d零〇一二三四五六七八九]+)?)(.*)$/);
  if (!match) throw Error('请说出明确的数值和单位，例如“三点二千克”或“增加百分之十”');
  const [, percent, sign, amount, tail] = match;
  const suffix = tail + spokenUnit;
  const [whole, fraction] = amount.split(/[.点]/);
  const integer = /^\d+$/.test(whole) ? Number(whole) : chineseInteger(whole);
  const decimal = fraction ? Number(`0.${[...fraction].map(char => chineseDigits[char] ?? char).join('')}`) : 0;
  const value = (sign === '-' || sign === '负' ? -1 : 1) * (integer + decimal);
  if (!Number.isFinite(value)) throw Error('数值无法识别，请使用完整的数值');
  if (percent && suffix) throw Error('百分比后请勿再加单位');
  return { value, relativePercent: !!percent || suffix === '%', unit: percent || suffix === '%' ? '' : suffix };
}

const format = (value: number, unit: string) => `${Number(value.toPrecision(10))}${unit ? ` ${unit}` : ''}`;
const editPattern = /^(?:请帮我|帮我|请)?(?:把|将)?(.+?)(调到|改到|修改为|修改成|设置为|设置成|设为|调成|改为|改成|调整到|增加|增大|减少|降低|加上|减去)(.+)$/;
const listPattern = /^(?:(.+?)(?:的)?有(?:哪些|什么)(?:可修改的)?参数|(?:查询|查看|列出|显示)(.*?)(?:的)?(?:可修改的|可编辑的)?参数)$/;
const knownFieldNames = Object.values(parameterGroups).flatMap(group => Object.entries(group.fields)
  .flatMap(([key, rule]) => [key, ...rule.aliases])).map(normalize);

export type VoiceParameterEdit = {
  type: 'edit_model_parameter';
  binding: VoiceBinding;
  aircraft: Project['aircraft'];
  source: Project['xmlEditBaseline'];
  selectedNodeId: string | null;
  parameter: Parameter;
  expiresAtMs: number;
  summary: string;
  notes: string[];
  patch: Record<string, unknown>;
};

export function isParameterConfirmation(text: string) {
  return ['确认修改', '确认更改', '执行修改', '确认'].includes(cleanCommand(text));
}

export function prepareVoiceParameterCommand(text: string, binding: VoiceBinding, fromSpeech = false):
  { type: 'query_model_parameter'; reply: string } | VoiceParameterEdit | undefined {
  let input = cleanCommand(text);
  const project = useFlowStore.getState();
  const selected = project.selectedNodeId;
  const homophone = fromSpeech && input.includes('空气质量');
  const emptyWeightFromSpeech = homophone && (/机身的?空气质量/.test(input) ||
    project.nodes.some(node => node.id === selected && node.data.componentType === 'fuselage'));
  if (emptyWeightFromSpeech) input = input.replace(/空气质量/g, '空机质量');
  const edit = input.match(editPattern), list = input.match(listPattern);
  const query = input.match(/^(?:请)?(?:查询|查看|读取|告诉我)(.+)$/)?.[1] ?? input.match(/^(.+?)(?:现在)?(?:是多少|有多少|多少)$/)?.[1];
  const parameterIntent = homophone || /参数|惯量|风速|向风|重心|增益|油量/.test(input) || knownFieldNames.some(field => input.includes(field));
  if (!list && !(query && parameterIntent) && !(edit && (parameterIntent || /^(?:百分之|每秒|[+负-]?(?:\d|[零一二两三四五六七八九十]))/.test(edit[3])))) {
    if (parameterIntent && /(?:修改|编辑|调整|设置|调大|调小)/.test(input)) throw Error('请说明具体模块、参数和数值，例如“把空机质量改成3.2千克”');
    return;
  }
  if (/^(?:不要|别|不许|禁止|取消)/.test(input)) throw Error('本条指令包含否定或取消，参数未修改');
  if (homophone && !emptyWeightFromSpeech) throw Error('识别到“空气质量”。如果要查询或修改空重，请先选中机身，或说“空重”。');
  const modules = editorModules(project);
  if (list) {
    const target = parameterTarget(list[1] ?? list[2] ?? '');
    const options = !target || refersToSelection(target) ? modules.filter(module => module.node.id === selected)
      : modules.filter(module => module.aliases.includes(target));
    if ((!target || refersToSelection(target)) && !selected) throw Error('请先在画布上选中一个模块');
    const module = chooseModule(options, selected);
    if (!module.parameters.length) throw Error(`${module.name}没有可用的数值参数`);
    return { type: 'query_model_parameter', reply: `${module.name}：${module.parameters.map(field => `${field.label} ${format(field.value, field.unit)}`).join('，')}` };
  }
  const parameter = findParameter(modules, edit?.[1] ?? query!, selected);
  const { node, key, value, unit, storedUnit } = parameter;
  const description = `${node.data.label || getComponentDef(node.data.componentType)?.label} · ${parameter.label}`;
  if (!edit) return { type: 'query_model_parameter', reply: `${description}：${format(value, unit)}` };
  if (binding.busy) throw Error('上位机正在处理其他操作，请稍后重试');
  const amount = spokenValue(edit[3]);
  const add = ['增加', '增大', '加上'].includes(edit[2]), subtract = ['减少', '降低', '减去'].includes(edit[2]);
  if (amount.relativePercent && !add && !subtract) throw Error('百分比用于增加或减少，请说明变化方向');
  if ((add || subtract) && amount.value < 0) throw Error('请使用非负的增减量');
  const requestedUnit = unitAliases[amount.unit] || amount.unit.toUpperCase();
  if (unit && !requestedUnit && !amount.relativePercent) throw Error(`请明确${parameter.label}的单位，例如 ${unit}`);
  if (requestedUnit && (!unit || !getUnitOptions(unit).some(option => option.value === requestedUnit))) throw Error(`${parameter.label}不能使用单位 ${amount.unit}`);
  const converted = amount.relativePercent ? Math.abs(value) * (amount.value / 100) : convertUnit(amount.value, requestedUnit, unit);
  const next = add ? value + converted : subtract ? value - converted : converted;
  if (!Number.isFinite(next) || (parameter.rule.positive && next <= 0)) throw Error(`${parameter.label}必须是有效的${parameter.rule.positive ? '正数' : '数值'}`);
  if (next === value) return { type: 'query_model_parameter', reply: `${description}当前已经是 ${format(value, unit)}` };
  const raw = node.data.params[key];
  const stored = raw && typeof raw === 'object' ? { ...raw, value: next, unit: storedUnit }
    : node.data.params[`${key}_unit`] ? { value: next, unit: storedUnit } : next;
  const notes: string[] = [];
  if (emptyWeightFromSpeech) notes.push('结合机身模块，将识别出的“空气质量”解析为空重。');
  if (requestedUnit && requestedUnit !== unit) notes.push(`输入 ${format(amount.value, requestedUnit)}，按 ${unit} 存储。`);
  if (node.data.componentType === 'environment' && node.data.params.wind_profile?.active) notes.push('修改恒定风速会关闭此草稿中的波形风场。');
  return { type: 'edit_model_parameter', binding, aircraft: project.aircraft, source: project.xmlEditBaseline,
    selectedNodeId: selected, parameter, expiresAtMs: Date.now() + 60_000, notes,
    summary: `${description}：${format(value, unit)} → ${format(next, unit)}`, patch: { [key]: stored } };
}

export function commitVoiceParameterEdit(edit: VoiceParameterEdit, binding: VoiceBinding) {
  if (Date.now() > edit.expiresAtMs) throw Error('参数修改预览已过期，请重新解析');
  if (binding.busy) throw Error('上位机正在处理其他操作，请稍后重试');
  const project = useFlowStore.getState();
  const node = project.nodes.find(candidate => candidate.id === edit.parameter.node.id);
  if (binding.instance !== edit.binding.instance || binding.selectedModel !== edit.binding.selectedModel ||
      project.aircraft !== edit.aircraft || project.xmlEditBaseline !== edit.source || project.selectedNodeId !== edit.selectedNodeId ||
      node?.data !== edit.parameter.node.data) throw Error('模型、模块或参数已变化，请重新解析');
  project.updateNodeParams(node.id, edit.patch, { draftOnly: true });
  return '参数已修改到编辑器草稿。可使用“保存工程”保留变更。';
}
