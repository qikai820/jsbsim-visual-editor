export interface SignalBinding { key: string; label: string; sign?: number; unit?: string; sourceUnit?: string; displayUnit?: string; expectedKind?: string; sourceEdge?: string; tap?: { x: number; y: number } }
export function monitorHash(text: string): string {
  let value = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(text)) value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 1099511628211n);
  return value.toString(16).padStart(16, '0');
}
export function expressionMonitorKey(owner: string, path: number[]): string {
  return `_monitor/value/n${monitorHash(owner + ':' + path.map(index => `${index}.`).join(''))}`;
}
export function propertyBinding(raw: string): SignalBinding {
  const sign = raw.startsWith('-') ? -1 : 1;
  const key = raw.replace(/^-/, '').replace(/^\/(?:\d{2}\/)?jsbsim\//, '').replace(/^\//, '');
  const unit = /(?:-|\/)(rad|deg|ft|fps|kts|lbf|lbs|mps|norm|rpm)$/.exec(key.replace(/\[\d+\]$/, ''))?.[1];
  return { key, label: raw, sign, unit: unit === 'norm' ? '' : unit };
}

/** JSBSim tree telemetry includes default [0] indices on every path segment. */
export function canonicalMonitorProperty(raw: string): string {
  return raw.replace(/^\/(?:\d{2}\/)?jsbsim(?:\[0\])?\//, '').replace(/^\//, '').replace(/\[0\](?=\/|$)/g, '');
}
