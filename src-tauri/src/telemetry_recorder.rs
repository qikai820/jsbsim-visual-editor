use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub recording: bool,
    pub path: Option<String>,
    pub written: u64,
    pub dropped: u64,
    pub error: Option<String>,
}
struct Session {
    sender: mpsc::SyncSender<Value>,
    worker: std::thread::JoinHandle<()>,
    started: Instant,
    sequence: u64,
}
#[derive(Default)]
struct Inner { session: Option<Session>, stopping: bool }
#[derive(Default)]
pub struct Recorder { inner: Mutex<Inner>, status: Arc<Mutex<Status>> }
static RECORDER: OnceLock<Recorder> = OnceLock::new();
pub fn global() -> &'static Recorder { RECORDER.get_or_init(Recorder::default) }
fn unix_us() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_micros() }
fn line(writer: &mut impl Write, value: &Value) -> std::io::Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")
}
impl Recorder {
    pub fn status(&self) -> Status { self.status.lock().unwrap().clone() }
    pub fn start(&self, directory: &Path) -> Result<Status, String> {
        // Reap a failed writer before allowing another recording.
        if !self.status().recording { self.stop(); }
        let mut inner = self.inner.lock().unwrap();
        if inner.session.is_some() || inner.stopping { return Err("已有遥测记录正在运行或保存".into()); }
        fs::create_dir_all(directory).map_err(|e| format!("无法创建记录目录: {e}"))?;
        let directory = directory.canonicalize().map_err(|e| e.to_string())?;
        let path = directory.join(format!("telemetry-{}-{}.jsonl", unix_us(), std::process::id()));
        let file = OpenOptions::new().write(true).create_new(true).open(&path)
            .map_err(|e| format!("无法创建记录文件: {e}"))?;
        let mut writer = BufWriter::new(file);
        line(&mut writer, &json!({"type":"header","format":"jsbsim-telemetry","version":1,
            "started_unix_us":unix_us(),"timestamp_unit":"microseconds",
            "source":"accepted JSON objects at desktop telemetry receiver"})).and_then(|_| writer.flush())
            .map_err(|e| format!("无法写入记录文件: {e}"))?;
        *self.status.lock().unwrap() = Status { recording:true, path:Some(path.to_string_lossy().into_owned()), ..Status::default() };
        let (sender, receiver) = mpsc::sync_channel::<Value>(4096);
        let status = Arc::clone(&self.status);
        let worker = std::thread::Builder::new().name("telemetry-writer".into()).spawn(move || {
            let result = (|| -> std::io::Result<()> {
                let mut last_flush = Instant::now();
                loop {
                    match receiver.recv_timeout(Duration::from_millis(200)) {
                        Ok(value) => { line(&mut writer, &value)?; status.lock().unwrap().written += 1; }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    if last_flush.elapsed() >= Duration::from_secs(1) {
                        writer.flush()?;
                        last_flush = Instant::now();
                    }
                }
                let summary = status.lock().unwrap().clone();
                line(&mut writer, &json!({"type":"summary","ended_unix_us":unix_us(),
                    "written":summary.written,"dropped":summary.dropped}))?;
                writer.flush()?;
                writer.get_ref().sync_all()
            })();
            let mut s = status.lock().unwrap();
            s.recording = false;
            if let Err(error) = result { s.error = Some(format!("遥测写盘失败: {error}")); }
        }).map_err(|e| {
            let mut status = self.status.lock().unwrap();
            status.recording = false;
            status.error = Some(e.to_string());
            e.to_string()
        })?;
        inner.session = Some(Session { sender, worker, started:Instant::now(), sequence:0 });
        Ok(self.status())
    }
    pub fn record(&self, peer: &str, payload: &Value) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(session) = inner.session.as_mut() {
            if !self.status.lock().unwrap().recording { return; }
            session.sequence += 1;
            let packet = json!({"type":"telemetry","sequence":session.sequence,
                "received_unix_us":unix_us(),"elapsed_us":session.started.elapsed().as_micros(),
                "peer":peer,"payload":payload});
            if session.sender.try_send(packet).is_err() { self.status.lock().unwrap().dropped += 1; }
        }
    }
    pub fn stop(&self) -> Status {
        let session = {
            let mut inner = self.inner.lock().unwrap();
            if inner.stopping { return self.status(); }
            let session = inner.session.take();
            inner.stopping = session.is_some();
            session
        };
        if let Some(session) = session {
            drop(session.sender); // Writer drains all queued packets before finishing.
            if session.worker.join().is_err() {
                let mut status = self.status.lock().unwrap();
                status.recording = false;
                status.error = Some("遥测写入线程异常结束".into());
            }
            self.inner.lock().unwrap().stopping = false;
        }
        self.status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_original_packets_and_drains_on_stop() {
        let directory = std::env::temp_dir().join(format!("telemetry-test-{}",unix_us()));
        let recorder = Recorder::default();
        let started = recorder.start(&directory).unwrap();
        assert!(recorder.start(&directory).is_err());
        let packets = [json!({"kind":"task_top","task_top":{"cpu_cores":[20,40],"fdm_max_ms":6.5}}),
            json!({"kind":"visual","properties":{"a":1.25}}),json!({"kind":"heartbeat","state":"stopped"})];
        for packet in &packets { recorder.record("127.0.0.1:1234",packet); }
        let stopped = recorder.stop();
        assert!(!stopped.recording); assert_eq!(stopped.written,3); assert_eq!(stopped.dropped,0);
        let lines: Vec<Value> = fs::read_to_string(started.path.unwrap()).unwrap().lines()
            .map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(),5);
        for (i, packet) in packets.iter().enumerate() { assert_eq!(&lines[i+1]["payload"],packet); }
        assert_eq!(lines[4]["type"],"summary");
        recorder.record("ignored", &json!({}));
        assert_eq!(recorder.status().written,3);
        let second = recorder.start(&directory).unwrap();
        assert_ne!(second.path,stopped.path);
        assert_eq!(recorder.stop().written,0);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn invalid_destination_is_reported() {
        let file = std::env::temp_dir().join(format!("telemetry-file-{}",unix_us()));
        fs::write(&file,b"occupied").unwrap();
        let recorder = Recorder::default();
        assert!(recorder.start(&file).is_err());
        assert!(!recorder.status().recording);
        assert_eq!(fs::read(&file).unwrap(),b"occupied");
        fs::remove_file(file).unwrap();
    }
}
