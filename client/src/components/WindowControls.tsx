import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './WindowControls.css';

/** Always operate on this webview's window, including detached tool windows. */
export default function WindowControls({onClose,zh=true}:{onClose?:()=>void|Promise<void>;zh?:boolean}){
  const [maximized,setMaximized]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    let disposed=false,stop:(()=>void)|undefined;
    try{
      const current=getCurrentWindow();
      const refresh=()=>void current.isMaximized().then(value=>{if(!disposed)setMaximized(value);}).catch(()=>{});
      refresh();void current.onResized(refresh).then(fn=>{if(disposed)fn();else stop=fn;}).catch(()=>{});
    }catch{/* A browser preview has no native window. */}
    return()=>{disposed=true;stop?.();};
  },[]);
  const act=async(action:'minimize'|'maximize'|'close')=>{
    if(busy)return;setBusy(true);setError('');
    try{
      const current=getCurrentWindow();
      if(action==='minimize')await current.minimize();
      else if(action==='maximize'){await current.toggleMaximize();setMaximized(await current.isMaximized());}
      else if(onClose)await onClose();else await current.close();
    }catch(e){setError((zh?'窗口操作失败：':'Window action failed: ')+String(e));}
    finally{setBusy(false);}
  };
  const min=zh?'最小化':'Minimize',max=zh?(maximized?'还原窗口':'最大化窗口'):(maximized?'Restore window':'Maximize window'),close=zh?'关闭':'Close';
  return <div className="window-controls native-window-controls" onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()}>
    <button type="button" disabled={busy} data-window-action="minimize" aria-label={min} title={min} onClick={()=>void act('minimize')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10"/></svg></button>
    <button type="button" disabled={busy} data-window-action="maximize" aria-label={max} title={max} onClick={()=>void act('maximize')}><svg viewBox="0 0 16 16" aria-hidden="true">{maximized?<><path d="M6 3h7v7M3 6h7v7H3z"/></>:<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>}</svg></button>
    <button type="button" disabled={busy} className="window-close" data-window-action="close" aria-label={close} title={close} onClick={()=>void act('close')}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
    {error&&<div className="window-control-error" role="alert">{error}<button type="button" onClick={()=>setError('')}>{zh?'关闭提示':'Dismiss'}</button></div>}
  </div>;
}
