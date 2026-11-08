//! Shared upgrade flow: existing i.MX93 USB protocol or Orange Pi FTP + NSH.
use std::net::Ipv4Addr;
use std::sync::Mutex;
use std::time::Duration;
use serde_json::{json, Value};
use crate::{usb_file, ftp_sync, romfs_network, transport};

#[derive(Clone, Copy)]
enum Target { Usb, Nvme(Ipv4Addr) }
struct Pending { target: Target, size: u64, crc: u32 }
// Serializes staging/apply and pins the exact target across the two commands.
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
const REMOTE: &str = "fireware/nuttx.bin";

fn target() -> Result<Target, String> {
    if ftp_sync::use_usb() { Ok(Target::Usb) }
    else { Ok(Target::Nvme(transport::network_host().ok_or("未发现网口仿真机")?)) }
}
fn probe(host: Ipv4Addr) -> Result<String, String> {
    let text = romfs_network::with_host_session(host, |s| s.command("update --info"))?;
    if !text.lines().any(|line| line.trim() == "FW_UPDATE target=rk3588-opi5plus protocol=2 OPI5PLUS_FW_V1") {
        return Err("该仿真机尚未安装 RK3588 SSD 升级服务，请先安装支持在线升级的固件".into());
    }
    if text.contains("UPDATE_ERROR") { return Err(text); }
    Ok(text)
}
fn info_for(t: Target) -> Result<Value, String> {
    match t {
        Target::Usb => { usb_file::ping()?; Ok(json!({"target":"imx93", "storage":"eMMC", "source":"usb-bulk", "path":"/data/fireware/nuttx.bin", "boot":"SIM_FW · slot A"})) },
        Target::Nvme(host) => {
            let text = probe(host)?;
            let slots = text.lines().find(|line| line.starts_with("FW_SLOTS ")).ok_or("缺少 A/B 槽位信息")?;
            let active = slots.split_whitespace().find_map(|f| f.strip_prefix("active=")).filter(|s| matches!(*s,"A"|"B")).ok_or("无效活动槽位")?;
            let standby = if active=="A" {"B"} else {"A"};
            Ok(json!({"target":"rk3588", "storage":"SSD", "source":"nuttx-ftp", "path":"/tmp/fireware/nuttx.bin", "boot":format!("SSD · {active} → {standby}"),"activeSlot":active,"standbySlot":standby}))
        },
    }
}
pub fn info() -> Result<Value, String> { info_for(target()?) }
type Reporter<'a> = &'a dyn Fn(&str, u64, u64);
fn emit(report: Reporter<'_>, stage: &str, completed: u64, total: u64) {
    report(stage, completed, total);
}
fn matches_result(text: &str, tag: &str, size: u64, crc: u32) -> bool {
    let expected = format!("{tag} size={size} crc32={crc:08x}");
    !text.contains("UPDATE_ERROR") && text.lines().any(|line| line.trim() == expected)
}

fn nvme_image(bytes: &[u8]) -> bool {
    bytes.len() >= 64 && bytes[16..24].try_into().ok().map(u64::from_le_bytes)==Some(bytes.len() as u64) &&
        bytes.get(0x38..0x3c)==Some(b"ARM\x64") &&
        bytes.windows(b"OPI5PLUS_FW_V1".len()).any(|part|part==b"OPI5PLUS_FW_V1")
}

pub fn stage(report: Reporter<'_>, name: String, bytes: Vec<u8>) -> Result<Value, String> {
    let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
    *pending = None;
    if !name.to_ascii_lowercase().ends_with(".bin") || !(65536..=64*1024*1024).contains(&bytes.len()) {
        return Err("请选择 64 KiB–64 MiB 的 .bin 固件文件".into());
    }
    let t = target()?;
    let info = info_for(t)?;
    let size = bytes.len() as u64;
    let crc = usb_file::crc32(&bytes);
    emit(report, "upload", 0, size);
    match t {
        Target::Usb => {
            if bytes.windows(b"OPI5PLUS_FW_V1".len()).any(|p| p==b"OPI5PLUS_FW_V1") { return Err("RK3588 固件不能写入 i.MX93".into()); }
            usb_file::write_all_with_progress(REMOTE, &bytes, |done,total| emit(report,"upload",done,total))?;
            let remote = usb_file::stat(REMOTE)?;
            if remote.directory || remote.size != size { return Err("上传固件大小不匹配".into()); }
        },
        Target::Nvme(host) => {
            if !nvme_image(&bytes) {
                return Err("请选择支持 SSD 升级的 RK3588 Orange Pi 5 Plus 固件".into());
            }
            ftp_sync::upload_firmware(host, &bytes, |done| emit(report,"upload",done,size))?;
            let text = romfs_network::with_host_session(host, |s|
                s.command(&format!("update --check {size} {crc:08x}")))?;
            if !matches_result(&text,"UPDATE_STAGED",size,crc) { return Err(format!("上传固件校验失败: {text}")); }
        },
    }
    *pending = Some(Pending { target:t, size, crc });
    emit(report,"upload",size,size);
    Ok(json!({"fileName":name,"size":size,"crc32":crc,"staged":true,"path":info["path"],"source":info["source"],"target":info["target"]}))
}

