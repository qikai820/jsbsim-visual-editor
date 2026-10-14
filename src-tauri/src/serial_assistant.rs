//! Local computer serial port tool. This module never uses simulator transport.
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPortType, StopBits};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;

const MAX_WRITE: usize = 64 * 1024;
const READ_TIMEOUT: Duration = Duration::from_millis(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    path: String,
    label: String,
}

pub fn list_ports() -> Result<Vec<PortInfo>, String> {
    let mut ports: Vec<_> = serialport::available_ports()
        .map_err(|error| format!("无法枚举本机串口：{error}"))?
        .into_iter()
        .map(|port| {
            let description = match port.port_type {
                SerialPortType::UsbPort(info) => info.product.or(info.manufacturer),
                SerialPortType::BluetoothPort => Some("Bluetooth".into()),
                SerialPortType::PciPort => Some("PCI".into()),
                SerialPortType::Unknown => None,
            };
            let label = description.map_or_else(|| port.port_name.clone(), |name| format!("{} · {name}", port.port_name));
            PortInfo { path: port.port_name, label }
        })
        .collect();
    #[cfg(target_os = "linux")]
    for port in linux_usb_port_candidates(Path::new("/dev")) {
        if !ports.iter().any(|listed| listed.path == port.path) { ports.push(port); }
    }
    ports.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ports)
}

#[cfg(target_os = "linux")]
fn linux_usb_port_candidates(dev_root: &Path) -> Vec<PortInfo> {
    use std::os::unix::fs::FileTypeExt;
    let Ok(entries) = std::fs::read_dir(dev_root) else { return Vec::new(); };
    entries.filter_map(|entry| {
        let entry = entry.ok()?;
        let name = entry.file_name().into_string().ok()?;
        let suffix = name.strip_prefix("ttyACM").or_else(|| name.strip_prefix("ttyUSB"))?;
        if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) ||
            !entry.path().metadata().ok()?.file_type().is_char_device() { return None; }
        let path = entry.path().to_string_lossy().into_owned();
        Some(PortInfo { label: path.clone(), path })
    }).collect()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortConfig {
    pub path: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    pub flow_control: String,
}

