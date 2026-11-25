export const PLATFORM_GEOMETRY_KEYS = ['moving-platform/contact-mode', 'moving-platform/deck-length-m',
  'moving-platform/deck-width-m', 'moving-platform/deck-z-m', 'guide-rail/length-m',
  'guide-rail/spacing-m', 'guide-rail/cg-z-m', 'guide-rail/sleeve-m'] as const;
export const PLATFORM_POSE_KEYS = ['moving-platform/relative-position-m[0]', 'moving-platform/relative-position-m[1]',
  'moving-platform/relative-position-m[2]', 'moving-platform/angles-rad[0]',
  'moving-platform/angles-rad[1]', 'moving-platform/angles-rad[2]'] as const;
export const PLATFORM_SIGNAL_KEYS = ['moving-platform/enabled', ...PLATFORM_POSE_KEYS, ...PLATFORM_GEOMETRY_KEYS];
export type PlatformGeometry = { mode: number; length: number; width: number; deckZ: number;
  rodLength: number; spacing: number; cgZ: number; sleeve: number };
export type PlatformReading = { geometry: PlatformGeometry; relative: [number, number, number];
  angles: [number, number, number]; sampleAt: number;
  measurements?: { value: number; time: number; sampleAt: number; inferred?: boolean }[] };
export function platformGeometry(params: Record<string, unknown>): PlatformGeometry {
  const n = (key: string, fallback: number) => typeof params[key] === 'number' && Number.isFinite(params[key]) ? params[key] as number : fallback;
  return { mode: n(PLATFORM_GEOMETRY_KEYS[0], 1), length: Math.max(.01, n(PLATFORM_GEOMETRY_KEYS[1], 4)),
    width: Math.max(.01, n(PLATFORM_GEOMETRY_KEYS[2], 3)), deckZ: n(PLATFORM_GEOMETRY_KEYS[3], .25),
    rodLength: Math.max(.01, n(PLATFORM_GEOMETRY_KEYS[4], 1.5)), spacing: Math.max(.01, n(PLATFORM_GEOMETRY_KEYS[5], .36)),
    cgZ: n(PLATFORM_GEOMETRY_KEYS[6], 0), sleeve: Math.max(.001, n(PLATFORM_GEOMETRY_KEYS[7], .1)) };
}
/** Require the measured geometry and a complete, coherent pose. Never invent missing axes. */
export function readMovingPlatform(read: (key: string) => { value: number; age: number; time?: number; timeInferred?: boolean } | undefined, now: number): PlatformReading | null {
  const enabled = read('moving-platform/enabled');
  if (!enabled || enabled.value < .5 || enabled.age >= 2000) return null;
  const pose = PLATFORM_POSE_KEYS.map(read), geometry = PLATFORM_GEOMETRY_KEYS.map(read);
  if ([...pose, ...geometry].some(v => !v || v.age >= 2000)) return null;
  const ages = pose.map(v => v!.age);
  if (Math.max(...ages) - Math.min(...ages) > 250) return null;
  const values = Object.fromEntries(PLATFORM_GEOMETRY_KEYS.map((key, i) => [key, geometry[i]!.value]));
  if (![0, 1, 2].includes(values[PLATFORM_GEOMETRY_KEYS[0]]) || [1, 2, 4, 5, 7].some(i => values[PLATFORM_GEOMETRY_KEYS[i]] <= 0)) return null;
  return { geometry: platformGeometry(values), relative: pose.slice(0, 3).map(v => v!.value) as [number, number, number],
    angles: pose.slice(3).map(v => v!.value) as [number, number, number], sampleAt: now - Math.max(...ages),
    measurements: pose.every(v => v?.time !== undefined) ? pose.map(v => ({ value: v!.value, time: v!.time!, sampleAt: now - v!.age, inferred: v!.timeInferred })) : undefined };
}
