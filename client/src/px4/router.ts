import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
export type RouterConfig = { device:string; baud:number; host:string; qgc_port:number; toolbox_port:number };
export type RouterSnapshot = { simulator:string; state:'running'|'stopped'|'starting'|'stopping'; config:RouterConfig; active_config:RouterConfig;
  routes:Array<{name:string;rx_bytes:number;tx_bytes:number;errors:number;last_error:number}> };
export const DEFAULT_ROUTER_CONFIG:RouterConfig = {device:'/dev/ttyACM0',baud:921600,host:'192.168.3.109',qgc_port:14550,toolbox_port:14553};
export function validateRouterConfig(c:RouterConfig):string {
  if (!/^\/dev\/tty(?:ACM|USB)\d{1,2}$/.test(c.device)) return '请输入仿真机板端 USB 串口路径，例如 /dev/ttyACM0';
  if (![57600,115200,230400,460800,921600].includes(c.baud)) return '不支持的波特率';
  const octets=c.host.split('.').map(Number);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(c.host)||octets.some(n=>n>255)||octets[0]===0||octets[0]===127||octets[0]>=224) return '请输入电脑的有效 IPv4 地址';
  if (![c.qgc_port,c.toolbox_port].every(n=>Number.isInteger(n)&&n>0&&n<=65535)) return 'UDP 端口范围为 1～65535';
  if (c.qgc_port===c.toolbox_port) return 'QGC 与工具箱必须使用不同的 UDP 端口';
  return '';
}
export function usePx4Router() {
  const [snapshot,setSnapshot]=useState<RouterSnapshot>(),[readError,setReadError]=useState(''),[operationError,setOperationError]=useState(''),[busy,setBusy]=useState(false);
  const active=useRef(true),working=useRef(false),reading=useRef(false),revision=useRef(0);
  const refresh=async()=>{
    if(working.current||reading.current)return;
    reading.current=true;
    const version=revision.current;
    try { const next=await invoke<RouterSnapshot>('px4_router_read');if(active.current&&revision.current===version){setSnapshot(next);setReadError('');} }
    catch(e){if(active.current&&revision.current===version)setReadError(String(e));}
    finally{reading.current=false;}
  };
  useEffect(()=>{active.current=true;void refresh();const timer=setInterval(()=>void refresh(),3000);return()=>{active.current=false;clearInterval(timer);};},[]);
  const mutate=async(command:string,args:Record<string,unknown>)=>{
    if(working.current)throw Error('转发服务正在处理上一项操作');
    working.current=true;revision.current++;setBusy(true);setOperationError('');
    try {const next=await invoke<RouterSnapshot>(command,args);if(active.current)setSnapshot(next);return next;}
    catch(e){if(active.current)setOperationError(String(e));throw e;}
    finally{working.current=false;if(active.current)setBusy(false);void refresh();}
  };
  return {snapshot,error:operationError||readError,busy,refresh,clearError:()=>setOperationError(''),apply:(config:RouterConfig,expected:RouterConfig,simulator:string)=>mutate('px4_router_apply',{config,expected,simulator}),control:(action:'start'|'stop')=>mutate('px4_router_control',{action,simulator:snapshot?.simulator})};
}
export type RouterController=ReturnType<typeof usePx4Router>;