impl PortConfig {
    fn validate(&self) -> Result<(DataBits, Parity, StopBits, FlowControl), String> {
        if self.path.trim().is_empty() || self.path.contains('\0') {
            return Err("请选择或输入有效的本机串口路径".into());
        }
        if !(300..=4_000_000).contains(&self.baud_rate) {
            return Err("波特率须在 300～4000000 之间".into());
        }
        let data_bits = match self.data_bits {
            5 => DataBits::Five, 6 => DataBits::Six, 7 => DataBits::Seven, 8 => DataBits::Eight,
            _ => return Err("数据位须为 5～8".into()),
        };
        let parity = match self.parity.as_str() {
            "none" => Parity::None, "even" => Parity::Even, "odd" => Parity::Odd,
            _ => return Err("校验位无效".into()),
        };
        let stop_bits = match self.stop_bits {
            1 => StopBits::One, 2 => StopBits::Two, _ => return Err("停止位须为 1 或 2".into()),
        };
        let flow_control = match self.flow_control.as_str() {
            "none" => FlowControl::None,
            "software" => FlowControl::Software,
            "hardware" => FlowControl::Hardware,
            _ => return Err("流控方式无效".into()),
        };
        Ok((data_bits, parity, stop_bits, flow_control))
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SerialEvent {
    Data { session_id: u64, direction: String, time_ms: u64, elapsed_us: u64, bytes: Vec<u8> },
    Status { session_id: u64, connected: bool, recording: bool, error: Option<String> },
    ReplayDone { session_id: u64, records: usize },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    session_id: u64,
    path: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRecord {
    time_ms: u64,
    elapsed_us: u64,
    direction: String,
    hex: String,
}

enum WorkerCommand {
    Write(Vec<u8>, mpsc::Sender<Result<usize, String>>),
    StartRecord(String, mpsc::Sender<Result<(), String>>),
    StopRecord(mpsc::Sender<Result<(), String>>),
    SetDtr(bool, mpsc::Sender<Result<(), String>>),
    SetRts(bool, mpsc::Sender<Result<(), String>>),
    Stop,
}

struct Session {
    id: u64,
    sender: mpsc::Sender<WorkerCommand>,
    handle: JoinHandle<()>,
}

pub struct SerialManager {
    next_id: AtomicU64,
    session: Mutex<Option<Session>>,
}

pub fn global() -> &'static SerialManager {
    static MANAGER: OnceLock<SerialManager> = OnceLock::new();
    MANAGER.get_or_init(|| SerialManager { next_id: AtomicU64::new(1), session: Mutex::new(None) })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn write_capture(writer: &mut BufWriter<File>, direction: &str, time_ms: u64, elapsed_us: u64, bytes: &[u8]) -> Result<(), String> {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes { use std::fmt::Write as _; let _ = write!(&mut hex, "{byte:02X}"); }
    serde_json::to_writer(&mut *writer, &CaptureRecord { time_ms, elapsed_us, direction: direction.into(), hex })
        .map_err(|error| error.to_string())?;
    writer.write_all(b"\n").map_err(|error| error.to_string())
}

fn worker(
    mut port: Box<dyn serialport::SerialPort>,
    config: PortConfig,
    session_id: u64,
    receiver: mpsc::Receiver<WorkerCommand>,
    on_event: Channel<SerialEvent>,
) {
    let started = Instant::now();
    let mut recording: Option<BufWriter<File>> = None;
    let mut last_record_flush = Instant::now();
    let mut buffer = [0u8; 8192];
    let mut running = true;
    while running {
        while let Ok(command) = receiver.try_recv() {
            match command {
                WorkerCommand::Write(bytes, reply) => {
                    let result = port.write_all(&bytes).map(|_| bytes.len()).map_err(|error| format!("串口发送失败：{error}"));
                    if result.is_ok() {
                        let time_ms = now_ms();
                        let elapsed_us = started.elapsed().as_micros() as u64;
                        if let Some(writer) = recording.as_mut() {
                            if let Err(error) = write_capture(writer, "tx", time_ms, elapsed_us, &bytes) {
                                recording = None;
                                let _ = on_event.send(SerialEvent::Status { session_id, connected: true, recording: false, error: Some(format!("记录写入失败：{error}")) });
                            }
                        }
                        let _ = on_event.send(SerialEvent::Data { session_id, direction: "tx".into(), time_ms, elapsed_us, bytes });
                    }
                    let _ = reply.send(result);
                }
                WorkerCommand::StartRecord(path, reply) => {
                    if recording.is_some() {
                        let _ = reply.send(Err("记录已在进行中".into()));
                        continue;
                    }
                    let result = (|| {
                        let file = OpenOptions::new().write(true).create(true).truncate(true).open(&path)
                            .map_err(|error| format!("无法创建记录文件：{error}"))?;
                        let mut writer = BufWriter::new(file);
                        let header = serde_json::json!({ "format": "serial-assistant-capture", "version": 1, "port": config, "startedMs": now_ms() });
                        serde_json::to_writer(&mut writer, &header).map_err(|error| error.to_string())?;
                        writer.write_all(b"\n").map_err(|error| error.to_string())?;
                        writer.flush().map_err(|error| error.to_string())?;
                        Ok::<_, String>(writer)
                    })();
                    let outcome = match result {
                        Ok(writer) => { recording = Some(writer); last_record_flush = Instant::now(); Ok(()) }
                        Err(error) => Err(error),
                    };
                    let _ = reply.send(outcome);
                    let _ = on_event.send(SerialEvent::Status { session_id, connected: true, recording: recording.is_some(), error: None });
                }
                WorkerCommand::StopRecord(reply) => {
                    let result = recording.take().map_or(Ok(()), |mut writer| writer.flush().map_err(|error| error.to_string()));
                    let _ = reply.send(result);
                    let _ = on_event.send(SerialEvent::Status { session_id, connected: true, recording: false, error: None });
                }
                WorkerCommand::SetDtr(value, reply) => { let _ = reply.send(port.write_data_terminal_ready(value).map_err(|error| error.to_string())); }
                WorkerCommand::SetRts(value, reply) => { let _ = reply.send(port.write_request_to_send(value).map_err(|error| error.to_string())); }
                WorkerCommand::Stop => { running = false; break; }
            }
        }
        if !running { break; }
        if last_record_flush.elapsed() >= Duration::from_secs(1) {
            if let Some(writer) = recording.as_mut() {
                if let Err(error) = writer.flush() {
                    recording = None;
                    let _ = on_event.send(SerialEvent::Status { session_id, connected: true, recording: false,
                        error: Some(format!("记录写入失败：{error}")) });
                }
            }
            last_record_flush = Instant::now();
        }
        match port.read(&mut buffer) {
            Ok(0) => {}
            Ok(count) => {
                let time_ms = now_ms();
                let elapsed_us = started.elapsed().as_micros() as u64;
                let bytes = buffer[..count].to_vec();
                if let Some(writer) = recording.as_mut() {
                    if let Err(error) = write_capture(writer, "rx", time_ms, elapsed_us, &bytes) {
                        recording = None;
                        let _ = on_event.send(SerialEvent::Status { session_id, connected: true, recording: false, error: Some(format!("记录写入失败：{error}")) });
                    }
                }
                if on_event.send(SerialEvent::Data { session_id, direction: "rx".into(), time_ms, elapsed_us, bytes }).is_err() { break; }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(error) => {
                let _ = on_event.send(SerialEvent::Status { session_id, connected: false, recording: false, error: Some(format!("串口已断开：{error}")) });
                break;
            }
        }
    }
    if let Some(mut writer) = recording {
        if let Err(error) = writer.flush() {
            let _ = on_event.send(SerialEvent::Status { session_id, connected: false, recording: false,
                error: Some(format!("记录保存失败：{error}")) });
        }
    }
    let _ = on_event.send(SerialEvent::Status { session_id, connected: false, recording: false, error: None });
}

impl SerialManager {
    pub fn open(&self, config: PortConfig, on_event: Channel<SerialEvent>) -> Result<SessionInfo, String> {
        let (data_bits, parity, stop_bits, flow_control) = config.validate()?;
        let mut guard = self.session.lock().map_err(|error| error.to_string())?;
        if guard.as_ref().is_some_and(|session| session.handle.is_finished()) {
            if let Some(session) = guard.take() { let _ = session.handle.join(); }
        }
        if guard.is_some() { return Err("串口助手已有打开的本机串口，请先断开".into()); }
        let port = serialport::new(&config.path, config.baud_rate)
            .data_bits(data_bits).parity(parity).stop_bits(stop_bits).flow_control(flow_control)
            .timeout(READ_TIMEOUT).open()
            .map_err(|error| format!("无法打开 {}：{error}。请检查设备权限及是否被其他程序占用。", config.path))?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let path = config.path.clone();
        let (sender, receiver) = mpsc::channel();
        let handle = thread::spawn(move || worker(port, config, id, receiver, on_event));
        *guard = Some(Session { id, sender, handle });
        Ok(SessionInfo { session_id: id, path })
    }

    fn sender(&self, id: u64) -> Result<mpsc::Sender<WorkerCommand>, String> {
        let guard = self.session.lock().map_err(|error| error.to_string())?;
        guard.as_ref().filter(|session| session.id == id && !session.handle.is_finished())
            .map(|session| session.sender.clone()).ok_or_else(|| "串口会话已关闭".into())
    }

    fn request<T>(&self, id: u64, make_command: impl FnOnce(mpsc::Sender<Result<T, String>>) -> WorkerCommand) -> Result<T, String> {
        let sender = self.sender(id)?;
        let (reply, result) = mpsc::channel();
        sender.send(make_command(reply)).map_err(|_| "串口会话已关闭".to_string())?;
        result.recv_timeout(Duration::from_secs(5)).map_err(|_| "串口操作超时".to_string())?
    }

    pub fn write(&self, id: u64, bytes: Vec<u8>) -> Result<usize, String> {
        if bytes.is_empty() || bytes.len() > MAX_WRITE { return Err("单次发送须为 1～65536 字节".into()); }
        self.request(id, |reply| WorkerCommand::Write(bytes, reply))
    }

    pub fn start_record(&self, id: u64, path: String) -> Result<(), String> {
        if !path.ends_with(".serialcap") { return Err("请选择 .serialcap 记录文件".into()); }
        self.request(id, |reply| WorkerCommand::StartRecord(path, reply))
    }

    pub fn stop_record(&self, id: u64) -> Result<(), String> {
        self.request(id, WorkerCommand::StopRecord)
    }

    pub fn set_dtr(&self, id: u64, value: bool) -> Result<(), String> {
        self.request(id, |reply| WorkerCommand::SetDtr(value, reply))
    }

    pub fn set_rts(&self, id: u64, value: bool) -> Result<(), String> {
        self.request(id, |reply| WorkerCommand::SetRts(value, reply))
    }

    pub fn close(&self, id: u64) -> Result<(), String> {
        let mut guard = self.session.lock().map_err(|error| error.to_string())?;
        let session = guard.take().ok_or("串口会话已关闭")?;
        if session.id != id { *guard = Some(session); return Err("串口会话已变化".into()); }
        let _ = session.sender.send(WorkerCommand::Stop);
        drop(guard);
        session.handle.join().map_err(|_| "串口线程异常退出".to_string())
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.session.lock() {
            if let Some(session) = guard.take() {
                let _ = session.sender.send(WorkerCommand::Stop);
                let _ = session.handle.join();
            }
        }
    }
}

pub fn replay(path: String, on_event: Channel<SerialEvent>) -> Result<usize, String> {
    let file = File::open(&path).map_err(|error| format!("无法打开记录：{error}"))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|error| error.to_string())?;
    let header: serde_json::Value = serde_json::from_str(&line).map_err(|error| format!("记录文件头无效：{error}"))?;
    if header.get("format").and_then(|value| value.as_str()) != Some("serial-assistant-capture") || header.get("version").and_then(|value| value.as_u64()) != Some(1) {
        return Err("不是受支持的串口助手记录".into());
    }
    let mut count = 0;
    for line in reader.lines() {
        let line = line.map_err(|error| error.to_string())?;
        let record: CaptureRecord = serde_json::from_str(&line).map_err(|error| format!("第 {} 条记录无效：{error}", count + 1))?;
        if record.direction != "rx" && record.direction != "tx" {
            return Err(format!("第 {} 条记录的方向无效", count + 1));
        }
        let bytes = decode_hex(&record.hex)?;
        on_event.send(SerialEvent::Data { session_id: 0, direction: record.direction, time_ms: record.time_ms, elapsed_us: record.elapsed_us, bytes })
            .map_err(|error| format!("记录回放中断：{error}"))?;
        count += 1;
    }
    let _ = on_event.send(SerialEvent::ReplayDone { session_id: 0, records: count });
    Ok(count)
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    let value = value.as_bytes();
    if value.len() % 2 != 0 { return Err("记录中存在奇数个十六进制字符".into()); }
    let digit = |byte: u8| -> Result<u8, String> {
        (byte as char).to_digit(16).map(|digit| digit as u8).ok_or_else(|| "记录含无效十六进制字符".into())
    };
    value.chunks_exact(2).map(|pair| Ok(digit(pair[0])? << 4 | digit(pair[1])?)).collect()
}

#[cfg(target_os = "linux")]
pub async fn pick_path(window: tauri::WebviewWindow, save: bool) -> Result<Option<String>, String> {
    use gtk::prelude::*;
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<PathBuf>, String>>();
    let parent = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent.gtk_window().map_err(|error| error.to_string())?;
                let action = if save { gtk::FileChooserAction::Save } else { gtk::FileChooserAction::Open };
                let dialog = gtk::FileChooserNative::new(Some(if save { "保存串口记录" } else { "打开串口记录" }), Some(&parent), action,
                    Some(if save { "保存" } else { "打开" }), Some("取消"));
                dialog.set_modal(true);
                if save { dialog.set_do_overwrite_confirmation(true); }
                let filter = gtk::FileFilter::new();
                filter.set_name(Some("串口记录 (*.serialcap)"));
                filter.add_pattern("*.serialcap");
                dialog.add_filter(filter);
                if save { dialog.set_current_name("serial-capture.serialcap"); }
                let response = dialog.run_future().await;
                let selected = if response == gtk::ResponseType::Accept { dialog.filename() } else { None };
                dialog.destroy();
                Ok(selected)
            }.await;
            let _ = sender.send(result);
        });
    }).map_err(|error| error.to_string())?;
    Ok(receiver.await.map_err(|error| error.to_string())??.map(|mut path| {
        if save && !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("serialcap")) {
            path.set_extension("serialcap");
        }
        path.to_string_lossy().into_owned()
    }))
}

