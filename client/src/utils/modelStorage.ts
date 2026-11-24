import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import { reclaimBrowserCaches } from './browserCache';

const PREFIX = '!jsbsim:gzip:1:';
const COMPRESS_AT = 64 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const decoded = new Map<string, { stored: string; value: string }>();
const modelKey = (key: string) => ['jsbsim-project', 'jsbsim-raw-xml', 'jsbsim-reference-files', 'jsbsim-import-assets'].includes(key)
  || key.startsWith('jsbsim-remote-baseline:');

function hash(bytes: Uint8Array): string {
  let value = 0x811c9dc5;
  for (const byte of bytes) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  return value.toString(16).padStart(8, '0');
}
function base64(bytes: Uint8Array): string {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
function pack(value: string): string {
  if (value.length < COMPRESS_AT) return value;
  const bytes = strToU8(value);
  if (bytes.length > MAX_BYTES) throw Error('模型缓存超过 64 MiB，请先保存为工程文件。');
  const compressed = PREFIX + bytes.length + ':' + hash(bytes) + ':' + base64(gzipSync(bytes, { level: 6, mtime: 0 }));
  return compressed.length < value.length ? compressed : value;
}
function unpack(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const [length, checksum, payload, extra] = stored.slice(PREFIX.length).split(':');
  const size = Number(length);
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES || !/^[0-9a-f]{8}$/.test(checksum) || !payload || extra !== undefined) {
    throw Error('模型缓存格式损坏，已保留原数据，请从工程文件或模型 XML 恢复。');
  }
  const binary = atob(payload), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (bytes.length < 18 || new DataView(bytes.buffer).getUint32(bytes.length - 4, true) !== size) throw Error('模型缓存长度校验失败，已保留原数据。');
  const raw = gunzipSync(bytes, new Uint8Array(size));
  if (raw.length !== size || hash(raw) !== checksum) throw Error('模型缓存内容校验失败，已保留原数据。');
  return strFromU8(raw);
}
function quota(error: unknown): boolean {
  const value = error as { name?: string; code?: number };
  return value?.name === 'QuotaExceededError' || value?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || value?.code === 22 || value?.code === 1014;
}

/** Lossless model persistence. Preferences remain plain; original XML is never discarded. */
export const modelStorage = {
  getItem(key: string): string | null {
    const stored = localStorage.getItem(key);
    if (stored === null || !modelKey(key)) return stored;
    const old = decoded.get(key);
    if (old?.stored === stored) return old.value;
    const value = unpack(stored);
    decoded.set(key, { stored, value });
    return value;
  },
  setItem(key: string, value: string): void {
    const stored = modelKey(key) ? pack(value) : value;
    try { localStorage.setItem(key, stored); }
    catch (error) {
      if (!quota(error)) throw error;
      // Only metadata/property-list caches are expendable. Projects, source
      // baselines, scripts and preferences retain their previous values.
      reclaimBrowserCaches();
      localStorage.setItem(key, stored);
    }
    if (modelKey(key)) decoded.set(key, { stored, value });
  },
  removeItem(key: string): void { localStorage.removeItem(key); decoded.delete(key); },
};

/** Upgrade old plain caches one key at a time; each Storage write is atomic. */
export function migrateModelStorage(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key): key is string => !!key && modelKey(key));
    for (const key of keys) {
      try {
        const value = localStorage.getItem(key);
        if (value && !value.startsWith(PREFIX)) modelStorage.setItem(key, value);
      } catch { /* Keep the original key untouched if storage is unavailable. */ }
    }
  } catch { /* Private/disabled storage must not prevent application startup. */ }
}
