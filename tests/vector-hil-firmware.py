#!/usr/bin/env python3
"""Compile the prepared controller overlay with the existing CUAV toolchain.
No PX4 source, build directory, device or firmware is modified.
"""
import json
from pathlib import Path
import shlex
import subprocess
import tempfile

root=Path(__file__).resolve().parents[1]
px4=root.parent/'PX4-Autopilot'
overlay=root/'firmware/px4-vector-hil/overlay'
build=px4/'build/cuav_7-nano_volirot'
names={'vector_att_control_main.cpp','VectorPositionControl.cpp'}
with tempfile.TemporaryDirectory(prefix='vector-hil-') as work:
    work=Path(work)
    source=work/'test.cpp'
    source.write_text('''#include <lib/vector_control/VectorHilManual.hpp>
#include <cassert>
#include <cstdio>
#include <initializer_list>
using namespace matrix;
using namespace vector_control;
int main(){
 assert(hilManualInterface(true,true,true,16));
 assert(!hilManualInterface(true,false,true,16));
 assert(!hilManualInterface(false,true,true,16));
 assert(!hilManualInterface(true,true,false,16));
 assert(!hilManualInterface(true,true,true,15));
 for(int source=0;source<10;++source){assert(hilManualSample(true,source,true,true,true)==(source>=2&&source<=7));}
 assert(!hilManualSample(true,2,false,true,true));assert(!hilManualSample(true,2,true,false,true));assert(!hilManualSample(true,2,true,true,false));
 constexpr float r=0.017453292519943295f;
 for(float limit:{45.f,120.f})for(float angle:{-120.f,-90.f,-45.f,0.f,45.f,90.f,120.f}){
   const float a=angle < -limit?-limit:angle>limit?limit:angle;
   const Quatf expected(Eulerf(0.f,a*r,0.7f));const Quatf q=hilManualAttitude(0.f,angle/120.f,0.7f,limit);
   assert(fabsf(q.dot(expected))>0.999999f);
   const Vector3f force=hilManualThrust(q,0.4f);assert(Vector3f(Dcmf(q)*force-Vector3f(0.f,0.f,-0.4f)).norm()<1e-6f);
 }
 puts("PASS: HIL/source/airframe/armed gates, 45/120 degree bounds, quaternion angles and world-vertical manual thrust");
}
''')
    includes=['-I'+str(overlay/'src'),'-I'+str(px4/'src'),'-I'+str(px4/'src/lib'),'-I'+str(px4/'src/lib/matrix'),'-I'+str(px4/'platforms/common/include'),'-I'+str(px4/'platforms/posix/include'),'-I'+str(px4/'build/px4_sitl_default')]
    subprocess.run(['g++','-std=c++17','-D__PX4_POSIX','-D__PX4_LINUX',*includes,str(source),'-o',str(work/'unit')],check=True)
    subprocess.run([str(work/'unit')],check=True)
    count=0
    for entry in json.loads((build/'compile_commands.json').read_text()):
        original=Path(entry['file'])
        if original.name not in names:continue
        args=shlex.split(entry['command'])
        args[1:1]=['-I'+str(overlay/'src'),'-I'+str(original.parent)]
        for index,arg in enumerate(args):
            if arg==str(original):args[index]=str(overlay/original.relative_to(px4))
            if index and args[index-1]=='-o':args[index]=str(work/(original.stem+'.o'))
            if index and args[index-1]=='-MF':args[index]=str(work/(original.stem+'.d'))
        subprocess.run(args,cwd=entry['directory'],check=True)
        print('PASS: CUAV 7 Nano ARM compile:',original.name)
        count+=1
    assert count==2
