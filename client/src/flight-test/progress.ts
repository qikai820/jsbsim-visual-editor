import { DEFS, FIELDS, MAX_TEST_BLOCKS, type TestBlock, type TestDocument } from './model';
import { compileTest, type LoopRound } from './xml';
import type { TestContext, TestSnapshot } from './session';

export type FlowProgress = {
  total: number;
  completedAt: number[];
  activeNodes: string[];
  scriptStartedAt: number | null;
  scriptFinishedAt: number | null;
};

export type RunProgressPlan = {
  runId: number;
  timingKey: string;
  rounds: Record<string, readonly LoopRound[]>;
};

type TimingSample = {
  id: string;
  total: number;
  scriptStart: number;
  scriptEnd: number;
  steps: number[];
};
export type TimingHistory = Record<string, TimingSample[]>;
export const TEST_TIMING_STORAGE = 'px4-flight-test-timing-v1';

export function testTimingKey(document: TestDocument, dryRun: boolean, context: TestContext | null) {
  const link = context?.link;
  const text = JSON.stringify([document, dryRun, context?.instance,
    dryRun ? null : [link?.expectedHost, link?.target.system, link?.target.component, link?.version, link?.uid]]);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  }
  return hash.toString(16);
}

export function planTestProgress(document: TestDocument, timingKey: string) {
  const roots: string[] = [];
  const rounds: RunProgressPlan['rounds'] = {};
  compileTest(document, false, (id, root, iteration) => {
    if (root) roots.push(id);
    if (iteration.length) rounds[id] = iteration;
  });
  return { roots, plan: { runId: 0, timingKey, rounds } };
}

const finite = (v: unknown): v is number => typeof v === 'number' && v >= 0 && Number.isFinite(v);
function validSample(sample: Partial<TimingSample> | null): sample is TimingSample {
  return !!sample && typeof sample.id === 'string' && finite(sample.total) && finite(sample.scriptStart)
    && finite(sample.scriptEnd) && sample.scriptStart <= sample.scriptEnd && sample.scriptEnd <= sample.total
    && Array.isArray(sample.steps) && sample.steps.length <= MAX_TEST_BLOCKS
    && sample.steps.every((time, i, steps) => finite(time) && time >= (steps[i - 1] ?? sample.scriptStart!)
      && time <= sample.scriptEnd!);
}

export function readTestTimingHistory(value: string | null): TimingHistory {
  try {
    const saved = JSON.parse(value ?? '{}');
    return Object.fromEntries(Object.entries(saved).slice(-24).filter(([key]) => /^[0-9a-f]+$/.test(key))
      .flatMap(([key, samples]) => Array.isArray(samples) ? [[key, samples.filter(validSample).slice(-5)]] : []));
  } catch {
    return {};
  }
}

export function rememberTestTiming(history: TimingHistory, snapshot: TestSnapshot, plan: RunProgressPlan | null): TimingHistory {
  const progress = snapshot.progress;
  if (snapshot.status !== 'passed' || plan?.runId !== snapshot.id || !snapshot.startedAtUnixMs
    || !progress || progress.completedAt.length !== progress.total || !finite(snapshot.runElapsed)
    || progress.scriptStartedAt === null || progress.scriptFinishedAt === null) return history;
  const key = plan.timingKey;
  const sample = {
    id: snapshot.startedAtUnixMs + '/' + snapshot.id,
    total: snapshot.runElapsed,
    scriptStart: progress.scriptStartedAt,
    scriptEnd: progress.scriptFinishedAt,
    steps: progress.completedAt,
  };
  const previous = history[key] ?? [];
  if (!validSample(sample) || previous.some(item => item.id === sample.id)) return history;
  const entries = Object.entries(history).filter(([old]) => old !== key).slice(-23);
  return Object.fromEntries([...entries, [key, [...previous.slice(-4), sample]]]);
}

type Span = { min: number; max: number };
const exact = (seconds: number): Span => ({ min: seconds, max: seconds });
const add = (a: Span, b: Span): Span => ({ min: a.min + b.min, max: a.max + b.max });
const sum = (spans: Span[]) => spans.reduce(add, exact(0));

function blockSpan(block: TestBlock, rate: number): Span {
  const p = block.p;
  const lane = (blocks: TestBlock[]) => sum(blocks.map(child => blockSpan(child, rate)));
  switch (block.type) {
    case 'wait': case 'pulse': case 'axes': case 'altitude': case 'observe':
      return exact(Number(p.duration));
    case 'neutral':
      return exact(1 / rate);
    case 'throttle': case 'mark': case 'channel': case 'input_mode': case 'launch_reference':
      return exact(0);
    case 'loop': {
      const { min, max } = lane(block.body ?? []);
      return { min: min * Number(p.count), max: max * Number(p.count) };
    }
    case 'branch': {
      const yes = lane(block.yes ?? []);
      const no = lane(block.no ?? []);
      return { min: Math.min(yes.min, no.min), max: Math.max(yes.max, no.max) };
    }
    case 'parallel': {
      const spans = (block.lanes ?? []).map(lane);
      if (!spans.length) return exact(0);
      const combine = p.join === 'all' ? Math.max : Math.min;
      return { min: combine(...spans.map(s => s.min)), max: combine(...spans.map(s => s.max)) };
    }
    case 'attitude': case 'attitude_delta': case 'heading':
      return { min: Number(p.hold), max: Infinity };
    case 'manual_takeoff': case 'manual_recover':
      return { min: Number(p.settle), max: Infinity };
    default:
      return { min: 0, max: Infinity };
  }
}

