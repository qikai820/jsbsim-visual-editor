// fflate 0.6.11 ships declarations but omits them from its exports map.
// Keep this adapter aligned with the installed, pinned synchronous API.
declare module 'fflate' {
  export function gzipSync(data: Uint8Array, options?: { level?: 0|1|2|3|4|5|6|7|8|9; mtime?: Date|string|number }): Uint8Array;
  export function gunzipSync(data: Uint8Array, out?: Uint8Array): Uint8Array;
  export function strToU8(value: string, latin1?: boolean): Uint8Array;
  export function strFromU8(value: Uint8Array, latin1?: boolean): string;
}
