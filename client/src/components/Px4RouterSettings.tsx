import { useEffect, useState } from 'react';
import { DEFAULT_ROUTER_CONFIG, validateRouterConfig, type RouterConfig, type RouterController } from '../px4/router';
const bytes=(n:number)=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KiB':(n/1048576).toFixed(2)+' MiB';
export default function Px4RouterSettings({router}:{router:RouterController}) {
  const {snapshot,busy,error}=router;
  const [draft,setDraft]=useState<RouterConfig>(DEFAULT_ROUTER_CONFIG),[baseline,setBaseline]=useState<RouterConfig>(),[editing,setEditing]=useState(false),[message,setMessage]=useState('');
  const [baselineSimulator,setBaselineSimulator]=useState('');
  const fingerprint=JSON.stringify([snapshot?.simulator,snapshot?.config]);
  useEffect(()=>{if(snapshot&&!editing){setDraft(snapshot.config);setBaseline(snapshot.config);setBaselineSimulator(snapshot.simulator);}},[fingerprint,editing]);
  const update=(key:keyof RouterConfig,value:string|number)=>{setEditing(true);setMessage('');setDraft(c=>({...c,[key]:value}));};
  const invalid=validateRouterConfig(draft),dirty=!!baseline&&JSON.stringify(draft)!==JSON.stringify(baseline);
  const discard=()=>{if(snapshot){setDraft(snapshot.config);setBaseline(snapshot.config);}setEditing(false);setMessage('');router.clearError();};
  const apply=async()=>{if(!baseline||invalid)return;try{const next=await router.apply(draft,baseline,baselineSimulator);setDraft(next.config);setBaseline(next.config);setEditing(false);setMessage(next.state==='running'?'配置已保存，服务已按新配置运行':'配置已保存，下次启动服务时生效');}catch{}};
  const control=async()=>{if(!snapshot)return;try{const next=await router.control(snapshot.state==='running'?'stop':'start');setMessage(next.state==='running'?'转发服务已启动':'转发服务已停止；仿真机重启后会自动启动');}catch{}};
  return <div className="px4-router-settings">
    <div className="px4-router-heading"><div><h3>仿真机 MAVLink 转发</h3><p>开机自动启动，独立于画布和模型。QGC 与工具箱共享飞控 USB 数据。</p></div>
      <div className="px4-router-actions"><span role="status">{snapshot?({running:'运行中',stopped:'已停止',starting:'正在启动',stopping:'正在停止'})[snapshot.state]:'等待服务状态'}</span>
        <button disabled={busy} onClick={()=>{router.clearError();void router.refresh();}}>刷新状态</button>
        <button disabled={!snapshot||busy||dirty||!['running','stopped'].includes(snapshot.state)} onClick={()=>void control()}>{snapshot?.state==='running'?'停止服务':'启动服务'}</button></div></div>
    {snapshot&&<small className="px4-muted">仿真机 {snapshot.simulator} · 配置保存在仿真机，关闭工具箱后继续运行</small>}
    {error&&<div className="px4-notice error" role="alert">{error}</div>}
    <form onSubmit={e=>{e.preventDefault();void apply();}}>
      <fieldset disabled={!snapshot||busy}><legend>飞控来源</legend><div className="px4-router-fields">
        <label>USB 设备<input aria-label="转发 USB 设备" value={draft.device} onChange={e=>update('device',e.target.value)}/><small>仿真机上的串口路径</small></label>
        <label>波特率<select aria-label="转发波特率" value={draft.baud} onChange={e=>update('baud',Number(e.target.value))}>{[57600,115200,230400,460800,921600].map(n=><option key={n}>{n}</option>)}</select></label>
        <label>目标电脑 IPv4<input aria-label="转发目标电脑 IP" value={draft.host} onChange={e=>update('host',e.target.value)}/><small>电脑与仿真机相连网口的地址</small></label>
      </div></fieldset>
      <fieldset disabled={!snapshot||busy}><legend>双向转发通道</legend><div className="px4-router-fields">
        <label>QGroundControl UDP 端口<input aria-label="QGC 转发端口" type="number" min="1" max="65535" value={draft.qgc_port} onChange={e=>update('qgc_port',Number(e.target.value))}/></label>
        <label>PX4 工具箱 UDP 端口<input aria-label="工具箱转发端口" type="number" min="1" max="65535" value={draft.toolbox_port} onChange={e=>update('toolbox_port',Number(e.target.value))}/><small>应用后工具箱自动切换到新端口</small></label>
      </div></fieldset>
      {dirty&&invalid&&<div className="px4-notice error" role="alert">{invalid}</div>}
      <div className="px4-router-save"><small>保存会回读校验配置；服务运行时会重新启动转发，短暂中断两路通信。</small><div>
        <button type="button" disabled={!editing||busy} onClick={discard}>放弃修改</button><button className="px4-primary" type="submit" disabled={!snapshot||busy||!dirty||!!invalid}>{busy?'正在应用…':'保存并应用'}</button></div></div>
    </form>
    {message&&<div className="px4-notice" role="status">{message}</div>}
    <div className="px4-router-traffic"><h3>板端收发统计</h3><table><thead><tr><th>通道</th><th>飞控 → 电脑</th><th>电脑 → 飞控</th><th>错误</th></tr></thead><tbody>{snapshot?.routes.map(r=><tr key={r.name}><td>{r.name==='qgc'?'QGroundControl':'PX4 工具箱'}</td><td>{bytes(r.rx_bytes)}</td><td>{bytes(r.tx_bytes)}</td><td>{r.errors}{r.last_error?' · errno '+r.last_error:''}</td></tr>)}</tbody></table></div>
  </div>;
}
