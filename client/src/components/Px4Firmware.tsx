import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usbFileList, usbFileStorage, type UsbFileEntry } from '../utils/tauriApi';
import { isMicoAirApplication, isMicoAirBootloader, MICOAIR_H743_V2_BOARD, type FirmwareUsbTarget as UsbTarget } from '../px4/firmwareBootloader';
import './Px4Firmware.css';

type Metadata = { name:string; source:string; boardId:number; boardRevision:number; imageSize:number; description:string; gitIdentity:string; hardware?:string; compiledAt?:string|null; packageBuiltAt?:number|null };
type Firmware = Metadata & { id:number; simulator?:string|null; libraryId?:string|null };
type Entry = Metadata & { id:string; packageSize:number; savedAt:number; lastUsedAt:number|null };
type Library = { simulator:string; root:string; entries:Entry[]; warnings:string[] };
type Snapshot = { id:number; running:boolean; stage:string; completed:number; total:number; message:string; canCancel:boolean; target:UsbTarget|null; firmware:Firmware|null; board:{boardId:number; boardRevision:number; protocol:number; flashSize:number}|null; archive?:Entry|null };
const size = (n:number) => n >= 1048576 ? (n/1048576).toFixed(2)+' MiB' : (n/1024).toFixed(1)+' KiB';
const date = (n:number|null|undefined) => n ? new Date(n).toLocaleString('zh-CN',{hour12:false}) : '尚未使用';
const hardware = (f:Metadata) => f.hardware || `Board ID ${f.boardId}`;
const stages:Record<string,string> = {archive:'保存到固件库',waiting:'等待 Bootloader',upload:'上传固件',erase:'擦除 Flash',program:'写入固件',verify:'校验固件',reboot:'重启飞控',complete:'升级完成',error:'升级失败',cancelled:'已取消'};

