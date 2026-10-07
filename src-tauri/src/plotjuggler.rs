use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const MAX_RATE_HZ: u16 = 200;
const DEFAULT_RATE_HZ: u16 = 50;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    running: bool,
    ready: bool,
    sent: u64,
    received: u64,
    dropped: u64,
    error: Option<String>,
    log_path: Option<String>,
    last_packet_age_ms: Option<u64>,
    rate_hz: u16,
}
#[derive(Default)]
struct Sampler {
    last_sent: Option<Instant>,
    pending: Map<String, Value>,
}
impl Sampler {
    fn next(&mut self, value: Value, now: Instant, rate_hz: u16) -> Option<Value> {
        if rate_hz == 0 { return Some(value); }
        let time = value["time"].clone();
        if let Some(values) = value["values"].as_object() {
            self.pending.extend(values.clone());
        }
        let interval = Duration::from_secs_f64(1.0 / f64::from(rate_hz));
        if self.last_sent.is_some_and(|last| now.duration_since(last) < interval) {
            return None;
        }
        self.last_sent = Some(now);
        Some(json!({"time": time, "values": std::mem::take(&mut self.pending)}))
    }
}
struct Session {
    child: Child,
    socket: UdpSocket,
    started: Instant,
    status_path: PathBuf,
    log_path: PathBuf,
    sent: u64,
    dropped: u64,
    error: Option<String>,
    last_packet: Option<Instant>,
    sampler: Sampler,
}
pub struct Bridge { session: Mutex<Option<Session>>, rate_hz: Mutex<u16> }
impl Default for Bridge {
    fn default() -> Self {
        Self { session: Mutex::new(None), rate_hz: Mutex::new(DEFAULT_RATE_HZ) }
    }
}
pub fn global() -> &'static Bridge {
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();
    BRIDGE.get_or_init(Bridge::default)
}

