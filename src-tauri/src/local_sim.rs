//! Own the PC runtime and its file services for the lifetime of the desktop.
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, fs, io::{BufRead, BufReader, Read}, net::{Ipv4Addr, TcpListener, UdpSocket}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::Manager;

pub use crate::sim_backend::{CONTROL_PORT, FTP_PORT, NSH_PORT};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    #[serde(default)]
    pub bundled: bool,
    pub project_directory: String,
    pub build_directory: String,
    pub hil_host: String,
    pub hil_port: u16,
}
impl Default for Config {
    fn default() -> Self {
        let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../jsbsim_realtime");
        let project = project.canonicalize().unwrap_or(project);
        Self { enabled: false, bundled: true, project_directory: project.to_string_lossy().into(), build_directory: project.join("build/x86_64").to_string_lossy().into(), hil_host: "127.0.0.1".into(), hil_port: 14561 }
    }
}

impl Config {
    fn validate(&self) -> Result<(), String> {
        if !self.enabled { return Ok(()); }
        if !cfg!(all(target_os = "linux", target_arch = "x86_64")) { return Err("电脑端模型目前支持 x86-64 Linux".into()); }
        if self.bundled { return Ok(()); }
        if self.hil_host.parse::<Ipv4Addr>().is_err() || self.hil_port == 0 { return Err("HIL 目标需要有效 IPv4 和非零端口".into()); }
        if self.hil_host == "127.0.0.1" && [14560, 5801, 5803, CONTROL_PORT].contains(&self.hil_port) { return Err("同机 HIL 接收端口与模型/上位机端口冲突，建议使用 14561".into()); }
        for (root, relative) in [(&self.project_directory, "boards/pc/x86_64/services/supervisor.py"), (&self.project_directory, "data/aviation/aircraft"), (&self.build_directory, "bin/jsbsim_realtime")] {
            if !Path::new(root).is_absolute() || !Path::new(root).join(relative).exists() { return Err(format!("找不到 {root}/{relative}；请先编译 boards/pc/x86_64/pc.sh build，并填写绝对路径")); }
        }
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let binary = Path::new(&self.build_directory).join("bin/jsbsim_realtime");
            if fs::metadata(binary).map_err(|e| e.to_string())?.permissions().mode() & 0o111 == 0 { return Err("本机仿真程序没有执行权限".into()); }
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    config: Config, active_config: Option<Config>, active: bool, restart_required: bool, running: bool, ready: bool,
    pid: Option<u32>, exit_code: Option<i32>, error: Option<String>, logs: Vec<String>,
    builtin: Option<crate::builtin_sim::Status>, px4_running: Option<bool>,
}
#[derive(Default)]
struct Process { child: Option<Child>, exit_code: Option<i32>, error: Option<String>, files_ready: bool, native_ready: bool, logs: VecDeque<String> }
static ACTIVE: OnceLock<Config> = OnceLock::new();
static REQUESTED: OnceLock<Config> = OnceLock::new();
static BUNDLED: OnceLock<crate::builtin_sim::Prepared> = OnceLock::new();
static PROCESS: OnceLock<Arc<Mutex<Process>>> = OnceLock::new();
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
fn process() -> &'static Arc<Mutex<Process>> { PROCESS.get_or_init(|| Arc::new(Mutex::new(Process::default()))) }
pub fn active() -> bool { crate::sim_backend::active() }
/// Read-only identity for joint tests; never exposes package paths or credentials.
pub fn mcp_status() -> serde_json::Value {
    match snapshot(REQUESTED.get().cloned().unwrap_or_default()) {
        Ok(s) => {
            let px4 = crate::px4_sitl::global().status();
            let matched = px4.as_ref().ok().is_some_and(|px4| s.active_config.as_ref()
                .is_some_and(|config| px4.matches_local_hil(&config.hil_host, config.hil_port)));
            serde_json::json!({"active":s.active,"bundled":BUNDLED.get().is_some(),"ready":s.ready,
                "serviceRunning":s.running,"px4Running":px4.as_ref().ok().map(|p|p.running),
                "localPx4Matched":matched,"error":s.error})
        },
        Err(error) => serde_json::json!({"active":active(),"bundled":false,"ready":false,"error":error}),
    }
}


fn read_config(path: &Path) -> Result<Config, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("电脑端仿真配置读取失败：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(e.to_string()),
    }
}
fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> { Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("local-simulator.json")) }
fn write_config(path: &Path, config: &Config) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().map_err(|e| e.to_string())?;
    config.validate()?;
    fs::create_dir_all(path.parent().ok_or("无效配置路径")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn command(config: &Config) -> Result<Command, String> {
    // Use the existing standard-library service directly: no low-port helper,
    // shell interpretation, second editor window, or build on application startup.
    let bundle = if config.bundled { Some(BUNDLED.get().ok_or("内置仿真组件尚未准备")?) } else { None };
    let mut command = Command::new(bundle.map(|b| b.python.as_os_str()).unwrap_or(std::ffi::OsStr::new("python3")));
    if let Some(b) = bundle {
        command.arg("-S").env("PYTHONHOME", &b.python_home).env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1").env_remove("PYTHONPATH")
            .env("LD_LIBRARY_PATH", &b.libraries);
    }
    let binary = bundle.map(|b| b.native.clone()).unwrap_or_else(|| Path::new(&config.build_directory).join("bin/jsbsim_realtime"));
    command.arg("-u").arg(Path::new(&config.project_directory).join("boards/pc/x86_64/services/supervisor.py"))
        .arg("--managed").arg("--binary").arg(binary)
        .arg("--source").arg(Path::new(&config.project_directory).join("data/aviation"))
        .arg("--build").arg(&config.build_directory).arg("--")
        .args(["--bind", "127.0.0.1", "--hil-host", &config.hil_host, "--hil-port", &config.hil_port.to_string()])
        .env("JSBSIM_PC_SERVICE_BIND", "127.0.0.1").env("JSBSIM_PC_FTP_PORT", FTP_PORT.to_string())
        .env("JSBSIM_PC_NSH_PORT", NSH_PORT.to_string()).env("JSBSIM_PC_CONTROL_PORT", CONTROL_PORT.to_string())
        .env("JSBSIM_PC_TELEMETRY_PORT", "5801").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(b) = bundle { command.args(["--script", &b.script, "--model", &b.model]); }
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    Ok(command)
}
fn read_output(reader: impl Read + Send + 'static, stream: &'static str) {
    let shared = Arc::clone(process());
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let mut p = shared.lock().unwrap_or_else(|e| e.into_inner());
            if stream == "stdout" {
                p.files_ready |= line.starts_with("[PC files] FTP ");
                p.native_ready |= line.starts_with("[PC] ready: upper-computer UDP ");
            }
            p.logs.push_back(format!("[{stream}] {}", line.chars().take(4096).collect::<String>()));
            while p.logs.len() > 200 { p.logs.pop_front(); }
        }
    });
}
fn start(config: &Config) -> Result<(), String> {
    config.validate()?;
    // Fail clearly before starting anything. Actual binds still handle races.
    let _udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, CONTROL_PORT)).map_err(|e| format!("本机仿真 UDP {CONTROL_PORT} 不可用：{e}"))?;
    let _ftp = TcpListener::bind((Ipv4Addr::LOCALHOST, FTP_PORT)).map_err(|e| format!("本机模型服务 TCP {FTP_PORT} 不可用：{e}"))?;
    let _nsh = TcpListener::bind((Ipv4Addr::LOCALHOST, NSH_PORT)).map_err(|e| format!("本机文件服务 TCP {NSH_PORT} 不可用：{e}"))?;
    drop((_udp, _ftp, _nsh));
    spawn(config)
}
fn spawn(config: &Config) -> Result<(), String> {
    let mut child = command(config)?.spawn().map_err(|e| format!("无法启动电脑端仿真：{e}"))?;
    if let Some(reader) = child.stdout.take() { read_output(reader, "stdout"); }
    if let Some(reader) = child.stderr.take() { read_output(reader, "stderr"); }
    process().lock().map_err(|e| e.to_string())?.child = Some(child);
    Ok(())
}
pub fn initialize(app: &tauri::AppHandle) {
    let config = config_path(app).and_then(|p| read_config(&p));
    match config {
        Ok(config) => {
            crate::sim_backend::initialize(config.enabled);
            let _ = REQUESTED.set(config.clone());
            let mut effective = config.clone();
            let launch = (|| {
                if config.enabled && config.bundled {
                    let resource = app.path().resource_dir().map_err(|e|e.to_string())?;
                    let data = app.path().app_data_dir().map_err(|e|e.to_string())?;
                    let prepared = crate::builtin_sim::prepare(&crate::builtin_sim::locate(&resource), &data)?;
                    effective.project_directory = prepared.project.to_string_lossy().into();
                    effective.build_directory = prepared.work.to_string_lossy().into();
                    effective.hil_host = "127.0.0.1".into(); effective.hil_port = 14561;
                    BUNDLED.set(prepared).map_err(|_|"内置仿真已经初始化".to_string())?;
                }
                let _ = ACTIVE.set(effective.clone());
                if config.enabled {
                    start(&effective)?;
                    if let Some(b) = BUNDLED.get() {
                        let data=app.path().app_data_dir().map_err(|e|e.to_string())?;
                        if let Err(error) = crate::px4_sitl::start_builtin(&b.px4, &data.join("px4-sitl"), &b.libraries) {
                            shutdown(); return Err(format!("内置软件飞控启动失败：{error}"));
                        }
                    }
                }
                Ok::<_,String>(())
            })();
            if let Err(error)=launch { process().lock().unwrap_or_else(|e|e.into_inner()).error=Some(error); }
        }
        Err(error) => { process().lock().unwrap_or_else(|e| e.into_inner()).error = Some(error); }
    }
}
fn snapshot(config: Config) -> Result<Snapshot, String> {
    let mut p = process().lock().map_err(|e| e.to_string())?;
    if let Some(child) = &mut p.child {
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
            p.exit_code = exit.code(); p.child = None;
            if BUNDLED.get().is_some() { let _=crate::px4_sitl::global().stop(); }
            p.error = Some(format!("电脑端仿真服务已退出（{exit}），请查看运行日志"));
        }
    }
    let px4_running = if BUNDLED.get().is_some() { Some(crate::px4_sitl::global().status()?.running) } else { None };
    if p.child.is_some() && px4_running == Some(false) && p.error.is_none() {
        p.error = Some("内置软件飞控已停止，请查看软件飞控运行日志或重启上位机".into());
    }
    Ok(Snapshot { active_config: ACTIVE.get().filter(|c| c.enabled).cloned(), restart_required: REQUESTED.get().is_some_and(|c| c != &config), config, active: active(), running: p.child.is_some(), ready: p.child.is_some() && p.files_ready && p.native_ready && px4_running != Some(false),
        pid: p.child.as_ref().map(Child::id), exit_code: p.exit_code, error: p.error.clone(), logs: p.logs.iter().cloned().collect(), builtin: None, px4_running })
}
pub fn shutdown() {
    if BUNDLED.get().is_some() { let _=crate::px4_sitl::global().stop(); }
    let Some(mut child) = process().lock().unwrap_or_else(|e| e.into_inner()).child.take() else { return };
    #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
    #[cfg(not(unix))] { let _ = child.kill(); }
    let deadline = Instant::now() + Duration::from_secs(35);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() { return; }
        std::thread::sleep(Duration::from_millis(50));
    }
    #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill(); let _ = child.wait();
}

