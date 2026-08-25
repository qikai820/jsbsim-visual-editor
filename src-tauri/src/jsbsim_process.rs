//! JSBSim process manager — spawns the standalone JSBSim binary,
//! reads telemetry via UDP socket output, and emits Tauri events.

use serde_json::{json, Value};
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

/// JSBSim binary path
const JSBSIM_BIN: &str = env!("JSBSIM_BIN", "JSBSim binary path not set");

/// JSBSim root directory
const JSBSIM_ROOT: &str = env!("JSBSIM_ROOT", "JSBSim root path not set");

/// UDP port for receiving JSBSim socket output telemetry
const TELEMETRY_PORT: u16 = 5124;

// ── Property names — must match create_output_xml() order ───────────────────

const PROPERTY_NAMES: &[&str] = &[
    "position/h-sl-ft",
    "position/lat-gc-deg",
    "position/long-gc-deg",
    "attitude/phi-deg",
    "attitude/theta-deg",
    "attitude/psi-deg",
    "velocities/u-fps",
    "velocities/v-fps",
    "velocities/w-fps",
    "velocities/p-rad_sec",
    "velocities/q-rad_sec",
    "velocities/r-rad_sec",
    "accelerations/udot-ft_sec2",
    "accelerations/vdot-ft_sec2",
    "accelerations/wdot-ft_sec2",
    "fcs/throttle-cmd-norm",
    "fcs/aileron-cmd-norm",
    "fcs/elevator-cmd-norm",
    "fcs/rudder-cmd-norm",
];

// ── Public state ────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct JsbsimManager {
    inner: Arc<Mutex<JsbsimInner>>,
}

struct JsbsimInner {
    child: Option<Child>,
    running: bool,
    paused: bool,
    script: Option<String>,
    model: Option<String>,
    // Last requested start target, used by restart()
    last_script: Option<String>,
    last_model: Option<String>,
}

const _: fn() = || {
    fn _assert<T: Clone + Send + Sync>() {}
    _assert::<JsbsimManager>();
};

