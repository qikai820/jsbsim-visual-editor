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
