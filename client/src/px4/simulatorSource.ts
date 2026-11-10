export type SimulatorPx4Source = { key: string; id: string; name: string; port: number; enabled: boolean; bidirectional: boolean; fingerprint: string; service: boolean };
/** The toolbox uses the board service; canvas nodes no longer own forwarding. */
export function simulatorPx4Sources(_nodes: unknown[], config?:{device:string;baud:number;host:string;toolbox_port:number}, running=true): SimulatorPx4Source[] {
  const port=config?.toolbox_port??14553;
  return [{ key:'simulator-service',id:'px4-toolbox',name:'仿真机常驻转发服务',port,enabled:running,bidirectional:true,fingerprint:JSON.stringify(config??{toolbox_port:port}),service:true }];
}

/** Recover obsolete model selections to the independent service. */
export function selectSimulatorPx4Source(sources: SimulatorPx4Source[], selectedKey = ''): SimulatorPx4Source {
  return sources.find(source => source.key === selectedKey)
    || sources.find(source => source.enabled && ['toolbox', 'px4-toolbox'].includes(source.id))
    || sources.find(source => source.enabled)
    || sources[0];
}

export function simulatorPx4AttachError(port: number, error: unknown): string {
  const message = String(error);
  return /Address already in use|os error (?:98|48|10048)|地址.*(?:使用|占用)/i.test(message)
    ? `UDP ${port} 已被其他程序占用。QGC 与工具箱需使用不同端口；工具箱常驻服务使用专用 UDP 14553。`
    : '等待仿真机转发：' + message;
}