impl JsbsimManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(JsbsimInner {
                child: None,
                running: false,
                paused: false,
                script: None,
                model: None,
                last_script: None,
                last_model: None,
            })),
        }
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().unwrap().running
    }

    pub fn is_paused(&self) -> bool {
        self.inner.lock().unwrap().paused
    }

    pub fn current_script(&self) -> Option<String> {
        self.inner.lock().unwrap().script.clone()
    }

    pub fn current_model(&self) -> Option<String> {
        self.inner.lock().unwrap().model.clone()
    }

    /// Start JSBSim with a run script (e.g., "scripts/c1721.xml")
    pub fn start_script(&self, script: &str, app_handle: tauri::AppHandle) -> Result<(), String> {
        self.stop()?;

        let script_path = Path::new(JSBSIM_ROOT).join(script);
        if !script_path.exists() {
            return Err(format!("Script not found: {}", script_path.display()));
        }

        let output_xml = self.create_output_xml();

        let child = Command::new(JSBSIM_BIN)
            .arg("--root=.")
            .arg(format!("--script={}", script_path.display()))
            .arg(format!("--logdirectivefile={}", output_xml.display()))
            .current_dir(JSBSIM_ROOT)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start JSBSim: {}", e))?;

        {
            let mut inner = self.inner.lock().unwrap();
            inner.child = Some(child);
            inner.running = true;
            inner.paused = false;
            inner.script = Some(script.to_string());
            inner.model = None;
            inner.last_script = Some(script.to_string());
            inner.last_model = None;
        }

        self.spawn_telemetry_reader(app_handle.clone());
        self.spawn_process_watcher(app_handle);

        Ok(())
    }

    /// Start JSBSim with an aircraft model
    pub fn start_model(&self, model: &str, app_handle: tauri::AppHandle) -> Result<(), String> {
        self.stop()?;

        let output_xml = self.create_output_xml();

        let child = Command::new(JSBSIM_BIN)
            .arg("--root=.")
            .arg(format!("--aircraft={}", model))
            .arg(format!("--logdirectivefile={}", output_xml.display()))
            .arg("--end=600")
            .current_dir(JSBSIM_ROOT)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start JSBSim: {}", e))?;

        {
            let mut inner = self.inner.lock().unwrap();
            inner.child = Some(child);
            inner.running = true;
            inner.paused = false;
            inner.model = Some(model.to_string());
            inner.script = None;
            inner.last_model = Some(model.to_string());
            inner.last_script = None;
        }

        self.spawn_telemetry_reader(app_handle.clone());
        self.spawn_process_watcher(app_handle);

        Ok(())
    }

    /// Pause the running JSBSim process (SIGSTOP).
    pub fn pause(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.running {
            return Err("仿真未运行".to_string());
        }
        if inner.paused {
            return Ok(());
        }
        if let Some(ref mut child) = inner.child {
            let pid = child.id() as i32;
            #[cfg(unix)]
            {
                let ret = unsafe { libc::kill(pid, libc::SIGSTOP) };
                if ret != 0 {
                    return Err(format!("无法暂停进程 (errno {})", ret));
                }
            }
            #[cfg(not(unix))]
            {
                let _ = pid;
                return Err("暂停功能仅支持 Unix 系统".to_string());
            }
            inner.paused = true;
            Ok(())
        } else {
            Err("仿真进程不存在".to_string())
        }
    }

    /// Resume a paused JSBSim process (SIGCONT).
    pub fn resume(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.running {
            return Err("仿真未运行".to_string());
        }
        if !inner.paused {
            return Ok(());
        }
        if let Some(ref mut child) = inner.child {
            let pid = child.id() as i32;
            #[cfg(unix)]
            {
                let ret = unsafe { libc::kill(pid, libc::SIGCONT) };
                if ret != 0 {
                    return Err(format!("无法恢复进程 (errno {})", ret));
                }
            }
            #[cfg(not(unix))]
            {
                let _ = pid;
                return Err("恢复功能仅支持 Unix 系统".to_string());
            }
            inner.paused = false;
            Ok(())
        } else {
            Err("仿真进程不存在".to_string())
        }
    }

    /// Restart the last run simulation (stop then start the previous target).
    pub fn restart(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        let (last_script, last_model) = {
            let inner = self.inner.lock().unwrap();
            (inner.last_script.clone(), inner.last_model.clone())
        };
        if let Some(ref s) = last_script {
            self.start_script(s, app_handle)
        } else if let Some(ref m) = last_model {
            self.start_model(m, app_handle)
        } else {
            Err("没有可重新运行的仿真".to_string())
        }
    }

    /// Stop the running JSBSim process
    pub fn stop(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.running = false;
        inner.paused = false;
        inner.script = None;
        inner.model = None;
        Ok(())
    }

    /// List available run scripts from jsbsim/scripts/
    pub fn list_tests() -> Result<Vec<Value>, String> {
        let scripts_dir = Path::new(JSBSIM_ROOT).join("scripts");
        Self::list_xml_files(&scripts_dir, "scripts")
    }

    /// List available aircraft models from jsbsim/aircraft/
    pub fn list_models() -> Result<Vec<Value>, String> {
        let aircraft_dir = Path::new(JSBSIM_ROOT).join("aircraft");
        if !aircraft_dir.exists() {
            return Ok(vec![]);
        }

        let mut models = vec![];
        let entries = std::fs::read_dir(&aircraft_dir)
            .map_err(|e| format!("Failed to read aircraft dir: {}", e))?;

        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let dir_name = entry.file_name().to_string_lossy().to_string();
                if let Ok(files) = std::fs::read_dir(entry.path()) {
                    for f in files.flatten() {
                        let fname = f.file_name().to_string_lossy().to_string();
                        if fname.ends_with(".xml") {
                            if let Ok(content) = std::fs::read_to_string(f.path()) {
                                if content.contains("<fdm_config") {
                                    models.push(json!({
                                        "name": dir_name,
                                        "file": fname,
                                        "path": format!("aircraft/{}/{}", dir_name, fname),
                                    }));
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        models.sort_by(|a, b| {
            a["name"].as_str().unwrap().cmp(b["name"].as_str().unwrap())
        });
        Ok(models)
    }

    // ── Private helpers ─────────────────────────────────────────────────

    fn list_xml_files(dir: &Path, prefix: &str) -> Result<Vec<Value>, String> {
        if !dir.exists() {
            return Ok(vec![]);
        }

        let mut files = vec![];
        let entries = std::fs::read_dir(dir)
            .map_err(|e| format!("Failed to read dir {}: {}", dir.display(), e))?;

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".xml") {
                let rel_path = format!("{}/{}", prefix, name);
                files.push(json!({
                    "name": name.trim_end_matches(".xml"),
                    "file": name,
                    "path": rel_path,
                }));
            }
        }

        files.sort_by(|a, b| {
            a["name"].as_str().unwrap().cmp(b["name"].as_str().unwrap())
        });
        Ok(files)
    }

    fn create_output_xml(&self) -> PathBuf {
        let xml_path = Path::new(JSBSIM_ROOT).join(".visual-editor-output.xml");
        let xml_content = format!(
            r#"<?xml version="1.0"?>
<output name="127.0.0.1" type="SOCKET" port="{}" protocol="UDP" rate="30">
  <property> position/h-sl-ft </property>
  <property> position/lat-gc-deg </property>
  <property> position/long-gc-deg </property>
  <property> attitude/phi-deg </property>
  <property> attitude/theta-deg </property>
  <property> attitude/psi-deg </property>
  <property> velocities/u-fps </property>
  <property> velocities/v-fps </property>
  <property> velocities/w-fps </property>
  <property> velocities/p-rad_sec </property>
  <property> velocities/q-rad_sec </property>
  <property> velocities/r-rad_sec </property>
  <property> accelerations/udot-ft_sec2 </property>
  <property> accelerations/vdot-ft_sec2 </property>
  <property> accelerations/wdot-ft_sec2 </property>
  <property> fcs/throttle-cmd-norm </property>
  <property> fcs/aileron-cmd-norm </property>
  <property> fcs/elevator-cmd-norm </property>
  <property> fcs/rudder-cmd-norm </property>
</output>"#,
            TELEMETRY_PORT
        );
        let _ = std::fs::write(&xml_path, xml_content);
        xml_path
    }

    /// Spawn a thread that reads UDP packets from JSBSim and emits telemetry events.
    ///
    /// JSBSim SOCKET/UDP output format (comma-separated):
    ///   Packet 1: `<LABELS> ,Time,prop1,prop2,...`
    ///   Packet N: `  sim_time,  val1,  val2,...`
    fn spawn_telemetry_reader(&self, app_handle: tauri::AppHandle) {
        let inner = Arc::clone(&self.inner);

        std::thread::Builder::new()
            .name("jsbsim-telemetry".into())
            .spawn(move || {
                let socket = match UdpSocket::bind(format!("127.0.0.1:{}", TELEMETRY_PORT)) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[jsbsim] Failed to bind UDP port {}: {}", TELEMETRY_PORT, e);
                        return;
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .ok();

                eprintln!("[jsbsim] UDP telemetry listener on port {}", TELEMETRY_PORT);

                let mut header: Option<Vec<String>> = None;
                let mut buf = [0u8; 8192];

                loop {
                    // Check running state
                    {
                        let state = inner.lock().unwrap();
                        if !state.running {
                            return;
                        }
                    }

                    match socket.recv_from(&mut buf) {
                        Ok((n, _addr)) => {
                            let text = match std::str::from_utf8(&buf[..n]) {
                                Ok(s) => s.trim().to_string(),
                                Err(_) => continue,
                            };

                            if text.is_empty() {
                                continue;
                            }

                            // Check for header line
                            if text.starts_with("<LABELS>") {
                                // Format: "<LABELS> ,Time,prop1,prop2,..."
                                // JSBSim replaces underscores with spaces in property names
                                let csv: Vec<String> = text
                                    .split(',')
                                    .map(|s| {
                                        s.trim()
                                            .trim_start_matches("<LABELS>")
                                            .trim()
                                            .replace(' ', "_")
                                    })
                                    .filter(|s| !s.is_empty())
                                    .collect();
                                header = Some(csv);
                                continue;
                            }

                            // Data line: comma-separated values
                            let parts: Vec<&str> = text.split(',').collect();
                            if parts.is_empty() {
                                continue;
                            }

                            // First value is sim time
                            let sim_time = match parts[0].trim().parse::<f64>() {
                                Ok(t) => t,
                                Err(_) => continue,
                            };

                            let mut telemetry = json!({ "t": sim_time });

                            // Use our predefined property names (full paths)
                            // JSBSim socket output strips path prefixes from headers
                            for (i, part) in parts.iter().skip(1).enumerate() {
                                let trimmed = part.trim();
                                if let Ok(val) = trimmed.parse::<f64>() {
                                    if let Some(&prop_name) = PROPERTY_NAMES.get(i) {
                                        telemetry[format!("/{}", prop_name)] = json!(val);
                                    }
                                }
                            }

                            let _ = app_handle.emit("telemetry", telemetry);
                        }
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut =>
                        {
                            continue;
                        }
                        Err(e) => {
                            eprintln!("[jsbsim] UDP recv error: {}", e);
                            break;
                        }
                    }
                }
            })
            .expect("spawn telemetry reader");
    }

    /// Monitor the child process exit and emit status events.
    fn spawn_process_watcher(&self, app_handle: tauri::AppHandle) {
        let inner = Arc::clone(&self.inner);

        std::thread::Builder::new()
            .name("jsbsim-watcher".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                let mut state = inner.lock().unwrap();
                if !state.running {
                    return;
                }
                if let Some(ref mut child) = state.child {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            eprintln!("[jsbsim] Process exited: {}", status);
                            state.running = false;
                            let _ = app_handle.emit(
                                "sim-process-status",
                                json!({ "running": false, "exitCode": status.code() }),
                            );
                            return;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            eprintln!("[jsbsim] Wait error: {}", e);
                            state.running = false;
                            return;
                        }
                    }
                } else {
                    return;
                }
            })
            .expect("spawn process watcher");
    }
}
