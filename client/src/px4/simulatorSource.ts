export type SimulatorPx4Source = { key: string; id: string; name: string; port: number; enabled: boolean; bidirectional: boolean; fingerprint: string };
const enabled = (value: unknown, fallback: boolean) => value === undefined ? fallback : value === true || value === 'true' || value === 1 || value === '1';
/** The model owns board-side wiring. The toolbox only observes its forwarding endpoint. */
export function simulatorPx4Sources(nodes: Array<{ id: string; data: { componentType: string; params: Record<string, unknown> } }>): SimulatorPx4Source[] {
  const sources = nodes.filter(n => n.data.componentType === 'mavlink_forwarder').map(n => {
    const p = n.data.params;
    return { key:n.id, id:String(p.id||'qgc'), name:String(p.name||'MAVLink 转发'), port:Number(p.qgc_port??14550), enabled:enabled(p.enabled,false), bidirectional:enabled(p.bidirectional,true), fingerprint:JSON.stringify(p) };
  });
  // Existing simulator configurations may forward MAVLink without an editor node.
  return sources.length ? sources : [{ key:'simulator-default',id:'default',name:'仿真机 MAVLink 数据',port:14550,enabled:true,bidirectional:true,fingerprint:'default' }];
}

/** Keep QGC's listener independent when the model provides a toolbox stream. */
export function selectSimulatorPx4Source(sources: SimulatorPx4Source[], selectedKey = ''): SimulatorPx4Source {
  return sources.find(source => source.key === selectedKey)
    || sources.find(source => source.enabled && ['toolbox', 'px4-toolbox'].includes(source.id))
    || sources.find(source => source.enabled)
    || sources[0];
}

export function simulatorPx4AttachError(port: number, error: unknown): string {
  const message = String(error);
  return /Address already in use|os error (?:98|48|10048)|地址.*(?:使用|占用)/i.test(message)
    ? `UDP ${port} 已被其他程序占用。QGC 与工具箱需使用不同的仿真机转发目标端口，请选择工具箱专用转发通道。`
    : '等待仿真机转发：' + message;
}
