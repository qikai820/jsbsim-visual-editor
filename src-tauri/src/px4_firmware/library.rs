//! Content-addressed original .px4 packages and a durable record for every use.
use super::{
    library_store::FtpStore,
    protocol::{Firmware, ImageInfo, MAX_PACKAGE},
    UsbTarget,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    net::Ipv4Addr,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
static LOCK: Mutex<()> = Mutex::new(());
pub(super) trait Store {
    fn list(&mut self, path: &str) -> Result<Vec<String>, String>;
    fn get(&mut self, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String>;
    fn mkdir(&mut self, path: &str) -> Result<(), String>;
    fn put(&mut self, path: &str, bytes: &[u8]) -> Result<(), String>;
    fn rename(&mut self, from: &str, to: &str) -> Result<(), String>;
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    #[serde(flatten)]
    pub info: ImageInfo,
    pub package_size: usize,
    pub saved_at: u64,
    pub last_used_at: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub simulator: String,
    pub root: String,
    pub entries: Vec<Entry>,
    pub warnings: Vec<String>,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn nonce() -> Result<String, String> {
    let mut b = [0; 8];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
fn commit(store: &mut impl Store, path: &str, bytes: &[u8]) -> Result<(), String> {
    let parent = path.rsplit_once('/').ok_or("固件库目标路径无效")?.0;
    let temp = format!("{parent}/part-{}", nonce()?);
    store.put(&temp, bytes)?;
    if store.get(&temp, bytes.len())?.as_deref() != Some(bytes) {
        return Err("固件库临时文件回读不一致；未开始刷写".into());
    }
    store.rename(&temp, path)?;
    if store.get(path, bytes.len())?.as_deref() != Some(bytes) {
        return Err("固件库最终文件回读不一致；未开始刷写".into());
    }
    Ok(())
}
fn entry(store: &mut impl Store, id: &str) -> Result<Entry, String> {
    if !valid_id(id) {
        return Err("无效固件库 ID".into());
    }
    let bytes = store
        .get(&format!("{id}/info.json"), 64 * 1024)?
        .ok_or("固件库条目不存在或保存未完成")?;
    let mut e: Entry = serde_json::from_slice(&bytes).map_err(|_| "固件库条目信息损坏")?;
    if e.id != id || e.package_size > MAX_PACKAGE || e.package_size == 0 {
        return Err("固件库条目身份或大小无效".into());
    }
    e.last_used_at = store
        .list(id)?
        .iter()
        .filter_map(|s| {
            let tail = s.strip_prefix("use-")?.strip_suffix(".json")?;
            let (time, nonce) = tail.split_once('-')?;
            if time.len() > 16 || nonce.len() != 16 || !nonce.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return None;
            }
            time.parse::<u64>().ok()
        })
        .max();
    Ok(e)
}
struct Receipt {
    entry: Entry,
    record_name: String,
    record: Vec<u8>,
}
fn archive_in(
    store: &mut impl Store,
    firmware: &Firmware,
    target: &UsbTarget,
    job_id: u64,
) -> Result<Receipt, String> {
    let id = hash(&firmware.package);
    store.mkdir(&id)?;
    let path = format!("{id}/firmware.px4");
    if let Some(bytes) = store.get(&path, MAX_PACKAGE)? {
        if hash(&bytes) != id {
            return Err("固件库中已有文件校验失败，未开始刷写".into());
        }
    } else {
        commit(store, &path, &firmware.package)?;
    }
    let mut result = match store.get(&format!("{id}/info.json"), 64 * 1024)? {
        Some(_) => entry(store, &id)?,
        None => {
            let e = Entry {
                id: id.clone(),
                info: firmware.info.clone(),
                package_size: firmware.package.len(),
                saved_at: now(),
                last_used_at: None,
            };
            let bytes = serde_json::to_vec(&e).map_err(|e| e.to_string())?;
            if bytes.len() > 64 * 1024 {
                return Err("固件元数据过长，未开始刷写".into());
            }
            commit(store, &format!("{id}/info.json"), &bytes)?;
            e
        }
    };
    if result.info.board_id != firmware.info.board_id
        || result.info.image_size != firmware.info.image_size
        || result.package_size != firmware.package.len()
    {
        return Err("固件库元数据与实际固件不一致，未开始刷写".into());
    }
    // A new immutable record is saved for every attempt, including reuse of
    // the exact same .px4. Never overwrite a previous package or use record.
    let used = now();
    let record=serde_json::to_vec(&serde_json::json!({"at":used,"jobId":job_id,"target":{"simulator":target.simulator,"path":target.path,"vid":target.vid,"pid":target.pid},"sourceSha256":hash(firmware.info.source.as_bytes()),"packageSha256":id,"state":"archived-before-flash"})).map_err(|e|e.to_string())?;
    let record_name = format!("use-{used}-{}.json", nonce()?);
    commit(store, &format!("{id}/{record_name}"), &record)?;
    result.last_used_at = Some(used);
    Ok(Receipt {
        entry: result,
        record_name,
        record,
    })
}
fn load_in(store: &mut impl Store, id: &str) -> Result<Firmware, String> {
    let e = entry(store, id)?;
    let bytes = store
        .get(&format!("{id}/firmware.px4"), MAX_PACKAGE)?
        .ok_or("固件库文件丢失")?;
    if bytes.len() != e.package_size || hash(&bytes) != id {
        return Err("固件库文件校验失败，不能选择升级".into());
    }
    // Re-parse the actual package: never trust cached metadata for board ID.
    Firmware::parse(e.info.name, e.info.source, &bytes)
}
pub fn list() -> Result<Listing, String> {
    let host = crate::transport::network_host().ok_or("未连接仿真机")?;
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let mut store = FtpStore::open(host)?;
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let ids = store
        .list("")?
        .into_iter()
        .filter(|id| valid_id(id))
        .collect::<Vec<_>>();
    if ids.len() > 500 {
        return Err("固件库超过 500 份，请先整理仿真机上的历史固件".into());
    }
    for id in ids {
        match entry(&mut store, &id) {
            Ok(e) => entries.push(e),
            Err(e) => warnings.push(format!("{}…：{e}", &id[..12])),
        }
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.last_used_at.unwrap_or(e.saved_at)));
    Ok(Listing {
        simulator: host.to_string(),
        root: store.root.clone(),
        entries,
        warnings,
    })
}
pub fn load(simulator: &str, id: &str) -> Result<Firmware, String> {
    if !valid_id(id) {
        return Err("无效固件库 ID".into());
    }
    let host: Ipv4Addr = simulator.parse().map_err(|_| "无效仿真机地址")?;
    if crate::transport::network_host() != Some(host) {
        return Err("固件库所属仿真机已变化，请刷新列表".into());
    }
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let firmware = load_in(&mut FtpStore::open(host)?, id)?;
    if crate::transport::network_host() != Some(host) {
        return Err("读取期间仿真机已变化，请重新选择".into());
    }
    Ok(firmware)
}
pub fn archive(firmware: &Firmware, target: &UsbTarget, job_id: u64) -> Result<Entry, String> {
    let host: Ipv4Addr = target.simulator.parse().map_err(|_| "无效仿真机地址")?;
    if crate::transport::network_host() != Some(host) {
        return Err("目标仿真机已变化；未开始刷写".into());
    }
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let mut store = FtpStore::open(host)?;
    let root = store.root.clone();
    let receipt = archive_in(&mut store, firmware, target, job_id)?;
    drop(store);
    crate::romfs_network::with_host_session(host, |s| {
        for command in [format!("cd {root}"), format!("cd {}", receipt.entry.id)] {
            let output = s.command(&command)?;
            if output.contains("nsh:") {
                return Err("固件库不在已挂载的持久存储中，未开始刷写".into());
            }
        }
        let output = s.command(&format!("cat {}", receipt.record_name))?;
        let actual: serde_json::Value = serde_json::from_str(output.trim())
            .map_err(|_| "固件库持久存储记录无法回读，未开始刷写")?;
        let expected: serde_json::Value =
            serde_json::from_slice(&receipt.record).map_err(|e| e.to_string())?;
        if actual != expected {
            return Err("固件库持久存储记录不一致，未开始刷写".into());
        }
        let output = s.command("jsbsim firmware sync")?;
        if !output
            .lines()
            .any(|line| line.trim() == "PX4_FIRMWARE_SYNCED")
        {
            return Err(
                "仿真机未确认固件库持久化，请更新支持固件库的仿真机固件；未开始刷写".into(),
            );
        }
        Ok(())
    })?;
    if crate::transport::network_host() != Some(host) {
        return Err("归档期间仿真机已变化；未开始刷写".into());
    }
    Ok(receipt.entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[derive(Default)]
    struct Memory {
        files: BTreeMap<String, Vec<u8>>,
        corrupt: bool,
        fail_rename: bool,
    }
    impl Store for Memory {
        fn list(&mut self, path: &str) -> Result<Vec<String>, String> {
            Ok(self
                .files
                .keys()
                .filter_map(|k| k.strip_prefix(&format!("{path}/")))
                .map(str::to_string)
                .collect())
        }
        fn get(&mut self, p: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
            let b = self.files.get(p).cloned();
            if b.as_ref().is_some_and(|b| b.len() > limit) {
                return Err("limit".into());
            }
            Ok(b)
        }
        fn mkdir(&mut self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn put(&mut self, p: &str, b: &[u8]) -> Result<(), String> {
            let mut b = b.to_vec();
            if self.corrupt && !b.is_empty() {
                b[0] ^= 1;
            }
            self.files.insert(p.into(), b);
            Ok(())
        }
        fn rename(&mut self, f: &str, t: &str) -> Result<(), String> {
            if self.fail_rename {
                return Err("rename failed".into());
            }
            let b = self.files.remove(f).unwrap();
            self.files.insert(t.into(), b);
            Ok(())
        }
    }
    fn firmware() -> Firmware {
        Firmware::parse(
            "sample.px4".into(),
            "local".into(),
            include_bytes!(
                "../../../firmware/px4-vector-hil/cuav_7-nano_morphquad_vector_hil_20261117.px4"
            ),
        )
        .unwrap()
    }
    fn target() -> UsbTarget {
        UsbTarget {
            simulator: "192.0.2.1".into(),
            path: "/dev/ttyACM0".into(),
            vid: 1,
            pid: 2,
            serial_number: None,
            label: "test".into(),
        }
    }
    #[test]
    fn original_package_persists_and_each_reuse_has_a_record() {
        let f = firmware();
        let mut s = Memory::default();
        let a = archive_in(&mut s, &f, &target(), 1).unwrap().entry;
        let b = archive_in(&mut s, &f, &target(), 2).unwrap().entry;
        assert_eq!(a.id, b.id);
        assert_eq!(a.saved_at, b.saved_at);
        assert_eq!(
            s.files
                .keys()
                .filter(|p| p.ends_with("firmware.px4"))
                .count(),
            1
        );
        assert_eq!(s.files.keys().filter(|p| p.contains("/use-")).count(), 2);
        let restored = load_in(&mut s, &a.id).unwrap();
        assert_eq!(restored.package, f.package);
        assert_eq!(restored.image, f.image);
        s.files.get_mut(&format!("{}/firmware.px4", a.id)).unwrap()[0] ^= 1;
        assert!(load_in(&mut s, &a.id).is_err());
        assert!(archive_in(&mut s, &f, &target(), 3).is_err());
    }
    #[test]
    fn failed_staging_never_publishes_a_selectable_package() {
        let f = firmware();
        for (corrupt, fail_rename) in [(true, false), (false, true)] {
            let mut s = Memory {
                corrupt,
                fail_rename,
                ..Memory::default()
            };
            assert!(archive_in(&mut s, &f, &target(), 1).is_err());
            assert!(!s.files.keys().any(|p| p.ends_with("info.json")));
            assert!(load_in(&mut s, &hash(&f.package)).is_err());
        }
        for id in ["../x", "", "A", "data/abc"] {
            assert!(!valid_id(id));
        }
    }
}
