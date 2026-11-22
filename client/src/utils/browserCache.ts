// Only data that can be rediscovered belongs here. Projects, XML baselines,
// scripts and user preferences must never be evicted to make room for a cache.
type CacheGroup = 'metadata' | 'variables';
const limits: Record<CacheGroup, number> = { metadata: 2 * 1024 * 1024, variables: 1024 * 1024 };
const groupFor = (key: string): CacheGroup | null => key.startsWith('px4-parameter-metadata:') ? 'metadata'
  : key.startsWith('jsbsim-mcap-variables:') || key === 'jsbsim-available-variables' ? 'variables' : null;
const sizeOf = (key: string, value: string) => 2 * (key.length + value.length);

/** Optional persistence must never interrupt live state or device operations. */
export function tryStoreLocalText(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

function trimGroup(group: CacheGroup, budget: number, replacing?: string) {
  const entries: Array<{ key: string; size: number }> = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key && key !== replacing && groupFor(key) === group) {
      entries.push({ key, size: sizeOf(key, localStorage.getItem(key) || '') });
    }
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  // Reclaim the largest expendable entries first; Storage key order is not LRU.
  for (const entry of entries.sort((a, b) => b.size - a.size)) {
    if (total <= budget) break;
    localStorage.removeItem(entry.key);
    total -= entry.size;
  }
}

/** Also limits caches left by older versions, before the application mounts. */
export function trimBrowserCaches(): void {
  try { for (const group of ['metadata', 'variables'] as const) trimGroup(group, limits[group]); } catch { /* Storage may be unavailable. */ }
}

export function cacheLocalText(key: string, value: string): boolean {
  const group = groupFor(key);
  if (!group) return false;
  const size = sizeOf(key, value);
  if (size > limits[group]) return false;
  try {
    trimGroup(group, limits[group] - size, key);
    return tryStoreLocalText(key, value);
  } catch { return false; }
}
