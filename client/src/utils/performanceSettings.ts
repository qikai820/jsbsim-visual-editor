export const PERFORMANCE_PERIOD_KEY = 'jsbsim-performance-period-secs';
export const DEFAULT_PERFORMANCE_PERIOD_SECONDS = 30;
export const MIN_PERFORMANCE_PERIOD_SECONDS = 1;
export const MAX_PERFORMANCE_PERIOD_SECONDS = 300;

export function readPerformancePeriod(): number {
  const saved = Number(localStorage.getItem(PERFORMANCE_PERIOD_KEY));
  if (!Number.isFinite(saved) || saved <= 0) return DEFAULT_PERFORMANCE_PERIOD_SECONDS;
  return Math.max(MIN_PERFORMANCE_PERIOD_SECONDS, Math.min(MAX_PERFORMANCE_PERIOD_SECONDS, Math.round(saved)));
}

export function savePerformancePeriod(value: number): number {
  const period = Math.max(MIN_PERFORMANCE_PERIOD_SECONDS, Math.min(MAX_PERFORMANCE_PERIOD_SECONDS,
    Math.round(Number.isFinite(value) ? value : DEFAULT_PERFORMANCE_PERIOD_SECONDS)));
  localStorage.setItem(PERFORMANCE_PERIOD_KEY, String(period));
  return period;
}
