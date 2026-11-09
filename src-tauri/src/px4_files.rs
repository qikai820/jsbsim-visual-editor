use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};
const MAX_LOG: u64 = 512 * 1024 * 1024;
const MAX_METADATA: usize = 16 * 1024 * 1024;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UlogSummary {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub duration: Option<f64>,
    pub version: u8,
    pub topics: Vec<Topic>,
    pub parameters: BTreeMap<String, serde_json::Value>,
    pub info: BTreeMap<String, String>,
    pub dropout_count: u64,
    pub dropout_ms: u64,
    pub truncated: bool,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub name: String,
    pub multi_id: u8,
    pub samples: u64,
    pub frequency: Option<f64>,
}

fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    b.get(at..at + 8)
        .map(|s| u64::from_le_bytes(s.try_into().unwrap()))
}
fn value(b: &[u8], key: &str) -> serde_json::Value {
    let kind = key.split_whitespace().next().unwrap_or("");
    match kind {
        "int32_t" if b.len() >= 4 => {
            serde_json::json!(i32::from_le_bytes(b[..4].try_into().unwrap()))
        }
        "float" if b.len() >= 4 => {
            serde_json::json!(f32::from_le_bytes(b[..4].try_into().unwrap()))
        }
        "uint32_t" if b.len() >= 4 => {
            serde_json::json!(u32::from_le_bytes(b[..4].try_into().unwrap()))
        }
        _ => serde_json::json!(String::from_utf8_lossy(b).trim_end_matches('\0')),
    }
}

pub fn inspect(path: &Path) -> Result<UlogSummary, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if !(16..=MAX_LOG).contains(&size) {
        return Err("ULog 文件大小须在 16 B～512 MiB 之间".into());
    }
    let mut header = [0u8; 16];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header[..7] != b"ULog\x01\x12\x35" || header[7] != 1 {
        return Err("无效或不支持的 ULog 文件头（当前支持版本 1）".into());
    }
    let mut summary = UlogSummary {
        path: path.to_string_lossy().into(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        size,
        version: header[7],
        ..Default::default()
    };
    let mut formats = BTreeMap::<String, bool>::new();
    let mut topics = BTreeMap::<u16, (Topic, bool, Option<u64>, Option<u64>)>::new();
    let mut position = 16;
    let mut start: Option<u64> = None;
    let mut end: Option<u64> = None;
    while position < size {
        if size - position < 3 {
            summary.truncated = true;
            break;
        }
        let mut h = [0u8; 3];
        file.read_exact(&mut h).map_err(|e| e.to_string())?;
        let len = u16::from_le_bytes([h[0], h[1]]) as usize;
        if position + 3 + len as u64 > size {
            summary.truncated = true;
            break;
        }
        let mut b = vec![0; len];
        file.read_exact(&mut b).map_err(|e| e.to_string())?;
        position += 3 + len as u64;
        match h[2] {
            b'F' => {
                let text = String::from_utf8_lossy(&b);
                if let Some((name, fields)) = text.split_once(':') {
                    formats.insert(
                        name.to_string(),
                        fields.trim_start().starts_with("uint64_t timestamp;"),
                    );
                }
            }
            b'A' if b.len() >= 3 => {
                let id = u16::from_le_bytes([b[1], b[2]]);
                let name = String::from_utf8_lossy(&b[3..]).to_string();
                // IDs can be reused after removal: retain the earlier topic separately.
                if let Some((topic, _, _, _)) = topics.remove(&id) {
                    summary.topics.push(topic);
                }
                let timed = *formats.get(&name).unwrap_or(&false);
                topics.insert(
                    id,
                    (
                        Topic {
                            name,
                            multi_id: b[0],
                            ..Default::default()
                        },
                        timed,
                        None,
                        None,
                    ),
                );
            }
            b'R' if b.len() >= 2 => {
                if let Some((topic, _, _, _)) = topics.remove(&u16::from_le_bytes([b[0], b[1]])) {
                    summary.topics.push(topic);
                }
            }
            b'D' if b.len() >= 2 => {
                if let Some((topic, timed, first, last)) =
                    topics.get_mut(&u16::from_le_bytes([b[0], b[1]]))
                {
                    topic.samples += 1;
                    if let Some(time) = timed.then(|| u64_at(&b, 2)).flatten().filter(|t| *t > 0) {
                        *first = Some(first.map_or(time, |a| a.min(time)));
                        *last = Some(last.map_or(time, |a| a.max(time)));
                        start = Some(start.map_or(time, |a| a.min(time)));
                        end = Some(end.map_or(time, |a| a.max(time)));
                        if let (Some(a), Some(z)) = (*first, *last) {
                            if z > a && topic.samples > 1 {
                                topic.frequency =
                                    Some((topic.samples - 1) as f64 * 1e6 / (z - a) as f64);
                            }
                        }
                    }
                }
            }
            b'P' | b'I' if !b.is_empty() => {
                let n = b[0] as usize;
                if b.len() > n {
                    let key = String::from_utf8_lossy(&b[1..1 + n]);
                    let name = key.split_whitespace().last().unwrap_or("").to_string();
                    let val = value(&b[1 + n..], &key);
                    if h[2] == b'P' {
                        summary.parameters.insert(name, val);
                    } else {
                        summary.info.insert(
                            name,
                            val.as_str()
                                .map(str::to_string)
                                .unwrap_or_else(|| val.to_string()),
                        );
                    }
                }
            }
            b'O' if b.len() >= 2 => {
                summary.dropout_count += 1;
                summary.dropout_ms += u16::from_le_bytes([b[0], b[1]]) as u64;
            }
            _ => {}
        }
    }
    summary
        .topics
        .extend(topics.into_values().map(|(t, _, _, _)| t));
    summary
        .topics
        .sort_by(|a, b| a.name.cmp(&b.name).then(a.multi_id.cmp(&b.multi_id)));
    summary.duration = start.zip(end).map(|(a, z)| (z - a) as f64 / 1e6);
    Ok(summary)
}