#[tauri::command]
pub async fn local_sim_get(app: tauri::AppHandle) -> Result<Snapshot, String> {
    super::run_blocking(move || {
        let mut state=snapshot(read_config(&config_path(&app)?)?)?;
        state.builtin=Some(crate::builtin_sim::status(&crate::builtin_sim::locate(&app.path().resource_dir().map_err(|e|e.to_string())?)));
        Ok(state)
    }).await
}
#[tauri::command]
pub async fn local_sim_save(app: tauri::AppHandle, config: Config) -> Result<Snapshot, String> {
    super::run_blocking(move || {
        let builtin=crate::builtin_sim::status(&crate::builtin_sim::locate(&app.path().resource_dir().map_err(|e|e.to_string())?));
        if config.enabled && config.bundled && !builtin.available { return Err(builtin.error.unwrap_or("内置仿真不可用".into())); }
        write_config(&config_path(&app)?, &config)?;
        let mut state=snapshot(config)?;state.builtin=Some(builtin);Ok(state)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_defaults_and_disabled_paths() {
        let c = Config::default(); assert!(!c.enabled); assert_eq!(c.hil_port, 14561); assert!(c.validate().is_ok());
        let mut invalid = c; invalid.enabled = true; invalid.bundled = false; invalid.hil_host = "127.0.0.1;touch /tmp/invalid".into(); assert!(invalid.validate().is_err());
    }
    #[test]
    fn saves_atomically_and_rejects_invalid_enabled_settings() {
        let dir = std::env::temp_dir().join(format!("local-sim-settings-{}", std::process::id()));
        let path = dir.join("settings.json"); let config = Config::default();
        assert_eq!(read_config(&path).unwrap(), config);
        write_config(&path, &config).unwrap(); assert_eq!(read_config(&path).unwrap(), config);
        let mut invalid = config.clone(); invalid.enabled = true; invalid.bundled = false; invalid.build_directory = "/missing/local-sim".into();
        assert!(write_config(&path, &invalid).is_err()); assert_eq!(read_config(&path).unwrap(), config);
        fs::write(&path, b"{").unwrap(); assert!(read_config(&path).is_err()); fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn launch_is_waiting_for_model_and_uses_unprivileged_loopback_services() {
        let mut config = Config::default(); config.bundled = false; let cmd = command(&config).unwrap();
        let args: Vec<_> = cmd.get_args().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(args.contains(&"--managed".into())); assert!(!args.contains(&"--model".into())); assert!(!args.contains(&"--script".into()));
        assert!(cmd.get_envs().any(|(k,v)| k == "JSBSIM_PC_FTP_PORT" && v == Some(std::ffi::OsStr::new("2121"))));
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn owns_service_process_and_cleans_descendants_without_network() {
        let dir = std::env::temp_dir().join(format!("local-sim-process-{}", std::process::id()));
        let services = dir.join("boards/pc/x86_64/services"); fs::create_dir_all(&services).unwrap();
        fs::write(services.join("supervisor.py"), r#"import os, signal, subprocess, sys
child = subprocess.Popen(['sleep', '120'])
def stop(signum, frame):
    child.terminate()
signal.signal(signal.SIGTERM, stop)
print('[PC files] FTP ready', flush=True)
print('[PC] ready: upper-computer UDP ready', flush=True)
print('descendant=' + str(child.pid), flush=True)
child.wait()
"#).unwrap();
        let mut config = Config::default(); config.bundled = false; config.project_directory = dir.to_string_lossy().into();
        spawn(&config).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let descendant = loop {
            let state = snapshot(config.clone()).unwrap();
            if state.ready {
                if let Some(pid) = state.logs.iter().find_map(|l| l.strip_prefix("[stdout] descendant=").and_then(|s| s.parse::<i32>().ok())) { break pid; }
            }
            assert!(Instant::now() < deadline, "{:?}", state.logs); std::thread::sleep(Duration::from_millis(10));
        };
        shutdown(); assert!(!snapshot(config).unwrap().running);
        assert!(!Path::new(&format!("/proc/{descendant}")).exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn legacy_configuration_stays_custom_and_builtin_keeps_custom_values() {
        let legacy = r#"{"enabled":true,"projectDirectory":"/custom/source","buildDirectory":"/custom/build","hilHost":"192.168.3.123","hilPort":15561}"#;
        let mut config:Config=serde_json::from_str(legacy).unwrap();
        assert!(!config.bundled,"legacy settings must retain custom behavior");
        let dirs=(config.project_directory.clone(),config.build_directory.clone(),config.hil_host.clone(),config.hil_port);
        config.bundled=true;
        assert!(config.validate().is_ok(),"bundled preset does not need the old custom directories");
        let encoded=serde_json::to_vec(&config).unwrap();
        let restored:Config=serde_json::from_slice(&encoded).unwrap();
        assert_eq!((restored.project_directory,restored.build_directory,restored.hil_host,restored.hil_port),dirs);
        config.bundled=false;assert!(config.validate().is_err(),"custom mode must validate its own paths");
        assert!(Config::default().bundled,"new configurations offer the built-in preset");
    }

}