export type TestEstimate = { label: string; value: string; note?: string };

function durationText(seconds: number) {
  return seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分'
    + (seconds % 60 ? ' ' + (seconds % 60) + ' 秒' : '');
}
function spanText(span: Span) {
  const min = Math.max(1, Math.floor(span.min));
  if (!Number.isFinite(span.max)) return span.min >= 1 ? '至少 ' + durationText(min) : '待估算';
  const max = Math.max(min, Math.ceil(span.max));
  if (min === max) return '约 ' + durationText(max);
  return max < 60 ? min + '–' + max + ' 秒' : durationText(min) + '–' + durationText(max);
}
function historicalText(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return spanText({ min: Math.max(0, min * .9), max: Math.max(max + .5, max * 1.1) });
}

export function previewTestEstimate(document: TestDocument | null, samples: TimingSample[]): TestEstimate {
  if (samples.length) return { label: '预计总耗时', value: historicalText(samples.map(sample => sample.total)),
    note: '参考近期同配置的成功测试，包含运行前检查与退出确认' };
  if (!document) return { label: '预计总耗时', value: '—' };
  const span = sum(document.blocks.map(block => blockSpan(block, document.rateHz)));
  return { label: '脚本估算', value: spanText(span),
    note: '按脚本时间估算，运行前检查与退出确认另计' };
}

export function waitingForBlock(block: TestBlock | undefined): string | undefined {
  if (!block) return;
  switch (block.type) {
    case 'attitude': case 'attitude_delta': return '等待姿态稳定';
    case 'heading': return '等待航向稳定';
    case 'manual_recover': return '等待回位稳定';
    case 'manual_takeoff': return '等待起飞稳定';
    case 'mode': return '等待飞控确认模式';
    case 'arm': case 'disarm': case 'land': case 'takeoff': return '等待飞控状态确认';
    case 'wait_state': case 'assert': return '等待' + (FIELDS[String(block.p.field)] ?? '条件') + '满足';
  }
}

export function runningTestEstimate(snapshot: TestSnapshot, document: TestDocument | null, samples: TimingSample[],
  waiting?: string): TestEstimate {
  const result = { label: '预计剩余', value: '—' };
  const progress = snapshot.progress;
  if (!progress || !document || progress.scriptStartedAt === null || progress.total !== document.blocks.length) return result;
  const count = progress.completedAt.length;
  if (count >= progress.total) return { ...result, value: '即将退出' };
  const now = snapshot.runElapsed ?? snapshot.realElapsed;
  const stageStart = progress.completedAt[count - 1] ?? progress.scriptStartedAt;
  const spent = Math.max(0, now - stageStart);
  const stage = blockSpan(document.blocks[count], document.rateHz);
  const matching = samples.filter(sample => sample.steps.length === progress.total);
  if (matching.length) {
    const candidates = matching.map(sample => ({
      current: sample.steps[count] - (sample.steps[count - 1] ?? sample.scriptStart),
      later: sample.total - sample.steps[count],
    }));
    if (Number.isFinite(stage.max) || !candidates.every(sample => spent > sample.current * 1.1 + 1)) {
      return { ...result, value: historicalText(candidates.map(sample => Math.max(0, sample.current - spent) + sample.later)),
        note: '参考近期同配置的成功测试' };
    }
  }
  const rate = snapshot.dryRun ? 4 : document.clock === 'realtime' ? 1
    : now - progress.scriptStartedAt >= 2 && snapshot.elapsed > 0
      ? snapshot.elapsed / (now - progress.scriptStartedAt) : 0;
  if (!Number.isFinite(stage.max) || rate <= 0) return { ...result, value: waiting ?? '估算中' };
  const later = sum(document.blocks.slice(count + 1).map(block => blockSpan(block, document.rateHz)));
  const remaining = { min: Math.max(0, stage.min / rate - spent) + later.min / rate,
    max: Math.max(0, stage.max / rate - spent) + later.max / rate };
  return { label: '脚本剩余', value: spanText(remaining), note: '退出确认耗时另计' };
}

export function testStepLabel(block: TestBlock) {
  if (block.type === 'mode') return DEFS.mode.label + ' · ' + block.p.mode;
  if (block.type === 'wait') return DEFS.wait.label + ' · ' + block.p.duration + ' 秒';
  if (block.type === 'loop') return DEFS.loop.label + ' · ' + block.p.count + ' 轮';
  if (block.type === 'parallel') return DEFS.parallel.label + ' · ' + (block.lanes?.length ?? 0) + ' 路';
  return DEFS[block.type].label;
}