struct Download {
    file: File,
    part: PathBuf,
    destination: PathBuf,
    expected: u64,
    ranges: Vec<(u64, u64)>,
}
impl Drop for Download {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.part);
    }
}
fn downloads() -> &'static Mutex<BTreeMap<u64, Download>> {
    static JOBS: OnceLock<Mutex<BTreeMap<u64, Download>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(BTreeMap::new()))
}
fn begin(destination: PathBuf, size: u64) -> Result<u64, String> {
    static ID: AtomicU64 = AtomicU64::new(1);
    if !(16..=MAX_LOG).contains(&size) {
        return Err("日志大小须在 16 B～512 MiB 之间".into());
    }
    let mut jobs = downloads().lock().map_err(|e| e.to_string())?;
    if jobs.len() >= 4 {
        return Err("已有下载正在进行".into());
    }
    let id = ID.fetch_add(1, Ordering::Relaxed);
    let part = destination.with_file_name(format!(".px4-log-{}-{id}.part", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(&part)
        .map_err(|e| e.to_string())?;
    jobs.insert(
        id,
        Download {
            file,
            part,
            destination,
            expected: size,
            ranges: Vec::new(),
        },
    );
    Ok(id)
}
fn write_chunk(id: u64, offset: u64, bytes: &[u8]) -> Result<(), String> {
    let mut jobs = downloads().lock().map_err(|e| e.to_string())?;
    let job = jobs.get_mut(&id).ok_or("下载任务已结束")?;
    if bytes.is_empty()
        || bytes.len() > 65536
        || offset
            .checked_add(bytes.len() as u64)
            .is_none_or(|end| end > job.expected)
    {
        return Err("日志分块范围无效".into());
    }
    job.file
        .seek(SeekFrom::Start(offset))
        .and_then(|_| job.file.write_all(bytes))
        .map_err(|e| e.to_string())?;
    job.ranges.push((offset, offset + bytes.len() as u64));
    job.ranges.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::new();
    for &(a, z) in &job.ranges {
        if let Some(last) = merged.last_mut().filter(|last| a <= last.1) {
            last.1 = last.1.max(z);
        } else {
            merged.push((a, z));
        }
    }
    job.ranges = merged;
    Ok(())
}
fn finish(id: u64) -> Result<UlogSummary, String> {
    let job = downloads()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
        .ok_or("下载任务已结束")?;
    if job.ranges != vec![(0, job.expected)] {
        return Err("日志尚有缺块，未保存为完整文件".into());
    }
    job.file.sync_all().map_err(|e| e.to_string())?;
    let mut summary = inspect(&job.part)?;
    if summary.truncated {
        return Err("ULog 尾部不完整，未替换目标文件".into());
    }
    std::fs::rename(&job.part, &job.destination).map_err(|e| e.to_string())?;
    summary.path = job.destination.to_string_lossy().into();
    summary.name = job
        .destination
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into();
    Ok(summary)
}

#[cfg(target_os = "linux")]
async fn choose(
    window: tauri::WebviewWindow,
    save: bool,
    title: &str,
    name: &str,
    patterns: &[&str],
) -> Result<Option<PathBuf>, String> {
    use gtk::prelude::*;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let parent = window.clone();
    let title = title.to_string();
    let name = name.to_string();
    let patterns: Vec<String> = patterns.iter().map(|p| p.to_string()).collect();
    window
        .run_on_main_thread(move || {
            gtk::glib::MainContext::default().spawn_local(async move {
                let result = async {
                    let parent = parent.gtk_window().map_err(|e| e.to_string())?;
                    let dialog = gtk::FileChooserNative::new(
                        Some(&title),
                        Some(&parent),
                        if save {
                            gtk::FileChooserAction::Save
                        } else {
                            gtk::FileChooserAction::Open
                        },
                        Some(if save { "保存" } else { "打开" }),
                        Some("取消"),
                    );
                    dialog.set_modal(true);
                    dialog.set_do_overwrite_confirmation(true);
                    if save {
                        dialog.set_current_name(&name);
                    }
                    let filter = gtk::FileFilter::new();
                    for pattern in patterns {
                        filter.add_pattern(&pattern);
                    }
                    dialog.add_filter(filter);
                    let selected = if dialog.run_future().await == gtk::ResponseType::Accept {
                        dialog.filename()
                    } else {
                        None
                    };
                    dialog.destroy();
                    Ok::<_, String>(selected)
                }
                .await;
                let _ = tx.send(result);
            });
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}
#[cfg(not(target_os = "linux"))]
async fn choose(
    _: tauri::WebviewWindow,
    _: bool,
    _: &str,
    _: &str,
    _: &[&str],
) -> Result<Option<PathBuf>, String> {
    Err("此平台暂不支持原生文件选择器".into())
}

#[tauri::command]
pub async fn px4_log_begin(
    window: tauri::WebviewWindow,
    name: String,
    size: u64,
) -> Result<Option<u64>, String> {
    let safe = Path::new(&name)
        .file_name()
        .ok_or("文件名无效")?
        .to_string_lossy()
        .into_owned();
    let Some(mut path) = choose(window, true, "保存 PX4 日志", &safe, &["*.ulg"]).await? else {
        return Ok(None);
    };
    path.set_extension("ulg");
    crate::run_blocking(move || begin(path, size).map(Some)).await
}
#[tauri::command]
pub async fn px4_log_write(id: u64, offset: u64, bytes: Vec<u8>) -> Result<(), String> {
    crate::run_blocking(move || write_chunk(id, offset, &bytes)).await
}
#[tauri::command]
pub async fn px4_log_finish(id: u64) -> Result<UlogSummary, String> {
    crate::run_blocking(move || finish(id)).await
}
#[tauri::command]
pub async fn px4_log_cancel(id: u64) -> Result<(), String> {
    crate::run_blocking(move || {
        downloads().lock().map_err(|e| e.to_string())?.remove(&id);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn px4_log_pick(window: tauri::WebviewWindow) -> Result<Option<UlogSummary>, String> {
    let Some(path) = choose(window, false, "打开 PX4 ULog", "", &["*.ulg", "*.ULG"]).await?
    else {
        return Ok(None);
    };
    crate::run_blocking(move || inspect(&path).map(Some)).await
}
#[tauri::command]
pub async fn px4_parameters_save(
    window: tauri::WebviewWindow,
    text: String,
) -> Result<Option<String>, String> {
    if text.len() > MAX_METADATA {
        return Err("参数文件过大".into());
    }
    let Some(mut path) = choose(window, true, "导出 PX4 参数", "px4.params", &["*.params"]).await?
    else {
        return Ok(None);
    };
    path.set_extension("params");
    crate::run_blocking(move || {
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().into()))
    })
    .await
}

fn bounded_output(mut child: std::process::Child) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let result = child
        .stdout
        .take()
        .ok_or("未打开标准输出")?
        .take((MAX_METADATA + 1) as u64)
        .read_to_end(&mut bytes);
    if result.is_err() || bytes.len() > MAX_METADATA {
        let _ = child.kill();
        let _ = child.wait();
        return Err("元数据解压或读取失败，或超过 16 MiB".into());
    }
    if !child.wait().map_err(|e| e.to_string())?.success() {
        return Err("元数据下载或解压失败".into());
    }
    Ok(bytes)
}
fn decode(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > MAX_METADATA {
        return Err("元数据超过 16 MiB".into());
    }
    let data = if bytes.starts_with(b"\xfd7zXZ\0") {
        let mut child = Command::new("xz")
            .args(["--decompress", "--stdout", "--memlimit-decompress=64MiB"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("需要 xz 解压元数据：{e}"))?;
        let mut input = child.stdin.take().ok_or("未打开标准输入")?;
        let writer = std::thread::spawn(move || input.write_all(&bytes));
        let output = bounded_output(child);
        let _ = writer.join();
        output?
    } else {
        bytes
    };
    String::from_utf8(data).map_err(|_| "元数据不是有效 UTF-8".into())
}
#[tauri::command]
pub async fn px4_metadata_decode(bytes: Vec<u8>) -> Result<String, String> {
    crate::run_blocking(move || decode(bytes)).await
}
#[tauri::command]
pub async fn px4_metadata_fetch(uri: String) -> Result<Vec<u8>, String> {
    if !(uri.starts_with("https://") || uri.starts_with("http://")) || uri.len() > 2048 {
        return Err("元数据地址须为 HTTP(S)".into());
    }
    crate::run_blocking(move || {
        let child = Command::new("curl")
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--proto",
                "=http,https",
                "--proto-redir",
                "=http,https",
                "--max-time",
                "20",
                "--max-filesize",
                "16777216",
                "--",
                &uri,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("无法下载元数据，需要 curl：{e}"))?;
        bounded_output(child)
    })
    .await
}
#[derive(Serialize)]
pub struct ImportedMetadata {
    pub name: String,
    pub text: String,
}
#[tauri::command]
pub async fn px4_metadata_pick(
    window: tauri::WebviewWindow,
) -> Result<Option<ImportedMetadata>, String> {
    let Some(path) = choose(
        window,
        false,
        "导入 PX4 参数元数据",
        "",
        &["*.json", "*.json.xz", "*.xml"],
    )
    .await?
    else {
        return Ok(None);
    };
    crate::run_blocking(move || {
        let mut bytes = Vec::new();
        File::open(&path)
            .map_err(|e| e.to_string())?
            .take((MAX_METADATA + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        Ok(Some(ImportedMetadata {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            text: decode(bytes)?,
        }))
    })
    .await
}

#[tauri::command]
pub async fn px4_log_inspect(path: String) -> Result<UlogSummary, String> {
    crate::run_blocking(move || {
        let path = PathBuf::from(path);
        if !path
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("ulg"))
        {
            return Err("请选择 .ulg 文件".into());
        }
        inspect(&path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_ID: AtomicU64 = AtomicU64::new(1);
    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "px4-ulog-test-{}-{}",
            std::process::id(),
            TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
    fn record(output: &mut Vec<u8>, kind: u8, body: &[u8]) {
        output.extend((body.len() as u16).to_le_bytes());
        output.push(kind);
        output.extend(body);
    }
    fn fixture() -> Vec<u8> {
        let mut data = b"ULog\x01\x12\x35\x01".to_vec();
        data.extend(1000u64.to_le_bytes());
        record(
            &mut data,
            b'F',
            b"vehicle_status:uint64_t timestamp;uint8_t nav_state;",
        );
        let mut key = vec![17];
        key.extend(b"int32_t TEST_MODE");
        key.extend((-12345i32).to_le_bytes());
        record(&mut data, b'P', &key);
        let mut add = vec![0, 9, 0];
        add.extend(b"vehicle_status");
        record(&mut data, b'A', &add);
        for t in [1_000_000u64, 1_500_000, 2_000_000] {
            let mut body = vec![9, 0];
            body.extend(t.to_le_bytes());
            body.push(0);
            record(&mut data, b'D', &body);
        }
        record(&mut data, b'O', &25u16.to_le_bytes());
        data
    }
    #[test]
    fn reads_timestamps_topics_parameters_and_dropouts() {
        let dir = directory();
        let path = dir.join("flight.ulg");
        std::fs::write(&path, fixture()).unwrap();
        let s = inspect(&path).unwrap();
        assert_eq!(s.duration, Some(1.));
        assert_eq!(s.topics[0].name, "vehicle_status");
        assert_eq!(s.topics[0].samples, 3);
        assert_eq!(s.topics[0].frequency, Some(2.));
        assert_eq!(s.parameters["TEST_MODE"], -12345);
        assert_eq!(s.dropout_ms, 25);
        assert!(!s.truncated);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn incomplete_download_never_replaces_existing_file() {
        let dir = directory();
        let path = dir.join("flight.ulg");
        std::fs::write(&path, b"keep old file").unwrap();
        let data = fixture();
        let id = begin(path.clone(), data.len() as u64).unwrap();
        write_chunk(id, 0, &data[..16]).unwrap();
        write_chunk(id, 20, &data[20..]).unwrap();
        assert!(finish(id).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"keep old file");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let id = begin(path.clone(), data.len() as u64).unwrap();
        write_chunk(id, 16, &data[16..]).unwrap();
        write_chunk(id, 0, &data[..20]).unwrap();
        assert!(finish(id).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), data);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn invalid_and_truncated_logs_are_distinguished() {
        let dir = directory();
        let path = dir.join("flight.ulg");
        std::fs::write(&path, b"not a valid ULog file").unwrap();
        assert!(inspect(&path).is_err());
        let mut data = fixture();
        data.pop();
        std::fs::write(&path, data).unwrap();
        assert!(inspect(&path).unwrap().truncated);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn metadata_xz_roundtrip_and_invalid_stream() {
        let mut child = Command::new("xz")
            .args(["--compress", "--stdout"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"{\"parameters\":[]}")
            .unwrap();
        let compressed = child.wait_with_output().unwrap().stdout;
        assert_eq!(decode(compressed).unwrap(), "{\"parameters\":[]}");
        assert!(decode(b"\xfd7zXZ\0broken".to_vec()).is_err());
    }
}