pub fn apply(report: Reporter<'_>, size: u64, crc: u32) -> Result<Value,String> {
    let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
    let p = pending.take().ok_or("请先完整上传固件并校验")?;
    if p.size != size || p.crc != crc { return Err("固件与已校验的上传记录不一致，请重新上传".into()); }
    emit(report,"write",0,size);
    let (verification,source,path) = match p.target {
        Target::Usb => {
            let v = usb_file::apply_firmware_with_progress(REMOTE, |p| emit(report,
                match p.phase { usb_file::FirmwareUpdatePhase::Write => "write", usb_file::FirmwareUpdatePhase::Verify => "verify" },p.completed,p.total))?;
            if v.trim() != format!("size={size} crc32={crc:08x}") { return Err(format!("eMMC 回读校验失败: {v}")); }
            (v,"usb-bulk","/data/fireware/nuttx.bin")
        },
        Target::Nvme(host) => {
            let mut lines = String::new();
            let text = romfs_network::with_host_session(host, |s|
                s.command_progress(&format!("update --apply {size} {crc:08x}"), Duration::from_secs(180), |chunk| {
                    lines.push_str(&String::from_utf8_lossy(chunk));
                    while let Some(end) = lines.find('\n') {
                        let line = lines[..end].trim().to_string(); lines.drain(..=end);
                        let f:Vec<_> = line.split_whitespace().collect();
                        if f.len()==4 && f[0]=="UPDATE_PROGRESS" && matches!(f[1],"write"|"verify") {
                            if let (Ok(done),Ok(total)) = (f[2].parse::<u64>(),f[3].parse::<u64>()) {
                                if total==size && done<=total { emit(report,f[1],done,total); }
                            }
                        }
                    }
                }))?;
            if !matches_result(&text,"UPDATE_SUCCESS",size,crc) { return Err(format!("SSD 安装或回读校验失败: {text}")); }
            (format!("size={size} crc32={crc:08x}"),"nuttx-ftp","/tmp/fireware/nuttx.bin")
        }
    };
    Ok(json!({"installed":true,"verification":verification,"rebootRequired":true,"source":source,"path":path}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_wrong_board_header_and_truncated_image() {
        let mut b=vec![0;65536];
        b[16..24].copy_from_slice(&65536u64.to_le_bytes());
        b[0x38..0x3c].copy_from_slice(b"ARM\x64");
        b[65522..].copy_from_slice(b"OPI5PLUS_FW_V1");
        assert!(nvme_image(&b));
        assert!(!nvme_image(&b[..65535]));
        b[65522]=b'X';assert!(!nvme_image(&b));
        b[65522]=b'O';b[0x38]=0;assert!(!nvme_image(&b));
    }
    #[test]
    fn requires_exact_success_and_rejects_failure_even_after_success() {
        assert!(matches_result("UPDATE_SUCCESS size=123 crc32=1234abcd\n", "UPDATE_SUCCESS", 123, 0x1234abcd));
        for s in ["UPDATE_SUCCESS size=124 crc32=1234abcd", "UPDATE_SUCCESS size=123 crc32=1234abce", "UPDATE_SUCCESS size=123 crc32=1234abcd\nUPDATE_ERROR errno=5", "update: command not found"] {
            assert!(!matches_result(s,"UPDATE_SUCCESS",123,0x1234abcd));
        }
    }
}

/// Select the retained slot for the next boot, preserving the running slot.
pub fn rollback() -> Result<Value,String> {
    let mut pending = PENDING.lock().map_err(|e|e.to_string())?;
    *pending = None;
    let Target::Nvme(host) = target()? else { return Err("当前设备不支持 A/B 回退".into()); };
    probe(host)?;
    let text = romfs_network::with_host_session(host, |s| s.command_progress("update --rollback",Duration::from_secs(180), |_| {}))?;
    if text.contains("UPDATE_ERROR") || !text.lines().any(|l|l.trim()=="UPDATE_ROLLBACK ready; reboot to activate") {
        return Err(format!("回退设置失败: {text}"));
    }
    Ok(json!({"rebootRequired":true,"rollbackReady":true}))
}
