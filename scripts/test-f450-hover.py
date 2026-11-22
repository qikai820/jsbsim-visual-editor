#!/usr/bin/env python3
"""Joint F450 flight acceptance through the running desktop's shared test engine.

No direct MAVLink transport, second flight controller, parameter changes or force-arm.
Use --run to execute; without it this only prepares the compiled UI test source.
"""
import argparse
import datetime
import importlib.util
import ipaddress
import json
import math
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
PROFILE = ROOT/'examples/flight-tests/f450-hover/hover.xml'
LIMITS = {'targetM':5.0,'hoverSeconds':30.0,'heightErrorM':0.5,'horizontalDriftM':1.0,
          'tiltDeg':5.0,'horizontalSpeedMps':0.3,'verticalSpeedMps':0.2}
TERMINAL = {'passed','failed','stopped','idle'}
class Blocked(RuntimeError): pass

def number(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):
        raise ValueError('missing or non-finite measurement')
    return float(value)

def scene_of(status):
    return next((s for s in status.get('scene',[]) if str(s.get('instance_id','')).zfill(2)=='01' and s.get('model')=='F450_PX4'),None)

def check_preflight(status):
    if 'localSimulation' not in status:
        raise Blocked('当前上位机缺少 localSimulation 状态，请重新编译并重启上位机；原始状态已保存到 preflight.json')
    local=status.get('localSimulation',{})
    missing=[k for k in ('active','ready','serviceRunning','px4Running') if local.get(k) is not True]
    if missing:
        raise Blocked('本地仿真尚未就绪：'+', '.join(missing)+(('; '+local['error']) if local.get('error') else ''))
    if local.get('bundled') is not True and local.get('localPx4Matched') is not True:
        raise Blocked('未核实本地 PX4 与模型的 HIL 目标一致；请打开软件飞控页面检查本机模型连接')
    connection=status.get('connection',{})
    peer=connection.get('peer') or ''
    try: loopback=ipaddress.ip_address(peer.rsplit(':',1)[0]).is_loopback
    except ValueError: loopback=False
    if not loopback or not connection.get('connected') or not connection.get('fresh') or connection.get('hil') is not True:
        raise Blocked('尚无本机软件飞控的新鲜 HIL 心跳；UDP HIL 需 commander start -h，请更新后停止并重新启动 PX4，再打开工具箱')
    try:
        for name in ('local-x-m','local-y-m','relative-alt-m'):
            number(connection.get('values',{}).get('test/fc/'+name))
    except ValueError as error:
        raise Blocked('PX4 尚未输出有效本地/全球位置；检查 HIL 传感器接收和 EKF，就绪前不执行起飞') from error
    if connection.get('armed') is not False or connection.get('values',{}).get('test/fc/landed')!=1:
        raise Blocked('测试必须从已上锁、已落地状态开始')
    if status.get('test',{}).get('status','idle') not in TERMINAL:
        raise Blocked('上位机已有其他测试运行；未创建第二个控制源')
    scene=scene_of(status)
    if not scene or scene.get('state')!='running' or number(scene.get('age_ms',math.inf))>1000:
        raise Blocked('实例 01 需要正在运行且遥测新鲜的 F450_PX4 模型')
    number(scene.get('altitude_m'))
    return scene

def metric_samples(points):
    if len(points)<2: raise ValueError('insufficient samples')
    x0,y0=points[0]['x'],points[0]['y']
    return {'samples':len(points),'coverageS':points[-1]['time']-points[0]['time'],
            'maxGapS':max(b['time']-a['time'] for a,b in zip(points,points[1:])),
            'maxHeightErrorM':max(abs(p['height']-LIMITS['targetM']) for p in points),
            'heightRmsErrorM':math.sqrt(sum((p['height']-LIMITS['targetM'])**2 for p in points)/len(points)),
            'maxHorizontalDriftM':max(math.hypot(p['x']-x0,p['y']-y0) for p in points),
            'maxTiltDeg':max(max(abs(p['roll']),abs(p['pitch'])) for p in points),
            'maxHorizontalSpeedMps':max(abs(p['horizontalSpeed']) for p in points),
            'maxVerticalSpeedMps':max(abs(p['verticalSpeed']) for p in points)}