export default function Px4Firmware({disabled=false,beforeOperation,onBusyChange,onSoftwareReboot}:{disabled?:boolean;beforeOperation:()=>Promise<void>;onBusyChange:(busy:boolean)=>void;onSoftwareReboot?:(target:UsbTarget)=>Promise<UsbTarget>}) {
  const [firmware,setFirmware]=useState<Firmware>(),[ports,setPorts]=useState<UsbTarget[]>([]),[port,setPort]=useState('');
  const [snapshot,setSnapshot]=useState<Snapshot>(),[busy,setBusy]=useState(''),[error,setError]=useState(''),[statusError,setStatusError]=useState('');
  const [library,setLibrary]=useState<Library>(),[libraryError,setLibraryError]=useState(''),[loadingLibrary,setLoadingLibrary]=useState(false),[selected,setSelected]=useState(''),[preparing,setPreparing]=useState(false);
  const [remote,setRemote]=useState(false),[directory,setDirectory]=useState('data'),[entries,setEntries]=useState<UsbFileEntry[]>([]),[listing,setListing]=useState(false),[listError,setListError]=useState('');
  const [volumes,setVolumes]=useState([{mountPath:'/data',volume:'data'},{mountPath:'/mnt/sdcard',volume:'sd'}]);
  const [listRevision,setListRevision]=useState(0),[acknowledged,setAcknowledged]=useState(false);
  const mounted=useRef(true),active=useRef(false),current=useRef<Snapshot>(),archiveJob=useRef(0),librarySequence=useRef(0),callbacks=useRef({beforeOperation,onBusyChange});
  callbacks.current={beforeOperation,onBusyChange};
  const running=!!snapshot?.running,locked=disabled||!!busy||running;
  const displayed=snapshot?.firmware?.id===firmware?.id?snapshot:undefined;
  const selectedEntry=library?.entries.find(e=>e.id===selected);
  const detail:Metadata|undefined=firmware||selectedEntry;
  const selectedTarget=ports.find(p=>p.path===port);
  const knownTarget=selectedTarget&&(isMicoAirApplication(selectedTarget)||isMicoAirBootloader(selectedTarget));
  const mismatch=!!knownTarget&&!!detail&&detail.boardId!==MICOAIR_H743_V2_BOARD;
  const softwareAvailable=!!onSoftwareReboot&&firmware?.boardId===MICOAIR_H743_V2_BOARD&&!!selectedTarget&&isMicoAirApplication(selectedTarget);
  const archived=firmware?.libraryId?library?.entries.find(e=>e.id===firmware.libraryId):selectedEntry;
  const loadLibrary=async()=>{
    const sequence=++librarySequence.current;setLoadingLibrary(true);setLibraryError('');
    try{
      const value=await invoke<Library>('px4_firmware_library');
      if(!mounted.current||sequence!==librarySequence.current)return;
      setLibrary(value);setSelected(id=>value.entries.some(e=>e.id===id)?id:value.entries[0]?.id||'');
      setFirmware(f=>f?.simulator&&f.simulator!==value.simulator?undefined:f);
    }catch(e){if(mounted.current&&sequence===librarySequence.current){setLibrary(undefined);setSelected('');setLibraryError(String(e));}}
    finally{if(mounted.current&&sequence===librarySequence.current)setLoadingLibrary(false);}
  };
  const receive=(s:Snapshot)=>{
    if(!mounted.current)return;const previous=current.current;
    if(previous&&(s.id<previous.id||(s.id===previous.id&&!previous.running&&s.running)))return;
    current.current=s;setSnapshot(s);setStatusError('');
    if(s.running&&s.firmware){setFirmware(s.firmware);setPreparing(true);}
    if(s.archive&&s.target&&archiveJob.current!==s.id){
      archiveJob.current=s.id;const archive=s.archive,host=s.target.simulator;
      setLibrary(value=>value?.simulator===host?{...value,entries:[archive,...value.entries.filter(e=>e.id!==archive.id)]}:value);
      setSelected(archive.id);
    }
    callbacks.current.onBusyChange(s.running||active.current);
  };
  const refreshPorts=async()=>{const value=await invoke<UsbTarget[]>('px4_firmware_ports');if(mounted.current){setPorts(value);setPort(id=>value.some(p=>p.path===id)?id:'');}};
  useEffect(()=>{
    mounted.current=true;let polling=false;
    const poll=async()=>{if(polling)return;polling=true;try{receive(await invoke<Snapshot>('px4_firmware_status'));}catch(e){if(mounted.current)setStatusError(String(e));}finally{polling=false;}};
    void poll();void refreshPorts().catch(e=>{if(mounted.current)setError(String(e));});void loadLibrary();
    const timer=setInterval(()=>void poll(),350);
    return()=>{mounted.current=false;librarySequence.current++;clearInterval(timer);};
  },[]);
  useEffect(()=>{setAcknowledged(false);},[firmware?.id,port]);
  useEffect(()=>{
    if(!remote)return;let disposed=false;
    void usbFileStorage().then(value=>{if(disposed)return;const available=value.filter(v=>v.totalBytes!==null);if(available.length){setVolumes(available);setDirectory(path=>available.some(v=>path===v.volume||path.startsWith(v.volume+'/'))?path:available[0].volume);}}).catch(()=>{});
    return()=>{disposed=true;};
  },[remote]);
  useEffect(()=>{
    if(!remote)return;let disposed=false;setListing(true);setListError('');setEntries([]);
    void usbFileList(directory).then(value=>{if(!disposed)setEntries(value.filter(e=>e.directory||e.name.toLowerCase().endsWith('.px4')));}).catch(e=>{if(!disposed)setListError(String(e));}).finally(()=>{if(!disposed)setListing(false);});
    return()=>{disposed=true;};
  },[remote,directory,listRevision]);
  const act=async(kind:string,operation:()=>Promise<void>)=>{
    if(active.current||disabled||current.current?.running)return;active.current=true;setBusy(kind);setError('');callbacks.current.onBusyChange(true);
    try{await callbacks.current.beforeOperation();await operation();}catch(e){if(mounted.current)setError(String(e));}
    finally{active.current=false;if(mounted.current){setBusy('');callbacks.current.onBusyChange(!!current.current?.running);}}
  };
  const accept=(value:Firmware)=>{if(!mounted.current)return;setAcknowledged(false);setFirmware(value);setSelected(value.libraryId||'');setPreparing(true);setSnapshot(undefined);setRemote(false);};
  const pickLocal=()=>act('pick',async()=>{const value=await invoke<Firmware|null>('px4_firmware_pick');if(value)accept(value);});
  const pickRemote=(name:string)=>act('remote',async()=>accept(await invoke<Firmware>('px4_firmware_remote',{path:directory+'/'+name})));
  const chooseLibrary=()=>act('select',async()=>{
    if(!selectedEntry||!library)throw Error('请先选择当前仿真机固件库中的固件');
    accept(await invoke<Firmware>('px4_firmware_select',{simulator:library.simulator,firmwareId:selectedEntry.id}));
  });
  const selectRow=(e:Entry)=>{if(locked)return;setSelected(e.id);setFirmware(undefined);setPreparing(false);setAcknowledged(false);setError('');};
  const start=(software=false)=>act(software?'software':'start',async()=>{
    if(!selectedTarget||!firmware||!acknowledged)throw Error('请选择固件、仿真机 USB 目标并确认升级准备');
    if(mismatch)throw Error('所选固件不支持当前飞控硬件');
    if(firmware.simulator&&firmware.simulator!==selectedTarget.simulator)throw Error('固件所属仿真机与升级目标不一致，请刷新固件库');
    if(software&&!softwareAvailable)throw Error('当前飞控的双向连接或固件选择不支持软件进入 Bootloader');
    const target=software?await onSoftwareReboot!(selectedTarget):selectedTarget;
    if(mounted.current)receive(await invoke<Snapshot>('px4_firmware_start',{selectionId:firmware.id,target}));
  });
  const cancel=async()=>{if(!snapshot?.canCancel)return;try{receive(await invoke<Snapshot>('px4_firmware_cancel',{id:snapshot.id}));}catch(e){setError(String(e));}};
  const selectedVolume=volumes.find(v=>directory===v.volume||directory.startsWith(v.volume+'/'));
  const selectedRoot=selectedVolume?.volume||'data';
  const displayDirectory=(selectedVolume?.mountPath||'/data')+directory.slice(selectedRoot.length);
  return <div className="px4-firmware">
    <header><div><h2>PX4 固件升级</h2><p>飞控 USB 插在仿真机上，从固件库选择后直接升级。</p></div><span className={'firmware-badge '+(displayed?.stage||'')}>{displayed?.stage?stages[displayed.stage]||displayed.stage:'准备升级'}</span></header>
    {error&&<div className="px4-notice error" role="alert">{error}</div>}
    {statusError&&<div className="px4-notice error" role="alert">升级状态读取失败：{statusError}</div>}
    <div className="firmware-retain"><strong>每次升级前，自动保存固件到仿真机</strong><span>保留原始 .px4 文件与编译信息。保存并回读校验成功后才开始刷写；相同固件复用文件，每次升级单独保存使用记录。</span></div>
    <div className="firmware-library-heading"><div><h3>仿真机固件库</h3>{library&&<span>{library.entries.length} 份固件</span>}</div><div className="firmware-actions">
      <button disabled={locked||loadingLibrary} onClick={()=>void loadLibrary()}>{loadingLibrary?'读取固件库…':'刷新固件库'}</button>
      <button disabled={locked} onClick={()=>void pickLocal()}>从本地导入</button>
      <button disabled={locked} aria-expanded={remote} onClick={()=>setRemote(v=>!v)}>从仿真机选择</button>
    </div></div>
    {libraryError&&<div className="px4-notice error" role="alert">固件库读取失败：{libraryError}</div>}
    {library?.warnings.map((warning,i)=><div key={i} className="px4-notice error" role="alert">{warning}</div>)}
    {remote&&<section className="firmware-browser" aria-label="仿真机固件文件">
      <div className="firmware-actions">{volumes.map(v=><button key={v.volume} disabled={locked} aria-pressed={selectedRoot===v.volume} onClick={()=>setDirectory(v.volume)}>{v.volume==='sd'?'SD 卡':v.mountPath==='/mnt/home'?'SSD':'数据盘'}</button>)}<button disabled={locked||directory===selectedRoot} onClick={()=>setDirectory(directory.slice(0,directory.lastIndexOf('/'))||selectedRoot)}>上一级</button></div>
      <code>{displayDirectory}</code><button disabled={locked||listing} onClick={()=>setListRevision(v=>v+1)}>刷新目录</button>{listError&&<div role="alert" className="px4-notice error">{listError}</div>}
      <div className="firmware-file-list">{listing?<p>读取目录中…</p>:entries.map(entry=><button key={entry.name} disabled={locked} onClick={()=>entry.directory?setDirectory(directory+'/'+entry.name):void pickRemote(entry.name)}><span>{entry.directory?'📁':'📄'} {entry.name}</span><small>{entry.directory?'打开':size(entry.size)}</small></button>)}{!listing&&!listError&&!entries.length&&<p className="px4-muted">此目录没有 .px4 固件包或子目录。</p>}</div>
    </section>}
    {busy==='remote'&&<p role="status">正在从仿真机读取并校验固件…</p>}
    {busy==='select'&&<p role="status">正在读取固件库原文件并验证完整性…</p>}
    <div className="firmware-grid firmware-library-grid"><section className="firmware-library-list" aria-label="已保存的 PX4 固件">
      <table className="firmware-table"><thead><tr><th>固件</th><th>编译日期 / 时间</th><th>支持的飞控硬件</th></tr></thead><tbody>
        {library?.entries.map(e=><tr key={e.id} className={selected===e.id?'selected':''}>
          <td><button className="firmware-name" disabled={locked} aria-pressed={selected===e.id} onClick={()=>selectRow(e)}>{e.name}</button><span className="firmware-version">{e.gitIdentity||'版本未提供'}</span></td>
          <td data-label="编译时间">{e.compiledAt?<time>{e.compiledAt.split(' ')[0]}<span>{e.compiledAt.split(' ')[1]}</span></time>:<span className="px4-muted">未提供</span>}</td>
          <td data-label="支持硬件"><span>{hardware(e)}</span><small>Board ID {e.boardId}</small></td>
        </tr>)}
      </tbody></table>
      {!loadingLibrary&&library&&!library.entries.length&&<p className="firmware-library-empty">尚无已保存的固件。首次升级前会自动保存，后续可在这里直接选择。</p>}
      {loadingLibrary&&!library&&<p role="status">正在读取仿真机固件库…</p>}
      <div className="firmware-library-foot"><span>{library?`${library.simulator} · ${library.root}`:'连接仿真机后显示固件库'}</span><span>编译时间与保存时间分开显示</span></div>
    </section><aside className="firmware-card firmware-detail" aria-label="固件详情">
      <div className="firmware-detail-heading"><h3>固件详情</h3>{detail&&<span className={'firmware-saved '+(archived?'saved':'')}>{archived?'已保存在仿真机':'升级前自动保存'}</span>}</div>
      {detail?<><strong className="firmware-detail-name">{detail.name}</strong><dl>
        <dt>编译时间</dt><dd>{detail.compiledAt||'未提供'}</dd><dt>支持硬件</dt><dd>{hardware(detail)}<small>Board ID {detail.boardId} · Revision {detail.boardRevision}</small></dd>
        <dt>固件版本</dt><dd><code>{detail.gitIdentity||'未提供'}</code></dd><dt>镜像大小</dt><dd>{size(detail.imageSize)}</dd>
        {archived&&<><dt>保存时间</dt><dd>{date(archived.savedAt)}</dd><dt>最近使用</dt><dd>{date(archived.lastUsedAt)}</dd></>}
        <dt>来源</dt><dd>{detail.source}</dd>
      </dl>
      {detail.description&&<p className="px4-muted">{detail.description}</p>}
      {!preparing&&<div className="firmware-actions"><button className="px4-primary" disabled={locked||!selectedEntry||!!libraryError} onClick={()=>void chooseLibrary()}>使用此固件升级</button></div>}
      {archived&&<details className="firmware-extra"><summary>文件信息</summary><p>原文件：{size(archived.packageSize)}</p><code>SHA-256：{archived.id}</code>{library&&<code>{library.root}/{archived.id}/firmware.px4</code>}</details>}
      {detail.packageBuiltAt&&<small className="firmware-package-date">固件包生成时间：{date(detail.packageBuiltAt*1000)}</small>}
      </>:<p className="px4-muted">选择历史固件查看详情，或从本地、仿真机选择新的 .px4 固件。</p>}
      {preparing&&firmware&&<section className="firmware-preparation" aria-label="升级准备">
        <h3>升级准备</h3><p className="px4-muted">请先停止仿真模型并上锁飞控，升级期间自动暂停 USB 的 HIL / MAVLink 读写。</p>
        <label className="firmware-port">仿真机 USB 目标<select aria-label="升级目标仿真机 USB" disabled={locked} value={port} onChange={e=>setPort(e.target.value)}><option value="">请选择目标飞控</option>{ports.map(p=><option key={p.path} value={p.path}>{p.label}</option>)}</select></label>
        <button disabled={locked} onClick={()=>void refreshPorts().catch(e=>setError(String(e)))}>刷新仿真机 USB</button>
        {!ports.length&&<p className="px4-muted">尚未发现仿真机上的 USB 飞控，请检查连接并刷新。</p>}
        {mismatch&&<p className="px4-notice error" role="alert">所选固件不支持当前飞控硬件，无法开始升级。</p>}
        <p>{selectedTarget&&isMicoAirBootloader(selectedTarget)?'已选择 Bootloader USB，保持连接即可升级。':'手动升级会先保存固件，再提示重新插拔所选飞控 USB。MicoAir H743-v2 双向连接时可选择软件重启并升级。'}</p>
        <label className="firmware-confirm"><input type="checkbox" checked={acknowledged} disabled={locked} onChange={e=>setAcknowledged(e.target.checked)}/>已拆桨、断开动力电源并备份参数，确认升级所选飞控。</label>
        <div className="firmware-actions">{softwareAvailable&&<button className="px4-primary" disabled={locked||!snapshot||!!statusError||!acknowledged||mismatch} onClick={()=>void start(true)}>软件重启并升级</button>}<button className={softwareAvailable?'':'px4-primary'} disabled={locked||!snapshot||!!statusError||!firmware||!port||!acknowledged||mismatch} onClick={()=>void start()}>{running?'升级进行中…':'开始升级'}</button>{snapshot?.canCancel&&<button onClick={()=>void cancel()}>取消等待</button>}</div>
        {busy==='software'&&<p role="status">正在通过 NSH 进入 Bootloader，请保持 USB 连接。</p>}
        <p className="px4-muted">固件库保存失败时不会擦除飞控。擦除后请保持供电和仿真机 USB 连接。</p>
      </section>}
    </aside></div>
    {snapshot?.stage&&snapshot.firmware?.id===firmware?.id&&<section className={'firmware-progress firmware-card '+snapshot.stage} aria-live="polite"><div><h3>{stages[snapshot.stage]}</h3>{snapshot.total>0&&<span>{Math.floor(snapshot.completed/snapshot.total*100)}%</span>}</div>{snapshot.running&&(snapshot.total>0?<progress max={snapshot.total} value={snapshot.completed}/>:<progress/>)}<p role={snapshot.stage==='error'?'alert':'status'}>{snapshot.stage==='waiting'&&snapshot.target&&isMicoAirBootloader(snapshot.target)?'固件已保存，正在与所选 Bootloader 握手，请保持 USB 连接。':snapshot.message}</p>{snapshot.board&&<small>飞控 Board ID {snapshot.board.boardId} · Revision {snapshot.board.boardRevision} · Bootloader v{snapshot.board.protocol} · Flash {size(snapshot.board.flashSize)}</small>}{snapshot.archive&&<small>✓ 原始固件及本次使用记录已保存到仿真机固件库</small>}{snapshot.target&&<small>仿真机 USB：{snapshot.target.label}</small>}</section>}
  </div>;
}
