import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usbFileList, usbFileStorage, type UsbFileEntry } from '../utils/tauriApi';
import './Px4Firmware.css';

type Firmware = { id:number; name:string; source:string; boardId:number; boardRevision:number; imageSize:number; description:string; gitIdentity:string };
type UsbTarget = { simulator:string; path:string; vid:number; pid:number; serialNumber:string|null; label:string };
type Snapshot = { id:number; running:boolean; stage:string; completed:number; total:number; message:string; canCancel:boolean; target:UsbTarget|null; firmware:Firmware|null; board:{boardId:number; boardRevision:number; protocol:number; flashSize:number}|null };
const size = (n:number) => n >= 1048576 ? (n/1048576).toFixed(2)+' MiB' : (n/1024).toFixed(1)+' KiB';
const stages:Record<string,string> = {waiting:'等待 Bootloader',erase:'擦除 Flash',program:'写入固件',verify:'校验固件',reboot:'重启飞控',complete:'升级完成',error:'升级失败',cancelled:'已取消'};

export default function Px4Firmware({disabled=false,beforeOperation,onBusyChange}:{disabled?:boolean;beforeOperation:()=>Promise<void>;onBusyChange:(busy:boolean)=>void}) {
  const [firmware,setFirmware]=useState<Firmware>(),[ports,setPorts]=useState<UsbTarget[]>([]),[port,setPort]=useState('');
  const [snapshot,setSnapshot]=useState<Snapshot>(),[busy,setBusy]=useState(''),[error,setError]=useState(''),[statusError,setStatusError]=useState('');
  const [remote,setRemote]=useState(false),[directory,setDirectory]=useState('/data'),[entries,setEntries]=useState<UsbFileEntry[]>([]),[listing,setListing]=useState(false),[listError,setListError]=useState('');
  const [volumes,setVolumes]=useState([{mountPath:'/data',volume:'data'},{mountPath:'/mnt/sdcard',volume:'sd'}]);
  const [listRevision,setListRevision]=useState(0);
  const [acknowledged,setAcknowledged]=useState(false);
  const mounted=useRef(true),active=useRef(false),current=useRef<Snapshot>(),callbacks=useRef({beforeOperation,onBusyChange}); callbacks.current={beforeOperation,onBusyChange};
  const running=!!snapshot?.running,locked=disabled||!!busy||running;
  const displayed=snapshot?.firmware?.id===firmware?.id?snapshot:undefined;
  const receive=(s:Snapshot)=>{if(!mounted.current)return;const previous=current.current;if(previous&&(s.id<previous.id||(s.id===previous.id&&!previous.running&&s.running)))return;current.current=s;setSnapshot(s);setStatusError('');if(s.running&&s.firmware)setFirmware(s.firmware);callbacks.current.onBusyChange(s.running||active.current);};
  const refreshPorts=async()=>{const value=await invoke<UsbTarget[]>('px4_firmware_ports');if(mounted.current){setPorts(value);setPort(selected=>value.some(p=>p.path===selected)?selected:'');}};
  useEffect(()=>{
    mounted.current=true;let polling=false;
    const poll=async()=>{if(polling)return;polling=true;try{receive(await invoke<Snapshot>('px4_firmware_status'));}catch(e){if(mounted.current)setStatusError(String(e));}finally{polling=false;}};
    void poll();void refreshPorts().catch(e=>{if(mounted.current)setError(String(e));});const timer=setInterval(()=>void poll(),350);
    return()=>{mounted.current=false;clearInterval(timer);};
  },[]);
  useEffect(()=>{setAcknowledged(false);},[firmware?.id,port]);
  useEffect(()=>{
    if(!remote)return;let disposed=false;
    void usbFileStorage().then(value=>{if(disposed)return;const available=value.filter(v=>v.totalBytes!==null);if(available.length){setVolumes(available);setDirectory(path=>available.some(v=>path===v.mountPath||path.startsWith(v.mountPath+'/'))?path:available[0].mountPath);}}).catch(()=>{});
    return()=>{disposed=true;};
  },[remote]);
  useEffect(()=>{
    if(!remote)return;let disposed=false;setListing(true);setListError('');setEntries([]);
    void usbFileList(directory).then(value=>{if(!disposed)setEntries(value.filter(e=>e.name!=='.'&&e.name!=='..'&&(e.directory||e.name.toLowerCase().endsWith('.px4'))).sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name)));}).catch(e=>{if(!disposed)setListError(String(e));}).finally(()=>{if(!disposed)setListing(false);});
    return()=>{disposed=true;};
  },[remote,directory,listRevision]);
  const act=async(kind:string,task:()=>Promise<void>)=>{
    if(active.current||disabled||current.current?.running)return;
    active.current=true;setBusy(kind);setError('');
    try{await callbacks.current.beforeOperation();await task();}catch(e){if(mounted.current)setError(String(e));}
    finally{active.current=false;callbacks.current.onBusyChange(!!current.current?.running);if(mounted.current)setBusy('');}
  };
  const pickLocal=()=>act('pick',async()=>{const value=await invoke<Firmware|null>('px4_firmware_pick');if(value&&mounted.current){setAcknowledged(false);setFirmware(value);setSnapshot(undefined);}});
  const pickRemote=(name:string)=>act('remote',async()=>{const value=await invoke<Firmware>('px4_firmware_remote',{path:directory+'/'+name});if(mounted.current){setAcknowledged(false);setFirmware(value);setSnapshot(undefined);setRemote(false);}});
  const start=()=>act('start',async()=>{
    const target=ports.find(p=>p.path===port);if(!target||!firmware||!acknowledged)throw Error('请选择固件、仿真机 USB 目标并确认升级准备');
    receive(await invoke<Snapshot>('px4_firmware_start',{selectionId:firmware.id,target}));
  });
  const cancel=async()=>{if(!snapshot?.canCancel)return;try{receive(await invoke<Snapshot>('px4_firmware_cancel',{id:snapshot.id}));}catch(e){setError(String(e));}};
  const selectedRoot=volumes.find(v=>directory===v.mountPath||directory.startsWith(v.mountPath+'/'))?.mountPath||'/data';
  return <div className="px4-firmware">
    <header><div><h2>PX4 固件升级</h2><p>飞控 USB 插在仿真机上，由仿真机完成固件刷写。</p></div><span className={'firmware-badge '+(displayed?.stage||'')}>{displayed?.stage?stages[displayed.stage]||displayed.stage:'准备升级'}</span></header>
    {error&&<div className="px4-notice error" role="alert">{error}</div>}
    {statusError&&<div className="px4-notice error" role="alert">无法读取升级状态：{statusError}</div>}
    <div className="firmware-grid"><section className="firmware-card">
      <h3>1. 选择固件</h3><div className="firmware-actions"><button disabled={locked||!snapshot} onClick={()=>void pickLocal()}>从本地选择</button><button disabled={locked||!snapshot} aria-expanded={remote} onClick={()=>setRemote(v=>!v)}>从仿真机选择</button></div>
      {busy==='remote'&&<p role="status">正在从仿真机读取并校验固件…</p>}
      {firmware?<dl><dt>文件</dt><dd>{firmware.name}</dd><dt>来源</dt><dd>{firmware.source}</dd><dt>板型</dt><dd>Board ID {firmware.boardId} · Revision {firmware.boardRevision}</dd><dt>镜像</dt><dd>{size(firmware.imageSize)}</dd>{firmware.description&&<><dt>描述</dt><dd>{firmware.description}</dd></>}{firmware.gitIdentity&&<><dt>版本</dt><dd><code>{firmware.gitIdentity}</code></dd></>}</dl>:<p className="px4-muted">支持本地编译或下载的 .px4 固件包。支持本地或仿真机文件，升级通过仿真机的独占 USB 通道执行。</p>}
      {remote&&<div className="firmware-browser" aria-label="仿真机固件文件">
        <div className="firmware-actions">{volumes.map(v=><button key={v.mountPath} disabled={locked} aria-pressed={selectedRoot===v.mountPath} onClick={()=>setDirectory(v.mountPath)}>{v.volume==='sd'?'SD 卡':v.mountPath==='/mnt/home'?'SSD':'数据盘'}</button>)}<button disabled={locked||directory===selectedRoot} onClick={()=>setDirectory(directory.slice(0,directory.lastIndexOf('/'))||selectedRoot)}>上一级</button></div>
        <code>{directory}</code><button disabled={locked||listing} onClick={()=>setListRevision(v=>v+1)}>刷新目录</button>{listError&&<div role="alert" className="px4-notice error">{listError}</div>}
        <div className="firmware-file-list">{listing?<p>读取目录中…</p>:entries.map(entry=><button key={entry.name} disabled={locked} onClick={()=>entry.directory?setDirectory(directory+'/'+entry.name):void pickRemote(entry.name)}><span>{entry.directory?'📁':'📄'} {entry.name}</span><small>{entry.directory?'打开':size(entry.size)}</small></button>)}{!listing&&!listError&&!entries.length&&<p className="px4-muted">此目录没有 .px4 固件包或子目录。</p>}</div>
      </div>}
    </section><section className="firmware-card">
      <h3>2. 选择仿真机上的飞控</h3><p className="px4-muted">飞控 USB 保持连接仿真机。请先停止仿真模型并上锁飞控，升级期间自动暂停 USB 的 HIL / MAVLink 读写。</p>
      <label className="firmware-port">仿真机 USB 目标<select aria-label="升级目标仿真机 USB" disabled={locked} value={port} onChange={e=>setPort(e.target.value)}><option value="">请选择目标飞控</option>{ports.map(p=><option key={p.path} value={p.path}>{p.label}</option>)}</select></label>
      <button disabled={locked} onClick={()=>void refreshPorts().catch(e=>setError(String(e)))}>刷新仿真机 USB</button>
      {!ports.length&&<p className="px4-muted">尚未发现仿真机上的 USB 飞控，请检查连接并刷新。</p>}
      <h3>3. 开始升级</h3><p>开始后请在 45 秒内于仿真机上重新插拔所选飞控 USB，以进入 Bootloader。识别板型并检查容量后自动擦除、写入和校验。</p>
      <label className="firmware-confirm"><input type="checkbox" checked={acknowledged} disabled={locked} onChange={e=>setAcknowledged(e.target.checked)}/>已拆桨、断开动力电源并备份参数，确认升级所选飞控。</label>
      <div className="firmware-actions"><button className="px4-primary" disabled={locked||!snapshot||!!statusError||!firmware||!port||!acknowledged} onClick={()=>void start()}>{running?'升级进行中…':'开始升级'}</button>{snapshot?.canCancel&&<button onClick={()=>void cancel()}>取消等待</button>}</div>
      <p className="px4-muted">擦除开始后请保持供电、网络和仿真机 USB 连接；写入或校验失败后可重新进入 Bootloader 升级。</p>
    </section></div>
    {snapshot?.stage&&snapshot.firmware?.id===firmware?.id&&<section className={'firmware-progress firmware-card '+snapshot.stage} aria-live="polite"><div><h3>{stages[snapshot.stage]}</h3>{snapshot.total>0&&<span>{Math.floor(snapshot.completed/snapshot.total*100)}%</span>}</div>{snapshot.running&&(snapshot.total>0?<progress max={snapshot.total} value={snapshot.completed}/>:<progress/>)}<p role={snapshot.stage==='error'?'alert':'status'}>{snapshot.message}</p>{snapshot.board&&<small>飞控 Board ID {snapshot.board.boardId} · Revision {snapshot.board.boardRevision} · Bootloader v{snapshot.board.protocol} · Flash {size(snapshot.board.flashSize)}</small>}{snapshot.target&&<small>仿真机 USB：{snapshot.target.label}</small>}</section>}
  </div>;
}
