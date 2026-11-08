#!/usr/bin/env python3
"""Compile the production network upgrade flow without a desktop window.
Default: parser tests only. --apply IMAGE explicitly installs on SIM_UDP_HOST.
USB calls are disabled; network NSH and FTP implementations are production code.
"""
from pathlib import Path
import subprocess,tempfile,sys,os
root=Path(__file__).resolve().parents[1];src=root/'src-tauri/src';deps=root/'src-tauri/target/debug/deps'
ftp=(src/'ftp_sync.rs').read_text()
upload=ftp[ftp.index('pub(crate) fn upload_firmware('):]
auth=ftp[ftp.index('fn credentials()'):ftp.index('fn safe_component(')]
# These stubs can never write a USB device; the production network branch is
# selected explicitly and the entire actual firmware_update module is included.
harness='''
extern crate serde_json;
mod transport {
 pub fn network_host()->Option<std::net::Ipv4Addr>{std::env::var("SIM_UDP_HOST").ok()?.parse().ok()}
}
mod usb_file {
 pub fn crc32(b:&[u8])->u32{let mut c=u32::MAX;for x in b{c^=*x as u32;for _ in 0..8{c=(c>>1)^(0xedb88320u32 & 0u32.wrapping_sub(c&1));}}!c}
 pub struct Entry{pub directory:bool,pub size:u64}
 pub enum FirmwareUpdatePhase{Write,Verify}
 pub struct Progress{pub phase:FirmwareUpdatePhase,pub completed:u64,pub total:u64}
 pub fn ping()->Result<String,String>{Err("USB disabled".into())}
 pub fn stat(_p:&str)->Result<Entry,String>{Err("USB disabled".into())}
 pub fn write_all_with_progress(_p:&str,_b:&[u8],_f:impl FnMut(u64,u64))->Result<(),String>{Err("USB disabled".into())}
 pub fn apply_firmware_with_progress(_p:&str,_f:impl FnMut(Progress))->Result<String,String>{Err("USB disabled".into())}
}
mod ftp_sync {
 use std::io::Write;use std::sync::Mutex;use std::time::Duration;
 static FTP_LOCK:Mutex<()>=Mutex::new(());
 pub(crate) fn use_usb()->bool{false}
'''+auth+upload+'\n}\n'+f'#[path="{src}/romfs_network.rs"] mod romfs_network;\n#[path="{src}/firmware_update.rs"] mod firmware_update;\n'+'''
fn main(){
 let p=std::env::args().nth(1).expect("firmware path or --rollback");
 if p=="--rollback" {println!("ROLLBACK {}",firmware_update::rollback().expect("rollback"));return;}
 let report=|stage:&str,done:u64,total:u64|{println!("PROGRESS {stage} {done}/{total}");};
 let info=firmware_update::info().expect("probe");println!("INFO {info}");
 let bytes=std::fs::read(p).unwrap();
 let staged=firmware_update::stage(&report,"nuttx.bin".into(),bytes).expect("stage");println!("STAGED {staged}");
 let result=firmware_update::apply(&report,staged["size"].as_u64().unwrap(),staged["crc32"].as_u64().unwrap() as u32).expect("apply");println!("APPLIED {result}");
}
'''
with tempfile.TemporaryDirectory(prefix='network-fw-check-') as temp:
    p=Path(temp);(p/'main.rs').write_text(harness)
    lib=max(deps.glob('libserde_json-*.rlib'),key=lambda p:p.stat().st_mtime)
    common=['rustc','--edition=2021',str(p/'main.rs'),'-L',f'dependency={deps}','--extern',f'serde_json={lib}']
    subprocess.run(common+['--test','-o',str(p/'tests')],check=True)
    subprocess.run([str(p/'tests')],check=True)
    if (len(sys.argv)==3 and sys.argv[1]=='--apply') or (len(sys.argv)==2 and sys.argv[1]=='--rollback'):
        assert os.environ.get('SIM_UDP_HOST'), 'Set the explicitly authorized target IP'
        subprocess.run(common+['-o',str(p/'apply')],check=True)
        subprocess.run([str(p/'apply'),sys.argv[2] if sys.argv[1]=='--apply' else '--rollback'],check=True)
    else: assert len(sys.argv)==1, 'usage: check_network_firmware.py [--apply IMAGE | --rollback]'
