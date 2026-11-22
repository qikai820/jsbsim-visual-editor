//! Headless entry point for the desktop's production flight-test engine.
#![allow(dead_code)]
#[path = "../../../src-tauri/src/flight_test/mod.rs"]
mod flight_test;
mod pcap;
#[path = "../../../src-tauri/src/scene_telemetry.rs"]
mod scene_telemetry;
#[path = "../../../src-tauri/src/serial_assistant.rs"]
mod serial_assistant;
#[path = "../../../src-tauri/src/tool_transport.rs"]
mod tool_transport;

use flight_test::mavlink::{Parser, Telemetry};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

// The CLI supplies an explicit simulator host instead of desktop discovery.
static SIMULATOR: OnceLock<Ipv4Addr> = OnceLock::new();
mod transport {
    pub fn network_host() -> Option<std::net::Ipv4Addr> {
        super::SIMULATOR.get().copied()
    }
}
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug)]
struct Args {
    source: PathBuf,
    output: PathBuf,
    host: Ipv4Addr,
    interface: String,
    port: u16,
    instance: u8,
    run: bool,
    on_finish: String,
    on_abort: String,
}
fn arguments() -> Result<Option<Args>, String> {
    let mut values = std::env::args().skip(1);
    let mut fields = std::collections::BTreeMap::new();
    let mut run = false;
    while let Some(key) = values.next() {
        if key == "--help" {
            println!("px4-flight-test-cli --source SCRIPT.xml --output DIRECTORY --sim-host IPv4 --capture-interface INTERFACE [--local-port 14553] [--instance 1] [--on-finish land|hold|release] [--on-abort hold|land|release] [--run]\nWithout --run: validate XML and inspect the real link/model only. --run executes the complete source. Ctrl+C or creating DIRECTORY/STOP requests the script's abort policy.");
            return Ok(None);
        }
        if key == "--run" {
            if run {
                return Err("重复 --run".into());
            }
            run = true;
            continue;
        }
        if ![
            "--source",
            "--output",
            "--sim-host",
            "--capture-interface",
            "--local-port",
            "--instance",
            "--on-finish",
            "--on-abort",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("未知选项 {key}"));
        }
        let value = values
            .next()
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| format!("{key} 缺少值"))?;
        if fields.insert(key.clone(), value).is_some() {
            return Err(format!("重复选项 {key}"));
        }
    }
    let required = |key: &str| {
        fields
            .get(key)
            .cloned()
            .ok_or_else(|| format!("缺少 {key}；运行 --help 查看用法"))
    };
    let host: Ipv4Addr = required("--sim-host")?
        .parse()
        .map_err(|_| "无效仿真机 IPv4")?;
    if host.is_unspecified() || host.is_broadcast() || host.is_multicast() || host.is_loopback() {
        return Err("需要仿真机实际单播 IPv4".into());
    }
    let interface = required("--capture-interface")?;
    if interface.is_empty()
        || !interface
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c))
    {
        return Err("无效抓取网口".into());
    }
    let port = fields
        .get("--local-port")
        .map(String::as_str)
        .unwrap_or("14553")
        .parse::<u16>()
        .map_err(|_| "无效转发端口")?;
    let instance = fields
        .get("--instance")
        .map(String::as_str)
        .unwrap_or("1")
        .parse::<u8>()
        .map_err(|_| "无效仿真实例")?;
    if port == 0 || !(1..=32).contains(&instance) {
        return Err("转发端口或实例越界".into());
    }
    let on_finish=fields.get("--on-finish").cloned().unwrap_or_else(||"land".into());
    let on_abort=fields.get("--on-abort").cloned().unwrap_or_else(||"hold".into());
    if ![&on_finish,&on_abort].iter().all(|value|["hold","land","release"].contains(&value.as_str())) {return Err("退出策略只能是 hold / land / release".into());}
    Ok(Some(Args {
        source: required("--source")?.into(),
        output: required("--output")?.into(),
        host,
        interface,
        port,
        instance,
        run,
        on_finish,
        on_abort,
    }))
}