#[cfg(target_os = "linux")]
pub async fn export(window: tauri::WebviewWindow, kind: String, bytes: Vec<u8>) -> Result<Option<String>, String> {
    use gtk::prelude::*;
    let (name, pattern, extension) = match kind.as_str() {
        "binary" => ("serial-data.bin", "*.bin", "bin"),
        "csv" => ("serial-frames.csv", "*.csv", "csv"),
        "json" => ("serial-frames.json", "*.json", "json"),
        _ => return Err("导出格式无效".into()),
    };
    if bytes.len() > 32 * 1024 * 1024 { return Err("当前窗口数据过大，请使用原始记录文件".into()); }
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<PathBuf>, String>>();
    let parent = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent.gtk_window().map_err(|error| error.to_string())?;
                let dialog = gtk::FileChooserNative::new(Some("导出串口数据"), Some(&parent), gtk::FileChooserAction::Save,
                    Some("保存"), Some("取消"));
                dialog.set_modal(true);
                dialog.set_do_overwrite_confirmation(true);
                dialog.set_current_name(name);
                let filter = gtk::FileFilter::new();
                filter.set_name(Some(pattern));
                filter.add_pattern(pattern);
                dialog.add_filter(filter);
                let response = dialog.run_future().await;
                let selected = if response == gtk::ResponseType::Accept { dialog.filename() } else { None };
                dialog.destroy();
                Ok(selected)
            }.await;
            let _ = sender.send(result);
        });
    }).map_err(|error| error.to_string())?;
    let Some(mut path) = receiver.await.map_err(|error| error.to_string())?? else { return Ok(None); };
    if !path.extension().is_some_and(|value| value.eq_ignore_ascii_case(extension)) { path.set_extension(extension); }
    let display = path.to_string_lossy().into_owned();
    super::run_blocking(move || std::fs::write(&path, bytes).map_err(|error| format!("导出失败：{error}"))).await?;
    Ok(Some(display))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_port_enumeration_returns_without_simulator() {
        list_ports().unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_fallback_lists_every_acm_interface() {
        use std::os::unix::fs::symlink;
        let directory = std::env::temp_dir().join(format!("serial-assistant-ports-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir(&directory).unwrap();
        for name in ["ttyACM0", "ttyACM1", "ttyACM2", "ttyACM3", "ttyUSB0", "ttyACMbad"] {
            symlink("/dev/null", directory.join(name)).unwrap();
        }
        let ports = linux_usb_port_candidates(&directory);
        assert_eq!(ports.len(), 5);
        for number in 0..4 { assert!(ports.iter().any(|port| port.path.ends_with(&format!("ttyACM{number}")))); }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn capture_round_trip_preserves_binary_and_direction() {
        let path = std::env::temp_dir().join(format!("serial-assistant-{}-{}.serialcap", std::process::id(), now_ms()));
        let config = PortConfig { path: "/dev/ttyTEST".into(), baud_rate: 115200, data_bits: 8, parity: "none".into(), stop_bits: 1, flow_control: "none".into() };
        let file = File::create(&path).unwrap();
        let mut writer = BufWriter::new(file);
        serde_json::to_writer(&mut writer, &serde_json::json!({ "format": "serial-assistant-capture", "version": 1, "port": config })).unwrap();
        writer.write_all(b"\n").unwrap();
        write_capture(&mut writer, "rx", 42, 100, &[0, 0xff, 0x55]).unwrap();
        write_capture(&mut writer, "tx", 43, 200, &[0xaa]).unwrap();
        writer.flush().unwrap();
        let lines: Vec<String> = BufReader::new(File::open(&path).unwrap()).lines().map(Result::unwrap).collect();
        assert_eq!(lines.len(), 3);
        let rx: CaptureRecord = serde_json::from_str(&lines[1]).unwrap();
        let tx: CaptureRecord = serde_json::from_str(&lines[2]).unwrap();
        assert_eq!(rx.direction, "rx");
        assert_eq!(decode_hex(&rx.hex).unwrap(), vec![0, 255, 85]);
        assert_eq!(tx.direction, "tx");
        assert_eq!(decode_hex(&tx.hex).unwrap(), vec![0xaa]);
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pseudo_terminal_receives_sends_and_releases_port() {
        use serialport::SerialPort;
        let (mut peer, slave) = serialport::TTYPort::pair().unwrap();
        let path = slave.name().unwrap();
        drop(slave);
        peer.set_timeout(Duration::from_secs(1)).unwrap();
        let manager = SerialManager { next_id: AtomicU64::new(1), session: Mutex::new(None) };
        let (event_sender, event_receiver) = mpsc::channel::<serde_json::Value>();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(source) = body {
                event_sender.send(serde_json::from_str(&source).unwrap()).unwrap();
            }
            Ok(())
        });
        let info = manager.open(PortConfig { path, baud_rate: 115200, data_bits: 8, parity: "none".into(),
            stop_bits: 1, flow_control: "none".into() }, channel).unwrap();
        peer.write_all(&[0, 0xff, 0x55]).unwrap();
        let received = event_receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(received["kind"], "data");
        assert_eq!(received["direction"], "rx");
        assert_eq!(received["bytes"], serde_json::json!([0, 255, 85]));
        let capture = std::env::temp_dir().join(format!("serial-assistant-pty-{}-{}.serialcap", std::process::id(), now_ms()));
        manager.start_record(info.session_id, capture.to_string_lossy().into_owned()).unwrap();
        peer.write_all(&[0xfe, 0x01]).unwrap();
        while event_receiver.recv_timeout(Duration::from_secs(2)).unwrap()["kind"] != "data" {}
        assert_eq!(manager.write(info.session_id, vec![0xaa, 0x42]).unwrap(), 2);
        let mut buffer = [0u8; 2];
        peer.read_exact(&mut buffer).unwrap();
        assert_eq!(buffer, [0xaa, 0x42]);
        assert!(manager.start_record(info.session_id, capture.to_string_lossy().into_owned()).is_err());
        manager.stop_record(info.session_id).unwrap();
        manager.close(info.session_id).unwrap();
        assert!(manager.session.lock().unwrap().is_none());
        let lines: Vec<String> = BufReader::new(File::open(&capture).unwrap()).lines().map(Result::unwrap).collect();
        assert_eq!(lines.len(), 3);
        let rx: CaptureRecord = serde_json::from_str(&lines[1]).unwrap();
        let tx: CaptureRecord = serde_json::from_str(&lines[2]).unwrap();
        assert_eq!(decode_hex(&rx.hex).unwrap(), vec![0xfe, 0x01]);
        assert_eq!(decode_hex(&tx.hex).unwrap(), vec![0xaa, 0x42]);
        let (replay_sender, replay_receiver) = mpsc::channel::<serde_json::Value>();
        let replay_channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(source) = body {
                replay_sender.send(serde_json::from_str(&source).unwrap()).unwrap();
            }
            Ok(())
        });
        assert_eq!(replay(capture.to_string_lossy().into_owned(), replay_channel).unwrap(), 2);
        assert_eq!(replay_receiver.recv_timeout(Duration::from_secs(1)).unwrap()["bytes"], serde_json::json!([0xfe, 0x01]));
        assert_eq!(replay_receiver.recv_timeout(Duration::from_secs(1)).unwrap()["bytes"], serde_json::json!([0xaa, 0x42]));
        std::fs::remove_file(capture).unwrap();
    }
}
