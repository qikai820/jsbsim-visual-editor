#!/usr/bin/env python3
"""Compile the actual PX4 vector input policy header; no device communication."""
from pathlib import Path
import subprocess
import tempfile

px4=Path(__file__).resolve().parents[2]/'PX4-Autopilot'
source=r'''
#include "VectorAttitudeSwitches.hpp"
#include <cassert>
using namespace vector_control;
int main(){
  for(int source=0;source<12;++source){
    assert(independentInput(true,source,false)==(source==1));
    assert(independentInput(true,source,true)==(source>=1&&source<=7));
    assert(!independentInput(false,source,true));
  }
  AttitudeSwitches physical{true,true,true};
  for(int source=2;source<=7;++source){
    auto normal=selectedSwitches(physical,true,true,source,0);
    assert(normal.valid&&!normal.enabled&&!normal.level);
    auto vector=selectedSwitches(physical,true,true,source,1);
    assert(vector.valid&&vector.enabled&&!vector.level);
    auto level=selectedSwitches(physical,true,true,source,3);
    assert(level.valid&&level.enabled&&level.level);
    auto stale=selectedSwitches(physical,true,false,source,1);
    assert(!stale.valid&&!stale.enabled&&!stale.level);
    assert(voliroIndependentPitchTarget(true,normal,1,.5f,2.f)==0.f);
    assert(voliroIndependentPitchTarget(true,vector,1,.5f,2.f)==1.f);
  }
  auto rc=selectedSwitches(physical,true,true,1,0);
  assert(rc.valid&&rc.enabled&&rc.level);
  auto nonhil=selectedSwitches(physical,false,true,2,0);
  assert(nonhil.valid&&nonhil.enabled&&nonhil.level);
}
'''
with tempfile.TemporaryDirectory(prefix='vector-manual-') as directory:
    directory=Path(directory);(directory/'test.cpp').write_text(source)
    subprocess.run(['g++','-std=c++14','-Wall','-Wextra','-Werror','-I'+str(px4/'src/modules/vector_pos_control'),str(directory/'test.cpp'),'-o',str(directory/'test')],check=True)
    subprocess.run([str(directory/'test')],check=True)
print('PASS vector input: selected HIL MAVLink sources, freshness, logical vector/level switches, physical-switch isolation and unchanged non-HIL behavior')
