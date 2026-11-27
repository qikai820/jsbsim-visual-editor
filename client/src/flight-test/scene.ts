import { AXIS_LABEL, CHANNELS, DEFS, flatten, type TestBlock, type TestDocument } from './model';
import type { TestSnapshot } from './session';
import type { RunProgressPlan } from './progress';

export const testTime = (seconds = 0) => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
};
const signed = (value: unknown) => `${Number(value) > 0 ? '+' : ''}${value}`;
export function testActionLabel(block: TestBlock, snapshot: TestSnapshot): string {
  const p = block.p, v = snapshot.values;
  switch (block.type) {
    case 'attitude': case 'attitude_delta': {
      const roll = v['test/attitude/roll-target-deg'] ?? p.roll;
      const pitch = v['test/attitude/pitch-target-deg'] ?? p.pitch;
      return `姿态步进 · R ${signed(roll)}° / P ${signed(pitch)}°`;
    }
    case 'heading': return `航向步进 · 相对 ${signed(v['test/heading/relative-target-deg'] ?? p.target)}°`;
    case 'pulse': return `${AXIS_LABEL[String(p.axis)]} ${signed(p.value)}% · ${p.duration} s`;
    case 'axes': return `四轴打杆 · ${p.duration} s`;
    case 'channel': return `${CHANNELS[String(p.channel)]} · ${p.action==='release'?'释放':signed(p.value)+'%'}`;
    case 'altitude': return `油门控高 · ${p.target} m`;
    case 'manual_takeoff': return `手动油门起飞 · ${p.target} m`;
    case 'mode': return `模式 · ${p.mode}`;
    case 'takeoff': return `起飞 · ${p.altitude} m`;
    case 'wait': return `等待 · ${p.duration} s`;
    case 'mark': return String(p.text);
    default: return DEFS[block.type].label;
  }
}
export function activeTestActions(snapshot: TestSnapshot | null, document: TestDocument | null, plan?: RunProgressPlan | null) {
  if (!snapshot) return [];
  const ids = new Set(snapshot.activeBlocks);
  const blocks = document ? flatten(document.blocks).filter(b => ids.has(b.id) && !['loop', 'parallel', 'branch'].includes(b.type)) : [];
  if (blocks.length) {
    const rounds = new Map<string, string>();
    if (plan?.runId === snapshot.id) {
      for (const node of snapshot.progress?.activeNodes ?? []) {
        const iteration = plan.rounds[node];
        if (iteration?.length) {
          rounds.set(node.slice(0, node.lastIndexOf('_')), iteration.map(r => `第 ${r.index} / ${r.count} 轮`).join(' · '));
        }
      }
    }
    return blocks.map(block => ({ id: block.id,
      label: [testActionLabel(block, snapshot), rounds.get(block.id)].filter(Boolean).join(' · '), block }));
  }
  const actions: Array<{ id: string; label: string; block?: TestBlock }> = [];
  if (snapshot.values['test/heading/active'] === 1) actions.push({id:'heading',label:`航向步进 · 相对 ${signed(snapshot.values['test/heading/relative-target-deg'] ?? '—')}°`});
  if (snapshot.values['test/attitude/active'] === 1) actions.push({ id: 'attitude', label: `姿态步进 · R ${signed(snapshot.values['test/attitude/roll-target-deg'] ?? '—')}° / P ${signed(snapshot.values['test/attitude/pitch-target-deg'] ?? '—')}°` });
  if (snapshot.values['test/altitude/active'] === 1) actions.push({ id: 'altitude', label: `油门控高 · ${snapshot.values['test/altitude/target-m'] ?? '—'} m` });
  if (!actions.length) actions.push(...snapshot.activeBlocks.map(id => ({ id, label: `执行节点 · ${id}` })));
  return actions;
}