def evaluate(report,scene_samples,ground):
    result=report.get('result',{})
    errors=[]
    if result.get('dryRun') is not False: errors.append('dry-run reports cannot pass real flight acceptance')
    if result.get('status')!='passed': errors.append('desktop test did not pass')
    binding=result.get('binding') or {}
    if binding.get('model')!='F450_PX4' or binding.get('instance')!=1: errors.append('wrong bound model or instance')
    def marked(label):
        return next(number(e['time']) for e in result.get('logs',[]) if '::'+label in e.get('message',''))
    try: begin,end=marked('HOVER_BEGIN'),marked('HOVER_END')
    except (StopIteration,ValueError,KeyError): return {'passed':False,'errors':errors+['hover markers missing'],'limits':LIMITS}
    if end-begin<29.9: errors.append('hover interval is shorter than 30 seconds')
    fc=[];truth=[]
    try:
        for sample in report.get('trace',[]):
            t=number(sample['time'])
            if begin<=t<=end:
                v=sample['values'];get=lambda k:number(v['test/fc/'+k])
                fc.append(dict(time=t,height=get('relative-alt-m'),x=get('local-x-m'),y=get('local-y-m'),
                    roll=get('roll-abs-deg'),pitch=get('pitch-abs-deg'),horizontalSpeed=get('groundspeed-mps'),verticalSpeed=get('climb-rate-mps')))
        selected=[s for s in scene_samples if begin<=number(s['time'])<=end]
        if selected:
            lat0=math.radians(number(selected[0]['latitude_deg']));lon0=number(selected[0]['longitude_deg'])
            for s in selected:
                if number(s['age_ms'])>1000: raise ValueError('stale ground-truth pose')
                truth.append(dict(time=number(s['time']),modelTime=number(s.get('timestamp',s.get('t'))),height=number(s['altitude_m'])-number(ground['altitude_m']),
                    x=(math.radians(number(s['latitude_deg']))-lat0)*6371000,
                    y=math.radians(number(s['longitude_deg'])-lon0)*6371000*math.cos(lat0),
                    roll=number(s['roll_deg']),pitch=number(s['pitch_deg']),horizontalSpeed=number(s['groundspeed_mps']),
                    verticalSpeed=number(s['vertical_speed_mps'])))
        metrics={'flightController':metric_samples(fc),'modelGroundTruth':metric_samples(truth)}
        metrics['modelGroundTruth']['simulationCoverageS']=truth[-1]['modelTime']-truth[0]['modelTime']
        if metrics['modelGroundTruth']['simulationCoverageS']<28.5 or any(b['modelTime']<=a['modelTime'] for a,b in zip(truth,truth[1:])):
            errors.append('ground-truth model time did not continuously advance for the hover window')
        for name,m in metrics.items():
            count,gap=(270,.5) if name=='flightController' else (45,1.1)
            if m['samples']<count or m['coverageS']<28.5 or m['maxGapS']>gap: errors.append(name+': sample count, coverage or gaps fail')
            if any(b['time']<=a['time'] for a,b in zip(fc if name=='flightController' else truth,(fc if name=='flightController' else truth)[1:])): errors.append(name+': time did not advance')
            for field,limit in [('maxHeightErrorM','heightErrorM'),('maxHorizontalDriftM','horizontalDriftM'),('maxTiltDeg','tiltDeg'),('maxHorizontalSpeedMps','horizontalSpeedMps'),('maxVerticalSpeedMps','verticalSpeedMps')]:
                if m[field]>LIMITS[limit]:errors.append(f'{name}: {field} exceeds {LIMITS[limit]}')
    except (KeyError,ValueError,TypeError) as error:
        return {'passed':False,'errors':errors+['measurement evidence incomplete: '+str(error)],'limits':LIMITS}
    v=result.get('values',{})
    if v.get('test/fc/landed')!=1 or v.get('test/fc/armed')!=0:errors.append('final landing and disarming not both confirmed')
    return {'passed':not errors,'errors':errors,'limits':LIMITS,'hoverBeginS':begin,'hoverEndS':end,'metrics':metrics}