// When the desktop is closed, keep the existing visual destination alive and
// drain its UDP socket. The production pcap decoder remains the sole ingester.
// Never compete with a desktop listener that already owns port 5801.
struct VisualHeartbeat { stop: Arc<AtomicBool>, worker: Option<std::thread::JoinHandle<()>> }
impl VisualHeartbeat {
    fn start(host: Ipv4Addr) -> Result<Option<Self>, String> {
        let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 5801)) {
            Ok(socket) => socket,
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                println!("VISUAL using existing desktop telemetry listener on UDP 5801");
                return Ok(None);
            }
            Err(error) => return Err(format!("无法接收现有视觉遥测：{error}")),
        };
        socket.set_read_timeout(Some(Duration::from_millis(100))).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false)); let done = stop.clone();
        let worker = std::thread::spawn(move || {
            let mut last = Instant::now() - Duration::from_secs(2); let mut data = [0u8; 65536];
            while !done.load(Ordering::Acquire) {
                if last.elapsed() >= Duration::from_secs(1) {
                    let _ = socket.send_to(b"VCMD\x07", (host, 5802)); last = Instant::now();
                }
                let _ = socket.recv_from(&mut data);
            }
        });
        println!("VISUAL headless telemetry heartbeat enabled on UDP 5801");
        Ok(Some(Self { stop, worker: Some(worker) }))
    }
}
impl Drop for VisualHeartbeat {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

struct Capture {
    child: Child,
    error: Arc<Mutex<Option<String>>>,
}
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn capture(args: &Args) -> Result<Capture, String> {
    let output = File::create(args.output.join("scene.pcap")).map_err(|e| e.to_string())?;
    let stderr = File::create(args.output.join("capture.log")).map_err(|e| e.to_string())?;
    let mut child = Command::new("dumpcap")
        .args([
            "-q",
            "-P",
            "-i",
            &args.interface,
            "-f",
            &format!("src host {} and udp dst port 5801", args.host),
            "-w",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .spawn()
        .map_err(|e| format!("无法启动只读遥测抓取：{e}"))?;
    let pipe = child.stdout.take().ok_or("抓取进程没有 stdout")?;
    let error = Arc::new(Mutex::new(None));
    let result = error.clone();
    let host = args.host;
    std::thread::spawn(move || {
        if let Err(e) =
            pcap::copy_stream(pipe, output, host, |value| scene_telemetry::ingest(&value))
        {
            if let Ok(mut v) = result.lock() {
                *v = Some(e);
            }
        }
    });
    Ok(Capture { child, error })
}
fn save(path: &Path, value: &Value) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|e| e.to_string())?;
    file.write_all(b"\n")
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}
#[derive(Default)]
struct Link {
    parser: Parser,
    telemetry: Telemetry,
    peer: Option<SocketAddr>,
}

async fn execute(args: &Args, source: &str) -> Result<Value, String> {
    let parsed = flight_test::xml::parse(source)?;
    println!(
        "SCRIPT {} events={} duration={}s execute={}",
        parsed.name,
        parsed.events.len(),
        parsed.end,
        args.run
    );
    SIMULATOR.set(args.host).map_err(|_| "仿真机地址已设置")?;
    let scene_capture = capture(args)?;
    let _visual = VisualHeartbeat::start(args.host)?;
    let link = Arc::new(Mutex::new(Link::default()));
    let observed = link.clone();
    let expected = args.host;
    let events = tauri::ipc::Channel::<serial_assistant::SerialEvent>::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            if let Ok(serial_assistant::SerialEvent::Data {
                direction,
                bytes,
                meta,
                ..
            }) = serde_json::from_str(&text)
            {
                if direction == "rx" {
                    if let Some(peer) = meta
                        .peer
                        .and_then(|v| v.parse::<SocketAddr>().ok())
                        .filter(|p| p.ip() == std::net::IpAddr::V4(expected))
                    {
                        if let Ok(mut current) = observed.lock() {
                            if current.peer.is_none_or(|p| p == peer) {
                                for frame in current.parser.push(&bytes, meta.datagram) {
                                    if frame.id == 0
                                        && frame.component == 1
                                        && frame.payload.get(5) == Some(&12)
                                        && !frame.signed
                                    {
                                        current.peer = Some(peer);
                                    }
                                    current.telemetry.ingest(&frame, Instant::now());
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    });
    // Exclusively bind the configured toolbox route. No SO_REUSEPORT, new
    // forwarder, USB reader, persistent route changes or synthetic feedback.
    let info = tool_transport::tool_transport_open(
        tool_transport::Owner::Px4,
        None,
        Some(serial_assistant::NetworkConfig {
            mode: serial_assistant::NetworkMode::Udp,
            host: String::new(),
            port: args.port,
            local_host: "0.0.0.0".into(),
            local_port: args.port,
        }),
        events,
    )
    .await?;
    let operation = async {
        let began = Instant::now();
        let (peer, target) = loop {
            if let Some(error) = scene_capture.error.lock().map_err(|e| e.to_string())?.clone() { return Err(format!("读取真实模型遥测失败：{error}；见 capture.log")); }
            let candidate = { let l = link.lock().map_err(|e| e.to_string())?; if l.telemetry.fresh(Instant::now()) { l.peer.zip(l.telemetry.target) } else { None } };
            if let Some(candidate) = candidate { break candidate; }
            if began.elapsed() > Duration::from_secs(10) { return Err("等待现有工具箱转发通道的 PX4 心跳超时".into()); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        tool_transport::tool_transport_pin_peer(tool_transport::Owner::Px4, info.session_id, peer.to_string()).await?;
        println!("LINK local=0.0.0.0:{} peer={} SYS={} COMP={}", args.port, peer, target.0, target.1);
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            if scene_telemetry::snapshots().iter().any(|f| f["instance_id"].as_str().and_then(|v| v.parse::<u8>().ok()) == Some(args.instance) && f["age_ms"].as_u64().unwrap_or(u64::MAX) < 1500 && f["state"].as_str() == Some("running")) { break; }
            if Instant::now() > until { return Err("没有当前模型的完整新鲜遥测；仿真可能已停止，请启动当前模型后重试".into()); }
            if let Some(error) = scene_capture.error.lock().map_err(|e| e.to_string())?.clone() { return Err(format!("真实模型遥测读取中断：{error}")); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !args.run {
            let l = link.lock().map_err(|e| e.to_string())?;
            return Ok(json!({"format":"px4-jsbsim-flight-test-cli-inspection","executed":false,"sourceXml":source,"scene":scene_telemetry::snapshots(),"peer":peer.to_string(),"target":target,"hil":l.telemetry.hil,"armed":l.telemetry.armed,"flightController":l.telemetry.values(Instant::now())}));
        }
        let options = flight_test::Options { dry_run: false, rc_emulation: true, session_id: Some(info.session_id), system: target.0, component: target.1, instance: args.instance, rate_hz: 50, clock: "realtime".into(), on_finish: args.on_finish.clone(), on_abort: args.on_abort.clone() };
        flight_test::start(source.to_owned(), options)?;
        let mut log_index = 0; let mut last_saved = Instant::now() - Duration::from_secs(10); let mut last_printed = last_saved; let mut cancel = false;
        let mut log_file = OpenOptions::new().create(true).append(true).open(args.output.join("events.jsonl")).map_err(|e| e.to_string())?;
        loop {
            let state = flight_test::status();
            for log in state.logs.iter().skip(log_index) { println!("{:.3} [{}] {}", log.time, log.level, log.message); serde_json::to_writer(&mut log_file, log).map_err(|e| e.to_string())?; writeln!(log_file).map_err(|e| e.to_string())?; }
            log_index = state.logs.len();
            if last_saved.elapsed() >= Duration::from_millis(250) || !flight_test::running() {
                save(&args.output.join("status.json"), &serde_json::to_value(&state).map_err(|e| e.to_string())?)?;
                log_file.flush().map_err(|e| e.to_string())?; last_saved = Instant::now();
            }
            if last_printed.elapsed() >= Duration::from_secs(5) || !flight_test::running() {
                println!("STATUS {} t={:.1}s throttle={:.1}% h={:?} angle_error={:?} active={:?}", state.status, state.elapsed, state.rc[3] * 100., state.values.get("test/fc/relative-alt-m"), state.values.get("test/attitude/error-deg"), state.active_blocks);
                last_printed = Instant::now();
            }
            if !flight_test::running() { break; }
            if args.output.join("STOP").exists() || scene_capture.error.lock().map_err(|e| e.to_string())?.is_some() { cancel = true; }
            if cancel { run_blocking(|| flight_test::stop(None)).await?; continue; }
            tokio::select! { _ = tokio::time::sleep(Duration::from_millis(250)) => {}, result = tokio::signal::ctrl_c() => { result.map_err(|e| e.to_string())?; cancel = true; } }
        }
        flight_test::flight_test_report()
    }.await;
    // Keep transport and real telemetry alive while the engine confirms its
    // exit policy, including on file-I/O or CLI errors.
    let cleanup =
        tool_transport::tool_transport_close(tool_transport::Owner::Px4, info.session_id).await;
    match operation {
        Ok(mut report) => {
            if let Err(e) = cleanup {
                report["cliCleanupError"] = json!(e);
            }
            Ok(report)
        }
        Err(e) => {
            let final_state = flight_test::status();
            save(
                &args.output.join("status.json"),
                &serde_json::to_value(final_state).map_err(|v| v.to_string())?,
            )?;
            Err(e)
        }
    }
}

#[tokio::main]
async fn main() {
    let args = match arguments() {
        Ok(Some(v)) => v,
        Ok(None) => return,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = fs::create_dir_all(&args.output)
        .and_then(|_| File::create_new(args.output.join("run.lock")).map(|_| ()))
    {
        eprintln!("结果目录不可用或已用于其他运行：{e}");
        std::process::exit(2);
    }
    let source = match fs::read_to_string(&args.source) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("读取脚本失败：{e}");
            std::process::exit(2);
        }
    };
    let mut report = match execute(&args, &source).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("FAILED {e}");
            let mut report = if flight_test::status().id != 0 {
                flight_test::flight_test_report()
                    .unwrap_or_else(|_| json!({"sourceXml":source,"result":flight_test::status()}))
            } else {
                json!({"format":"px4-jsbsim-flight-test-cli-startup-error","executed":false,"sourceXml":source,"result":flight_test::status()})
            };
            report["error"] = json!(e);
            report["scene"] = json!(scene_telemetry::snapshots());
            report
        }
    };
    report["cli"] = json!({"sourcePath":args.source,"simulator":args.host.to_string(),"localPort":args.port,"instance":args.instance,"captureInterface":args.interface,"readOnlyVisualCopy":true,"runRequested":args.run});
    let failed = report.get("error").is_some()
        || report["result"]["status"]
            .as_str()
            .is_some_and(|s| s != "passed");
    if let Err(e) = save(&args.output.join("report.json"), &report) {
        eprintln!("保存最终结果失败：{e}");
        std::process::exit(2);
    }
    println!("REPORT {}", args.output.join("report.json").display());
    if failed {
        std::process::exit(1);
    }
}
