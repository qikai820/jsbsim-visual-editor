#!/usr/bin/env python3
"""Prepare a relocatable, offline F450/PX4 payload from existing Linux builds."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import sysconfig
import tempfile

EDITOR = Path(__file__).resolve().parents[1]

def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target, follow_symlinks=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=EDITOR.parent/'jsbsim_realtime')
    parser.add_argument('--px4-build', type=Path, default=EDITOR.parent/'build/px4_sitl_default')
    parser.add_argument('--output', type=Path, default=EDITOR/'src-tauri/resources/builtin-simulation')
    args = parser.parse_args()
    if sys.platform != 'linux' or platform.machine() != 'x86_64':
        parser.error('the built-in simulation payload currently targets x86-64 Linux')
    native = args.project/'build/x86_64/bin/jsbsim_realtime'
    for required in (native, args.px4_build/'bin/px4', args.px4_build/'etc/init.d-posix/rcS'):
        if not required.is_file(): parser.error(f'missing build input: {required}')
    # Keep the staged directory separate until all dependencies have been collected.
    args.output.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='.builtin-simulation-', dir=args.output.parent))
    try:
        copy(native, work/'bin/jsbsim_realtime')
        copy(args.px4_build/'bin/px4', work/'px4/bin/px4')
        copy(args.px4_build/'bin/px4-alias.sh', work/'px4/bin/px4-alias.sh')
        shutil.copytree(args.px4_build/'etc', work/'px4/etc', symlinks=False)
        services = args.project/'boards/pc/x86_64/services'
        shutil.copytree(services, work/'project/boards/pc/x86_64/services', ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
        shutil.copytree(args.project/'data/aviation', work/'project/data/aviation', symlinks=False)
        # Match the F450 body geometry and its motor order; only edit the payload.
        frame = work/'px4/etc/init.d-posix/airframes/3010_jsbsim_quadrotor_x'
        lines = ['#!/bin/sh', '. ${R}etc/init.d/rc.mc_defaults', 'param set CA_AIRFRAME 0', 'param set CA_ROTOR_COUNT 4']
        for index,(x,y,km) in enumerate(((.1651,.1651,.05),(-.1651,-.1651,.05),(.1651,-.1651,-.05),(-.1651,.1651,-.05))):
            for key,value in (('PX',x),('PY',y),('KM',km)):
                lines.append(f'param set CA_ROTOR{index}_{key} {value}')
            lines.append(f'param set PWM_MAIN_FUNC{index+1} {101+index}')
        frame.write_text('\n'.join(lines)+'\n')
        rc = work/'px4/etc/init.d-posix/rcS'
        rc.write_text(rc.read_text()+'\n# Desktop toolbox telemetry and command return path.\nmavlink start -x -u 18573 -o 14553 -t 127.0.0.1 -m onboard -r 1000000\n')
        # No system Python installation or third-party Python packages are needed at runtime.
        pyver = f'python{sys.version_info.major}.{sys.version_info.minor}'
        copy(Path(sys.executable).resolve(), work/'python/bin'/pyver)
        stdlib = Path(sysconfig.get_path('stdlib'))
        ignored = shutil.ignore_patterns('__pycache__','*.pyc','site-packages','dist-packages','test','tests','idlelib','tkinter','ensurepip','_test*','_tkinter*')
        shutil.copytree(stdlib, work/'python/lib'/pyver, ignore=ignored, symlinks=False)
        # A few installations keep extension modules outside the standard library directory.
        dynload = Path(sysconfig.get_config_var('DESTSHARED') or stdlib/'lib-dynload')
        if dynload.is_dir() and not (work/'python/lib'/pyver/'lib-dynload').exists():
            shutil.copytree(dynload, work/'python/lib'/pyver/'lib-dynload', ignore=ignored)
        executables = [work/'bin/jsbsim_realtime', work/'px4/bin/px4', work/'python/bin'/pyver]
        for exe in executables:
            subprocess.run(['strip','--strip-unneeded',str(exe)],check=True)
            exe.chmod(0o755)
        # Copy non-glibc shared dependencies, including liblz4 and Python extension dependencies.
        queue = executables + list((work/'python').rglob('*.so'))
        seen = set()
        while queue:
            path = queue.pop()
            if path in seen: continue
            seen.add(path)
            output = subprocess.run(['ldd',str(path)],capture_output=True,text=True)
            if 'not found' in output.stdout: raise RuntimeError(f'unresolved library for {path}: {output.stdout}')
            for name,raw in re.findall(r'^\s*(\S+) => (/\S+)',output.stdout,re.M):
                if re.fullmatch(r'lib(c|m|dl|pthread|rt|resolv|util)\.so\..*',name): continue
                dest = work/'lib'/name
                if not dest.exists(): copy(Path(raw),dest); queue.append(dest)
        cache = (args.px4_build/'CMakeCache.txt').read_text()
        source_match = re.search(r'^PX4_SOURCE_DIR:[^=]+=(.*)$',cache,re.M)
        px4_source = Path(source_match[1]) if source_match else args.px4_build.parent.parent
        for source,name in ((args.project/'COPYING','JSBSim-COPYING'),
                            (px4_source/'LICENSE','PX4-LICENSE'),
                            (Path('/usr/share/doc/python3.12/copyright'),'Python-copyright'),
                            (Path('/usr/share/doc/libstdc++6/copyright'),'libstdc++-copyright'),
                            (Path('/usr/share/doc/liblz4-1/copyright'),'liblz4-copyright')):
            if source.is_file(): copy(source,work/'licenses'/name)
        commands = sorted(p.name for p in (args.px4_build/'bin').iterdir() if p.name.startswith('px4-') and p.name!='px4-alias.sh')
        digest = hashlib.sha256()
        for file in sorted(p for p in work.rglob('*') if p.is_file()):
            digest.update(file.relative_to(work).as_posix().encode())
            digest.update(file.read_bytes())
        manifest = {'schema':1,'id':digest.hexdigest()[:20],'target':'x86_64-linux','name':'F450 四旋翼仿真',
                    'model':'F450_PX4','script':'F450_PX4_lan.xml','airframe':3010,'python':f'python/bin/{pyver}',
                    'px4Commands':commands,'hilHost':'127.0.0.1','px4HilPort':14561,'modelHilPort':14560}
        (work/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
        # Validate the embedded interpreter before publishing the payload.
        env = dict(os.environ, PYTHONHOME=str(work/'python'), PYTHONNOUSERSITE='1', PYTHONDONTWRITEBYTECODE='1', LD_LIBRARY_PATH=str(work/'lib'))
        env.pop('PYTHONPATH',None)
        subprocess.run([str(work/manifest['python']),'-S','-c','import socket, socketserver, threading, subprocess, json, fcntl, xml.etree.ElementTree; print("Embedded Python OK")'],env=env,check=True)
        copy(EDITOR/'src-tauri/resources/builtin-simulation/README.md',work/'README.md')
        previous = args.output.with_name(args.output.name+'.previous')
        if previous.exists(): shutil.rmtree(previous)
        if args.output.exists(): args.output.rename(previous)
        try: work.rename(args.output)
        except BaseException:
            if previous.exists(): previous.rename(args.output)
            raise
        if previous.exists(): shutil.rmtree(previous)
        size = sum(p.stat().st_size for p in args.output.rglob('*') if p.is_file())
        print(f'Built-in simulation prepared: {args.output} ({size/1048576:.1f} MiB, {manifest["id"]})')
    finally:
        if work.exists(): shutil.rmtree(work)

if __name__ == '__main__': main()