// Only actual values in this packet become samples. Never forward the UI's
// cached/merged tree, which would fabricate repeated samples for sparse slices.
fn flatten(path: &str, value: &Value, output: &mut Map<String, Value>) {
    match value {
        Value::Number(_) => { output.insert(path.trim_start_matches('/').into(), value.clone()); }
        Value::Object(fields) => {
            for (key, value) in fields {
                let key = key.trim_start_matches('/');
                let next = if path.is_empty() { key.to_owned() } else { format!("{path}/{key}") };
                flatten(&next, value, output);
            }
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                // Top task order changes each second. PID is the series identity.
                let key = if path == "task_top/tasks" {
                    let Some(pid) = value.get("pid").and_then(Value::as_u64) else { continue; };
                    format!("pid_{pid}")
                } else { index.to_string() };
                flatten(&format!("{path}/{key}"), value, output);
            }
        }
        _ => {}
    }
}
fn packet(payload: &Value, time: f64) -> Option<Value> {
    let mut values = Map::new();
    for (key, value) in payload.as_object()? {
        let path = match key.as_str() {
            "properties" => "",
            "timestamp" => "simulation/time_s",
            other => other,
        };
        flatten(path, value, &mut values);
    }
    if values.is_empty() { None } else { Some(json!({"time": time, "values": values})) }
}
fn executable() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("JSBSIM_PLOTJUGGLER_BIN") { candidates.push(PathBuf::from(path)); }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() { candidates.push(parent.join("plotjuggler/bin/plotjuggler")); }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.toolchains/plotjuggler-build/bin/plotjuggler"));
    for path in candidates {
        if path.is_file() { return path.canonicalize().map_err(|e| e.to_string()); }
    }
    Err("未找到集成版 PlotJuggler，请先运行 integrations/plotjuggler/build.sh。".into())
}
impl Bridge {
    pub fn start(&self, directory: &Path) -> Result<Status, String> {
        let rate_hz = *self.rate_hz.lock().unwrap();
        let mut guard = self.session.lock().unwrap();
        if let Some(session) = guard.as_mut() {
            if session.child.try_wait().map_err(|e| e.to_string())?.is_none() {
                fs::write(session.status_path.with_extension("focus"), b"focus").map_err(|e| e.to_string())?;
                return Ok(session.status(rate_hz));
            }
        }
        let executable = executable()?;
        let plugins = executable.parent().ok_or("PlotJuggler 路径无效")?;
        if !plugins.join("libJSBSimLive.so").is_file() {
            return Err("缺少 JSBSim Live 数据插件，请重新构建集成版 PlotJuggler。".into());
        }
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let status_path = directory.join(format!("status-{}.json", std::process::id()));
        if status_path.exists() { fs::remove_file(&status_path).map_err(|e| e.to_string())?; }
        let log_path = directory.join("plotjuggler.log");
        let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
        // Let the OS select a free local destination instead of using the board's port.
        let reservation = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let destination = reservation.local_addr().map_err(|e| e.to_string())?;
        let socket = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        socket.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = destination.port();
        drop(reservation);
        socket.connect(destination).map_err(|e| e.to_string())?;
        let child = Command::new(&executable)
            .args(["--nosplash", "--start_streamer", "--buffer_size", "300", "--window_title", "JSBSim · PlotJuggler", "--plugin_folders"])
            .arg(plugins)
            .args(["--enabled_plugins", "libJSBSimLive;libDataLoadCSV;libPublisherCSV"])
            .env("JSBSIM_PLOTJUGGLER_PORT", port.to_string())
            .env("JSBSIM_PLOTJUGGLER_STATUS", &status_path)
            .env("XDG_CONFIG_HOME", directory.join("config"))
            .stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log)
            .spawn().map_err(|e| format!("无法启动 PlotJuggler: {e}"))?;
        *guard = Some(Session { child, socket, started: Instant::now(), status_path, log_path,
            sent: 0, dropped: 0, error: None, last_packet: None, sampler: Sampler::default() });
        Ok(guard.as_mut().unwrap().status(rate_hz))
    }
    pub fn status(&self) -> Status {
        let rate_hz = *self.rate_hz.lock().unwrap();
        self.session.lock().unwrap().as_mut().map(|session| session.status(rate_hz))
            .unwrap_or(Status { rate_hz, ..Status::default() })
    }
    pub fn set_rate(&self, rate_hz: u16) -> Result<Status, String> {
        if rate_hz > MAX_RATE_HZ { return Err(format!("发送频率须为 0～{MAX_RATE_HZ} Hz，0 表示逐包发送")); }
        let mut current = self.rate_hz.lock().unwrap();
        if *current != rate_hz {
            *current = rate_hz;
            if let Some(session) = self.session.lock().unwrap().as_mut() {
                session.sampler = Sampler::default();
            }
        }
        drop(current);
        Ok(self.status())
    }
    pub fn forward(&self, payload: &Value) {
        let rate_hz = *self.rate_hz.lock().unwrap();
        let mut guard = self.session.lock().unwrap();
        let Some(session) = guard.as_mut() else { return; };
        // Check at the packet boundary so a closed child never receives further forwarding.
        if !matches!(session.child.try_wait(), Ok(None)) { return; }
        let now = Instant::now();
        let Some(value) = packet(payload, session.started.elapsed().as_secs_f64()) else { return; };
        let Some(value) = session.sampler.next(value, now, rate_hz) else { return; };
        let bytes = serde_json::to_vec(&value).unwrap_or_default();
        match session.socket.send(&bytes) {
            Ok(_) => { session.sent += 1; session.last_packet = Some(Instant::now()); session.error = None; }
            Err(e) => { session.dropped += 1; session.error = Some(format!("遥测转发失败: {e}")); }
        }
    }
}
impl Session {
    fn status(&mut self, rate_hz: u16) -> Status {
        let running = match self.child.try_wait() {
            Ok(None) => true,
            Ok(Some(exit)) => {
                if !exit.success() { self.error = Some(format!("PlotJuggler 已退出 ({exit})，详情见运行日志。")); }
                false
            }
            Err(e) => { self.error = Some(e.to_string()); false }
        };
        let report = fs::read(&self.status_path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let ready = running && report.as_ref().and_then(|v| v["ready"].as_bool()).unwrap_or(false);
        let error = if running && !ready && self.started.elapsed().as_secs() > 15 {
            Some("PlotJuggler 数据插件未就绪，请检查运行日志。".into())
        } else { self.error.clone() };
        Status { running, ready, sent: self.sent,
            received: report.as_ref().and_then(|v| v["received"].as_u64()).unwrap_or(0),
            dropped: self.dropped, last_packet_age_ms: self.last_packet.map(|time| time.elapsed().as_millis() as u64),
            error, log_path: Some(self.log_path.to_string_lossy().into_owned()), rate_hz }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sparse_packets_keep_sampling_and_task_identity() {
        let a = packet(&json!({"timestamp": 9.0, "properties": {"/attitude/phi-deg": 3.0}}), 12.0).unwrap();
        let b = packet(&json!({"timestamp": 0.0, "properties": {"/position/h-sl-ft": 8.0}}), 13.0).unwrap();
        assert_eq!(a["values"]["attitude/phi-deg"], 3.0);
        assert!(b["values"].get("attitude/phi-deg").is_none());
        assert_eq!(b["time"], 13.0);
        assert_eq!(b["values"]["simulation/time_s"], 0.0);
        let tasks = packet(&json!({"task_top":{"tasks":[{"pid":42,"load":70},{"pid":8,"load":20}]}}), 1.0).unwrap();
        let reordered = packet(&json!({"task_top":{"tasks":[{"pid":8,"load":30},{"pid":42,"load":10}]}}), 2.0).unwrap();
        assert_eq!(tasks["values"]["task_top/tasks/pid_42/load"], 70);
        assert_eq!(reordered["values"]["task_top/tasks/pid_42/load"], 10);
        assert!(packet(&json!({"kind":"heartbeat","state":"running"}), 1.0).is_none());
    }

    #[test]
    fn rate_limit_merges_sparse_values_without_repeating_old_ones() {
        assert_eq!(Bridge::default().status().rate_hz, DEFAULT_RATE_HZ);
        let mut sampler = Sampler::default();
        let start = Instant::now();
        let a = packet(&json!({"properties":{"/a":1}}), 0.0).unwrap();
        let b = packet(&json!({"properties":{"/b":2}}), 0.04).unwrap();
        let c = packet(&json!({"properties":{"/a":3}}), 0.08).unwrap();
        let d = packet(&json!({"properties":{"/c":4}}), 0.10).unwrap();
        assert_eq!(sampler.next(a, start, 10).unwrap()["values"]["a"], 1);
        assert!(sampler.next(b, start + Duration::from_millis(40), 10).is_none());
        assert!(sampler.next(c, start + Duration::from_millis(80), 10).is_none());
        let output = sampler.next(d, start + Duration::from_millis(100), 10).unwrap();
        assert_eq!(output["values"], json!({"a":3,"b":2,"c":4}));
        assert_eq!(output["time"], 0.10);
        let e = packet(&json!({"properties":{"/b":5}}), 0.20).unwrap();
        let output = sampler.next(e, start + Duration::from_millis(200), 10).unwrap();
        assert_eq!(output["values"], json!({"b":5}));
        assert!(Bridge::default().set_rate(201).is_err());
    }

    #[test]
    #[ignore = "Launches the locally built native PlotJuggler and its real plugin"]
    fn native_process_receives_live_packets() {
        let bridge = Bridge::default();
        bridge.set_rate(0).unwrap();
        let directory = std::env::temp_dir().join(format!("jsbsim-pj-test-{}", std::process::id()));
        bridge.start(&directory).unwrap();
        let result = std::panic::catch_unwind(|| {
            let deadline = Instant::now() + std::time::Duration::from_secs(20);
            while !bridge.status().ready {
                assert!(Instant::now() < deadline, "Plugin not ready; log: {}", directory.join("plotjuggler.log").display());
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let pid = bridge.session.lock().unwrap().as_ref().unwrap().child.id();
            bridge.start(&directory).unwrap();
            assert_eq!(pid, bridge.session.lock().unwrap().as_ref().unwrap().child.id());
            for i in 0..100 {
                bridge.forward(&json!({"timestamp": i as f64 * 0.01,
                    "properties": {"/validation/sine": (i as f64 * 0.1).sin()}}));
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            let deadline = Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let status = bridge.status();
                if status.received == 100 {
                    assert_eq!(status.sent, 100);
                    assert_eq!(status.dropped, 0);
                    let report: Value = serde_json::from_slice(&fs::read(directory.join(format!("status-{}.json", std::process::id()))).unwrap()).unwrap();
                    assert_eq!(report["samples"], 200);
                    assert_eq!(report["series"], 2);
                    break;
                }
                assert!(Instant::now() < deadline, "Only received {} packets", status.received);
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            assert_eq!(bridge.set_rate(10).unwrap().rate_hz, 10);
            for i in 0..20 {
                bridge.forward(&json!({"timestamp": 2.0 + i as f64 * 0.01,
                    "properties": {"/validation/sine": i as f64}}));
            }
            assert_eq!(bridge.status().sent, 101);
            std::thread::sleep(Duration::from_millis(110));
            bridge.forward(&json!({"timestamp": 2.2, "properties": {"/validation/sine": 20.0}}));
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let status = bridge.status();
                if status.received == 102 {
                    assert_eq!(status.sent, 102);
                    assert_eq!(status.dropped, 0);
                    println!("Native PlotJuggler: received=102, sent=102, dropped=0; 10 Hz limiter and process reuse verified");
                    break;
                }
                assert!(Instant::now() < deadline, "Only received {} limited packets", status.received);
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        if let Some(session) = bridge.session.lock().unwrap().as_mut() {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        if let Err(error) = result { std::panic::resume_unwind(error); }
    }
}
