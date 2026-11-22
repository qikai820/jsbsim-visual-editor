import { useEffect, useRef, useState } from 'react';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, currentMonitor, PhysicalPosition } from '@tauri-apps/api/window';
import { installToolboxHost, installToolboxOwner, notifyToolboxHidden, notifyToolboxScene, sendToolboxView, TOOLBOX_WINDOW } from '../flight-test/windowBridge';
import { hideTestToolbox, setRemoteTestController, useFlightTestStore } from '../flight-test/session';
import Px4Toolbox from './Px4Toolbox';
import WindowControls from './WindowControls';
import '../App.css';

const BOUNDS_KEY='px4-toolbox-native-bounds-v1';
type Bounds={x:number;y:number;width:number;height:number;maximized:boolean};
function savedBounds():Bounds|null{try{const b=JSON.parse(localStorage.getItem(BOUNDS_KEY)||'null');return b&&[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>=320&&b.height>=300?b:null;}catch{return null;}}
export function isNativeToolboxHost(){
  return (window as unknown as {__TAURI_INTERNALS__?:{metadata?:{currentWindow?:{label?:string}}}}).__TAURI_INTERNALS__?.metadata?.currentWindow?.label==='main';
}
let opening:Promise<WebviewWindow>|null=null;
async function toolboxWindow():Promise<WebviewWindow>{
  if(opening)return opening;
  opening=(async()=>{
    const existing=await WebviewWindow.getByLabel(TOOLBOX_WINDOW);if(existing)return existing;
    const saved=savedBounds(),monitors=await availableMonitors();
    const savedMonitor=saved&&monitors.find(m=>saved.x>=m.workArea.position.x&&saved.y>=m.workArea.position.y&&saved.x+80<=m.workArea.position.x+m.workArea.size.width&&saved.y+40<=m.workArea.position.y+m.workArea.size.height);
    const monitor=savedMonitor||await currentMonitor()||monitors[0];
    const area=monitor?.workArea.size.toLogical(monitor.scaleFactor),width=area?.width||1400,height=area?.height||900;
    const child=new WebviewWindow(TOOLBOX_WINDOW,{url:'index.html?window=px4-toolbox',title:'PX4 工具箱',
      width:Math.min(saved?.width||width*.94,width-16),height:Math.min(saved?.height||height*.9,height-40),
      minWidth:Math.min(360,width-16),minHeight:Math.min(400,height-40),decorations:false,resizable:true,visible:false,center:true,dragDropEnabled:false});
    await new Promise<void>((resolve,reject)=>{void child.once('tauri://created',()=>resolve());void child.once('tauri://error',e=>reject(Error(String(e.payload))));});
    // Some window managers disallow programmatic placement. Keep the window
    // usable at its centered default if restoring a position is unsupported.
    if(savedMonitor&&saved)await child.setPosition(new PhysicalPosition(saved.x,saved.y)).catch(()=>{});
    if(saved?.maximized)await child.maximize().catch(()=>{});
    return child;
  })();
  try{return await opening;}finally{opening=null;}
}

export default function Px4ToolboxWindowHost({visible,visited,onShowScene}:{visible:boolean;visited:boolean;onShowScene:()=>void}){
  const native=isNativeToolboxHost(),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const openRequest=useFlightTestStore(s=>s.toolboxOpenRequest);
  const onScene=useRef(onShowScene);onScene.current=onShowScene;
  const hostReady=useRef<Promise<void>>(Promise.resolve());
  useEffect(()=>{
    if(!native)return;
    let disposed=false,stop:(()=>void)|undefined;
    hostReady.current=installToolboxHost(()=>setError(''),()=>onScene.current()).then(fn=>{if(disposed)fn();else stop=fn;}).catch(e=>setError(String(e)));
    return()=>{disposed=true;stop?.();};
  },[native]);
  useEffect(()=>{
    if(!native||!visited||!visible)return;
    let disposed=false;
    void hostReady.current.then(()=>toolboxWindow()).then(async child=>{
      if(disposed)return;
      await sendToolboxView();await child.show();await child.unminimize();await child.setFocus();setError('');
    }).catch(e=>{if(!disposed)setError('无法打开 PX4 独立窗口：'+String(e));});
    return()=>{disposed=true;};
  },[native,visited,visible,retry,openRequest]);
  if(!native)return visited?<Px4Toolbox visible={visible} onClose={hideTestToolbox} onShowScene={onShowScene}/>:null;
  return error&&visible?<div className="px4-window-error" role="alert">{error}<button onClick={()=>setRetry(v=>v+1)}>重试打开</button><button onClick={hideTestToolbox}>关闭</button></div>:null;
}

export function NativePx4Toolbox(){
  const [visible,setVisible]=useState(true),[error,setError]=useState('');
  const hide=async()=>{try{await getCurrentWebviewWindow().hide();setVisible(false);await notifyToolboxHidden();}catch(e){setError(String(e));}};
  useEffect(()=>{
    const child=getCurrentWebviewWindow();let disposed=false;const stops:Array<()=>void>=[];
    let saveTimer:ReturnType<typeof setTimeout>|undefined;
    const keep=(p:Promise<()=>void>)=>{void p.then(fn=>{if(disposed)fn();else stops.push(fn);}).catch(e=>{if(!disposed)setError(String(e));});};
    const save=()=>{clearTimeout(saveTimer);saveTimer=setTimeout(()=>{void(async()=>{
      const maximized=await child.isMaximized();if(await child.isMinimized())return;
      const previous=savedBounds();
      if(maximized&&previous){localStorage.setItem(BOUNDS_KEY,JSON.stringify({...previous,maximized}));return;}
      const [position,size,scale]=await Promise.all([child.outerPosition(),child.innerSize(),child.scaleFactor()]);
      const logical=size.toLogical(scale);localStorage.setItem(BOUNDS_KEY,JSON.stringify({x:position.x,y:position.y,width:logical.width,height:logical.height,maximized}));
    })().catch(()=>{});},250);};
    keep(child.onCloseRequested(event=>{event.preventDefault();void hide();}));
    keep(child.onMoved(save));keep(child.onResized(save));
    keep(installToolboxOwner(view=>{
      setVisible(view.visible);
      if(view.visible)void child.show().catch(e=>setError(String(e)));else void child.hide().catch(e=>setError(String(e)));
    }));
    save();
    return()=>{disposed=true;clearTimeout(saveTimer);stops.forEach(fn=>fn());setRemoteTestController(null);};
  },[]);
  const scene=()=>{void notifyToolboxScene().then(()=>hide()).catch(e=>setError(String(e)));};
  const maximize=()=>{void getCurrentWebviewWindow().toggleMaximize().catch(e=>setError(String(e)));};
  return <div className="px4-toolbox-native-root">{error&&<div className="px4-notice error" role="alert">{error}</div>}<Px4Toolbox nativeWindow visible={visible} onClose={()=>void hide()} onShowScene={scene}
    windowControls={<WindowControls onClose={hide}/>} onWindowMaximize={maximize}
    onWindowDrag={event=>{if(event.button!==0||(event.target as HTMLElement).closest('button,input,select,textarea,a'))return;event.preventDefault();void getCurrentWebviewWindow().startDragging().catch(e=>setError(String(e)));}}/>
    {(['North','NorthEast','East','SouthEast','South','SouthWest','West','NorthWest'] as const).map(direction=><div key={direction} className={'px4-window-resize px4-resize-'+direction} aria-hidden="true" onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();void getCurrentWebviewWindow().startResizeDragging(direction).catch(e=>setError(String(e)));}}/>)}</div>;
}