def save(path,value):
    temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
    temporary.replace(path)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--run',action='store_true',help='execute through the current desktop; requires verified ready local simulation')
    mode.add_argument('--diagnose',action='store_true',help='save current desktop status and check readiness without flight commands')
    parser.add_argument('--endpoint',type=Path)
    parser.add_argument('--output',type=Path,default=ROOT.parent/'diagnostics'/('f450-joint-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')))
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    result={'status':'prepared','flightTest':False,'commandsIssued':False,'limits':LIMITS}
    identity=None;adapter=None;endpoint=None;stop_requested=False;finished=False;report=None;observations=[];ground=None
    def call(name,arguments=None):return adapter.call_upper(endpoint,name,arguments or {})
    try:
        node=shutil.which('node') or str(ROOT/'.toolchains/node/bin/node')
        subprocess.run([node,str(ROOT/'scripts/build-f450-hover-test.mjs')],cwd=ROOT,check=True)
        source=PROFILE.read_text();(args.output/'hover.xml').write_text(source)
        if not args.run and not args.diagnose:return 0
        try:
            with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as test:test.bind(('127.0.0.1',0))
        except OSError as error:raise Blocked(f'当前执行环境禁止本机套接字：{error}；尚未执行解锁或起飞') from error
        spec=importlib.util.spec_from_file_location('upper_adapter',ROOT/'tools/upper-mcp/server.py')
        adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
        endpoint=args.endpoint or adapter.default_endpoint()
        state=call('upper_get_status');save(args.output/'preflight.json',state);ground=check_preflight(state)
        if args.diagnose:
            result.update(status='ready',flightTest=False,commandsIssued=False)
            return 0
        call('upper_validate_script',{'source':source})
        result.update(status='running',flightTest=True,commandsIssued=True)
        save(args.output/'result.json',result)
        started_at_ms=time.time()*1000
        try:
            snapshot=call('upper_start_test',{'source':source,'dryRun':False})
            identity=snapshot['id']
        except Exception:
            # A timed-out control request is never retried. Identify only our newly started test.
            current=call('upper_get_status')['test']
            if current.get('name')=='F450 联合测试 · 起飞5m / 悬停30s / 降落' and current.get('startedAtUnixMs',0)>=started_at_ms-500:
                identity=current.get('id')
            raise
        deadline=time.monotonic()+300
        while time.monotonic()<deadline:
            state=call('upper_get_status');current=state['test']
            if current.get('id')!=identity:raise RuntimeError('test identity changed')
            scene=scene_of(state)
            if not scene or scene.get('scene_epoch')!=ground.get('scene_epoch'):raise RuntimeError('model instance changed or disappeared')
            observations.append({**scene,'time':number(current['elapsed'])})
            save(args.output/'live.json',{'test':current,'connection':state['connection'],'scene':scene})
            connection=state['connection']
            if current['status'] in TERMINAL:finished=True;break
            if not connection.get('fresh') or not state.get('localSimulation',{}).get('ready'):raise RuntimeError('live simulation or flight-controller connection became stale')
            if number(scene.get('age_ms',math.inf))>1000:raise RuntimeError('ground-truth telemetry became stale')
            if max(abs(number(scene['roll_deg'])),abs(number(scene['pitch_deg'])))>30 or number(scene['altitude_m'])-number(ground['altitude_m'])>12:
                raise RuntimeError('attitude/altitude abort boundary exceeded; requesting shared-engine landing')
            print(f"{current['status']}  t={current['elapsed']:.1f}s  altitude={scene['altitude_m']-ground['altitude_m']:.2f}m",flush=True)
            time.sleep(.5)
        if not finished:raise RuntimeError('joint test timeout')
        report=call('upper_get_report',{'offset':0,'limit':1000});total=report['traceTotal'];trace=report['trace']
        for offset in range(1000,total,1000):
            page=call('upper_get_report',{'offset':offset,'limit':1000})
            if page['result']['id']!=identity or page['traceTotal']!=total:raise RuntimeError('report changed during pagination')
            trace.extend(page['trace'])
        report['trace']=trace
        if report['result']['id']!=identity:raise RuntimeError('report identity mismatch')
        save(args.output/'report.json',report);save(args.output/'scene-samples.json',observations)
        acceptance=evaluate(report,observations,ground);result.update(status='passed' if acceptance['passed'] else 'failed',acceptance=acceptance)
        if call('upper_get_status')['connection'].get('armed') is not False:result.update(status='failed',error='final live disarming is unconfirmed')
        return 0 if result['status']=='passed' else 1
    except Blocked as error:
        result.update(status='blocked',error=str(error));return 2
    except (Exception,KeyboardInterrupt) as error:
        result.update(status='failed',error=str(error) or 'interrupted');return 1
    finally:
        if identity and not finished and not stop_requested:
            stop_requested=True
            try:
                current=call('upper_get_status')['test']
                if current.get('id')==identity and current.get('status') not in TERMINAL:
                    result['stopResult']=call('upper_stop_test',{'id':identity})
            except Exception as error:result['stopError']=str(error)
        if ground:save(args.output/'scene-samples.json',observations)
        save(args.output/'result.json',result)
        print(json.dumps({'status':result['status'],'error':result.get('error'),'output':str(args.output)},ensure_ascii=False),flush=True)

if __name__=='__main__':sys.exit(main())
