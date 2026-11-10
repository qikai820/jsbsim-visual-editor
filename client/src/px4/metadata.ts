import { XMLParser } from 'fast-xml-parser';
export type ParameterMeta = {
  name: string; category: string; group: string; shortDesc: string; longDesc: string;
  type?: string; default?: number; min?: number; max?: number; units?: string; rebootRequired: boolean; readOnly: boolean;
  values: Array<{ value: number; description: string }>; bitmask: Array<{ index: number; description: string }>;
};
export type MetadataSource = { kind: 'bundled' | 'vehicle' | 'cache' | 'import'; label: string; uri?: string; crc?: number; matched: boolean };
const finite = (x: unknown) => x !== '' && x !== null && x !== undefined && Number.isFinite(Number(x)) ? Number(x) : undefined;
const text = (x: unknown) => typeof x === 'string' ? x.slice(0, 16000) : typeof x === 'number' ? String(x) : '';
const list = (x: any) => Array.isArray(x) ? x : x === undefined ? [] : [x];
export class MetadataCatalog {
  private exact = new Map<string, ParameterMeta>();
  private patterns: Array<[RegExp, ParameterMeta]> = [];
  readonly count: number;
  constructor(parameters: unknown[], readonly source: MetadataSource) {
    if (parameters.length > 30000) throw Error('元数据参数数量超过 30000');
    for (const item of parameters) {
      if (!item || typeof item !== 'object') continue;
      const p = item as Record<string, any>, name = text(p.name);
      if (!name || name.length > 64 || !/^[\w{}]+$/.test(name)) continue;
      const meta: ParameterMeta = { name, category: text(p.category) || 'Standard', group: text(p.group) || 'Misc', shortDesc: text(p.shortDesc), longDesc: text(p.longDesc), type: text(p.type),
        default: finite(p.default), min: finite(p.min), max: finite(p.max), units: text(p.units), rebootRequired: p.rebootRequired === true || p.rebootRequired === 'true', readOnly: p.readOnly === true || p.readOnly === 'true',
        values: list(p.values).map((v: any) => ({ value: finite(v?.value), description: text(v?.description) })).filter((v): v is { value: number; description: string } => v.value !== undefined),
        bitmask: list(p.bitmask).map((v: any) => ({ index: finite(v?.index), description: text(v?.description) })).filter((v): v is { index: number; description: string } => v.index !== undefined && v.index >= 0 && v.index < 32),
      };
      if (name.includes('{n}')) this.patterns.push([new RegExp('^' + name.split('{n}').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(\\d+)') + '$'), meta]);
      else this.exact.set(name, meta);
    }
    this.count = this.exact.size + this.patterns.length;
    if (!this.count) throw Error('文件中没有有效的参数元数据');
  }
  get(name: string): ParameterMeta | undefined {
    const exact = this.exact.get(name); if (exact) return exact;
    for (const [pattern, meta] of this.patterns) { const match = name.match(pattern); if (match) return { ...meta, name, shortDesc: meta.shortDesc.replace(/\{n\}/g, match[1]), longDesc: meta.longDesc.replace(/\{n\}/g, match[1]) }; }
  }
}
export function parseMetadata(content: string, source: MetadataSource): MetadataCatalog {
  if (content.length > 16 * 1024 * 1024) throw Error('元数据超过 16 MiB');
  if (content.trimStart().startsWith('<')) {
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw Error('参数 XML 不允许包含 DTD/实体声明');
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', processEntities: true }).parse(content);
    const parameters = list(doc.parameters?.group).flatMap((g: any) => list(g.parameter).map((p: any) => ({
      ...p, name: p.name, category: 'Standard', group: g.name,
      shortDesc: typeof p.short_desc === 'object' ? p.short_desc['#text'] : p.short_desc,
      longDesc: typeof p.long_desc === 'object' ? p.long_desc['#text'] : p.long_desc,
      units: p.unit, rebootRequired: p.reboot_required,
      values: list(p.values?.value).map((v: any) => ({ value: v.code, description: v['#text'] })),
      bitmask: list(p.bitmask?.bit).map((v: any) => ({ index: v.index, description: v['#text'] })),
    })));
    return new MetadataCatalog(parameters, source);
  }
  const json = JSON.parse(content);
  if (!json || !Array.isArray(json.parameters) || (json.version !== undefined && json.version !== 1)) throw Error('不支持的 PX4 参数元数据格式');
  return new MetadataCatalog(json.parameters, source);
}
export const metadataLabel = (source: MetadataSource) => ({ bundled: '内置参考库', vehicle: '飞控元数据', cache: '飞控匹配缓存', import: '本地导入' })[source.kind];
