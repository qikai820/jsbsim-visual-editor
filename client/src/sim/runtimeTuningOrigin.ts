// Zustand subscriptions run synchronously. Explicit wind editing stores drafts
// without triggering the automatic tuning subscriber a second time.
let depth = 0;
export const automaticRuntimeTuningSuppressed = () => depth > 0;
export function withoutAutomaticRuntimeTuning(update: () => void) {
  depth++;
  try { update(); } finally { depth--; }
}
