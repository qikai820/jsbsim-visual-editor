mod altitude;
mod attitude;
mod heading;
mod manual;
pub mod receiver;
pub mod channels;
pub mod engine;
mod xcd20;
#[cfg(test)]
mod xcd20_test;
pub mod mavlink;
pub mod xml;

use crate::serial_assistant::SerialEvent;
use engine::{Command, Engine};
use mavlink::{Parser, Telemetry};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static RUNNING: AtomicBool = AtomicBool::new(false);
static LIVE_RUNNING: AtomicBool = AtomicBool::new(false);
pub fn running() -> bool {
    RUNNING.load(Ordering::Acquire)
}
pub fn live_running() -> bool { LIVE_RUNNING.load(Ordering::Acquire) }
#[derive(Default)]
struct Link {
    session: u64,
    bound_at: Option<Instant>,
    expected_host: Option<std::net::IpAddr>,
    peer: Option<SocketAddr>,
    forwarded: bool,
    connected: bool,
    parser: Parser,
    telemetry: Telemetry,
}
impl Link {
    fn stale_session(&self, now: Instant) -> Option<u64> {
        let last = self.telemetry.heartbeat.or(self.bound_at)?;
        (self.session != 0 && self.forwarded
            && (!self.connected || now.saturating_duration_since(last) >= Duration::from_secs(5)))
            .then_some(self.session)
    }
}
fn link() -> &'static Mutex<Link> {
    static VALUE: OnceLock<Mutex<Link>> = OnceLock::new();
    VALUE.get_or_init(|| Mutex::new(Link::default()))
}
pub fn bind_session(session: u64, host: Option<std::net::IpAddr>, forwarded: bool) {
    receiver::clear_idle();
    if let Ok(mut s) = link().lock() {
        *s = Link {
            session,
            bound_at: Some(Instant::now()),
            expected_host: host,
            forwarded,
            connected: true,
            ..Link::default()
        };
    }
}
/// Called with the source-operation gate held. A new UI may reclaim an
/// abandoned receive session, but never a fresh connection or an active run.
pub fn stale_session() -> Option<u64> {
    if running() || receiver::busy() { return None; }
    link().lock().ok()?.stale_session(Instant::now())
}
pub fn pin(session: u64, address: SocketAddr) {
    if let Ok(mut s) = link().lock() {
        if s.session == session {
            s.peer = Some(address);
        }
    }
}
pub fn guard_pin(session: u64, address: SocketAddr) -> Result<(), String> {
    if running() || receiver::busy() || receiver::idle_active() {
        let s = link().lock().map_err(|e| e.to_string())?;
        if s.session != session || s.peer != Some(address) {
            return Err("测试、遥控器切换或模拟待机期间不能改变转发目标".into());
        }
    }
    Ok(())
}
pub fn observe(event: &SerialEvent) {
    let Ok(mut s) = link().lock() else {
        return;
    };
    match event {
        SerialEvent::Status {
            session_id,
            connected,
            ..
        } if *session_id == s.session => s.connected = *connected,
        SerialEvent::Data {
            session_id,
            direction,
            bytes,
            meta,
            ..
        } if *session_id == s.session && direction == "rx" => {
            let incoming = meta
                .peer
                .as_deref()
                .and_then(|p| p.parse::<SocketAddr>().ok());
            if let Some(peer) = s.peer {
                if incoming != Some(peer) {
                    return;
                }
            } else if incoming.map(|p| p.ip()) != s.expected_host || s.expected_host.is_none() {
                return;
            }
            let frames = s.parser.push(bytes, meta.datagram);
            for frame in frames {
                s.telemetry.ingest(&frame, Instant::now());
            }
        }
        _ => {}
    }
}
pub fn guard_write(bytes: &[u8]) -> Result<(), String> {
    if crate::px4_firmware::busy() {
        let frames = Parser::default().push(bytes, true);
        if frames.len() == 1 && frames[0].id == 0 { return Ok(()); }
        return Err("PX4 固件升级进行中，其他飞控指令暂不可用".into());
    }
    if !running() && !receiver::busy() {
        return Ok(());
    }
    let frames = Parser::default().push(bytes, true);
    if frames.len() == 1
        && (frames[0].id == 0
            || frames[0].id == 20
            || (frames[0].id == 76
                && u16::from_le_bytes(frames[0].payload[28..30].try_into().unwrap()) == 512))
    {
        Ok(())
    } else {
        Err("仿真测试或遥控器来源切换进行中，此通道的参数写入、终端和其他控制指令暂不可用".into())
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub dry_run: bool,
    #[serde(default = "receiver_default")]
    pub rc_emulation: bool,
    pub session_id: Option<u64>,
    pub system: u8,
    pub component: u8,
    pub instance: u8,
    pub rate_hz: u16,
    pub clock: String,
    pub on_finish: String,
    pub on_abort: String,
}
fn receiver_default() -> bool { false }
impl Options {
    fn validate(&self) -> Result<(), String> {
        if !(1..=32).contains(&self.instance)
            || !(20..=100).contains(&self.rate_hz)
            || !matches!(self.clock.as_str(), "realtime" | "simulation")
            || ![self.on_finish.as_str(), self.on_abort.as_str()]
                .iter()
                .all(|v| matches!(*v, "hold" | "land" | "release"))
        {
            return Err("测试实例、频率、时钟或退出策略无效".into());
        }
        if !self.dry_run && (self.session_id.is_none() || self.system == 0 || self.component != 1) {
            return Err("请先识别仿真机转发的 PX4 目标".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    pub time: f64,
    pub level: String,
    pub message: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    session_id: u64,
    system: u8,
    component: u8,
    instance: u8,
    peer: String,
    hardware_uid: Option<String>,
    model: String,
    scene_epoch: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: u64,
    pub status: String,
    pub name: String,
    pub dry_run: bool,
    pub started_at_unix_ms: u64,
    pub binding: Option<Binding>,
    pub elapsed: f64,
    pub real_elapsed: f64,
    pub rc: [f64; 4],
    pub active_blocks: Vec<String>,
    pub values: BTreeMap<String, f64>,
    pub logs: Vec<Log>,
    pub exit_result: String,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            id: 0,
            status: "idle".into(),
            name: String::new(),
            dry_run: true,
            started_at_unix_ms: 0,
            binding: None,
            elapsed: 0.,
            real_elapsed: 0.,
            rc: [0., 0., 0., 0.5],
            active_blocks: Vec::new(),
            values: BTreeMap::new(),
            logs: Vec::new(),
            exit_result: String::new(),
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Trace {
    time: f64,
    rc: [f64; 4],
    values: BTreeMap<String, f64>,
}
struct Controller {
    next: u64,
    worker: Option<JoinHandle<()>>,
    cancel: Arc<AtomicBool>,
    snapshot: Arc<Mutex<Snapshot>>,
    source: String,
    options: Option<Options>,
    trace: Arc<Mutex<Vec<Trace>>>,
    trace_interval_seconds: f64,
}
fn trace_interval_seconds(end: f64) -> f64 {
    (end / 39999.).max(0.1)
}
fn controller() -> &'static Mutex<Controller> {
    static VALUE: OnceLock<Mutex<Controller>> = OnceLock::new();
    VALUE.get_or_init(|| {
        Mutex::new(Controller {
            next: 1,
            worker: None,
            cancel: Arc::new(AtomicBool::new(false)),
            snapshot: Arc::new(Mutex::new(Snapshot::default())),
            source: String::new(),
            options: None,
            trace: Arc::new(Mutex::new(Vec::new())),
            trace_interval_seconds: 0.1,
        })
    })
}
fn record(snapshot: &Arc<Mutex<Snapshot>>, time: f64, level: &str, message: impl Into<String>) {
    if let Ok(mut s) = snapshot.lock() {
        s.logs.push(Log {
            time,
            level: level.into(),
            message: message.into(),
        });
        if s.logs.len() > 2000 {
            s.logs.remove(0);
        }
    }
}
pub fn status() -> Snapshot {
    controller()
        .lock()
        .ok()
        .and_then(|c| c.snapshot.lock().ok().map(|s| s.clone()))
        .unwrap_or_default()
}
/// Cache-only observation for MCP. Never opens a transport or requests telemetry.
pub fn connection_snapshot() -> serde_json::Value {
    let Ok(s) = link().lock() else { return serde_json::json!({"connected":false}); };
    let now = Instant::now();
    let t = &s.telemetry;
    serde_json::json!({
        "connected":s.connected, "forwarded":s.forwarded, "sessionId":s.session,
        "peer":s.peer.map(|p|p.to_string()), "target":t.target,
        "heartbeatAgeMs":t.heartbeat.map(|at|now.duration_since(at).as_millis()),
        "fresh":s.connected && t.fresh(now), "hil":t.hil, "armed":t.armed,
        "hardwareUid":t.uid.map(|uid|format!("{uid:x}")), "values":t.values(now),
        "parameters":t.params.iter().map(|(name,(value,kind,at))|(name,serde_json::json!({
            "value":value,"type":kind,"ageMs":now.duration_since(*at).as_millis()
        }))).collect::<BTreeMap<_,_>>()
    })
}
pub(crate) fn log_relay_generation(session: u64, host: std::net::Ipv4Addr, target: (u8, u8), uid: u64) -> Result<u64, String> {
    let link = link().lock().map_err(|e| e.to_string())?;
    let telemetry = &link.telemetry;
    if !link.connected || !link.forwarded || link.session != session
        || link.peer.map(|peer| peer.ip()) != Some(host.into())
        || telemetry.target != Some(target) || telemetry.uid != Some(uid)
        || !telemetry.heartbeat.is_some_and(|at| at.elapsed() < Duration::from_secs(5))
        || telemetry.signed || telemetry.armed
    {
        return Err("任务机日志下载需要同一飞控的有效连接和上锁心跳".into());
    }
    Ok(telemetry.generation)
}
pub fn stop(id: Option<u64>) -> Result<Snapshot, String> {
    let handle = {
        let mut c = controller().lock().map_err(|e| e.to_string())?;
        if id.is_some_and(|id| c.snapshot.lock().map(|s| s.id != id).unwrap_or(true)) {
            return Err("测试运行标识已变化".into());
        }
        c.cancel.store(true, Ordering::Release);
        c.worker.take()
    };
    if let Some(handle) = handle {
        handle.join().map_err(|_| "测试线程异常退出")?;
    }
    Ok(status())
}
pub fn start(source: String, options: Options) -> Result<Snapshot, String> {
    options.validate()?;
    let script = xml::parse(&source)?;
    if receiver::busy() { return Err("遥控器来源切换中，请等待确认后执行测试".into()); }
    let _source_gate = receiver::gate()?;
    if crate::px4_firmware::busy() { return Err("PX4 固件升级进行中，请等待完成后再执行测试".into()); }
    let mut c = controller().lock().map_err(|e| e.to_string())?;
    if running() {
        return Err("已有仿真测试正在运行".into());
    }
    if let Some(old) = c.worker.take() {
        let _ = old.join();
    }
    let id = c.next;
    c.next += 1;
    let snapshot = Arc::new(Mutex::new(Snapshot {
        id,
        name: script.name.clone(),
        dry_run: options.dry_run,
        status: "preflight".into(),
        started_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        ..Snapshot::default()
    }));
    let cancel = Arc::new(AtomicBool::new(false));
    let trace = Arc::new(Mutex::new(Vec::new()));
    c.cancel = cancel.clone();
    c.snapshot = snapshot.clone();
    c.source = source;
    c.options = Some(options.clone());
    c.trace = trace.clone();
    c.trace_interval_seconds = trace_interval_seconds(script.end);
    LIVE_RUNNING.store(!options.dry_run, Ordering::Release);
    RUNNING.store(true, Ordering::Release);
    c.worker = Some(thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(script, options, cancel, &snapshot, &trace)
        }));
        if result.is_err() {
            record(
                &snapshot,
                0.,
                "error",
                "测试线程异常；已停止发送，飞控退出状态未确认",
            );
            if let Ok(mut s) = snapshot.lock() {
                s.status = "failed".into();
                s.active_blocks.clear();
                s.exit_result = "退出未确认".into();
            }
        }
        LIVE_RUNNING.store(false, Ordering::Release);
        RUNNING.store(false, Ordering::Release);
    }));
    let result = c.snapshot.lock().map_err(|e| e.to_string())?.clone();
    Ok(result)
}
fn telemetry(options: &Options) -> Result<Telemetry, String> {
    let s = link().lock().map_err(|e| e.to_string())?;
    if !s.connected
        || Some(s.session) != options.session_id
        || !s.forwarded
        || s.peer.is_none()
        || s.expected_host.is_none()
        || s.peer.map(|p| p.ip()) != s.expected_host
    {
        return Err("仿真机转发会话、来源或固定回传目标已失效".into());
    }
    if s.telemetry.target != Some((options.system, options.component)) {
        return Err("飞控目标与已绑定会话不符".into());
    }
    Ok(s.telemetry.clone())
}
thread_local! {static WRITER:std::cell::RefCell<Option<(u64,crate::serial_assistant::DatagramWriter)>>=const{std::cell::RefCell::new(None)};}
fn write(options: &Options, bytes: Vec<u8>) -> Result<(), String> {
    let id = options.session_id.ok_or("会话未建立")?;
    WRITER.with(|slot| {
        let mut writer = slot.borrow_mut();
        if writer.as_ref().map(|v| v.0) != Some(id) {
            *writer = Some((id, crate::tool_transport::px4_datagram_writer(id)?));
        }
        let result = writer.as_ref().unwrap().1.write(&bytes).map(|_| ());
        if result.is_err() { *writer = None; }
        result
    })
}
fn simulator(instance: u8) -> Result<(f64, String, u64), String> {
    let frames = crate::scene_telemetry::snapshots();
    let frame = frames
        .iter()
        .find(|f| {
            f["instance_id"]
                .as_str()
                .and_then(|v| v.parse::<u8>().ok())
                .or_else(|| f["instance_id"].as_u64().map(|v| v as u8))
                == Some(instance)
        })
        .ok_or("等待所选仿真实例的运行遥测")?;
    if frame["age_ms"].as_u64().unwrap_or(u64::MAX) > 1500
        || frame["state"].as_str() != Some("running")
    {
        return Err("所选仿真实例未运行、已暂停或遥测超时".into());
    }
    let time = frame["timestamp"]
        .as_f64()
        .or_else(|| frame["t"].as_f64())
        .filter(|v| v.is_finite())
        .ok_or("仿真时钟不可用")?;
    Ok((
        time,
        frame["model"].as_str().unwrap_or("").into(),
        frame["scene_epoch"].as_u64().unwrap_or(0),
    ))
}
// Reuse fresh feedback already streamed by PX4/QGC. Only fill missing streams;
// reconfiguring every stream on each run competes with HIL on the shared link.
fn missing_feedback_streams(target: &Telemetry, now: Instant) -> Vec<(f32, f32)> {
    [(31., 20_000., "q1", 120), (32., 50_000., "local-vx-mps", 200),
     (33., 100_000., "relative-alt-m", 300), (245., 500_000., "landed", 1000)]
        .into_iter().filter_map(|(id, interval, key, age_ms)| {
            let fresh = target.samples.get(&format!("test/fc/{key}"))
                .is_some_and(|(_, at)| now.saturating_duration_since(*at) < Duration::from_millis(age_ms));
            (!fresh).then_some((id, interval))
        }).collect()
}
struct TelemetryStreams<'a> { options: &'a Options, ids: Vec<f32>, sequence: u8, generation: u64, uid: Option<u64> }
impl<'a> TelemetryStreams<'a> {
    fn start(options: &'a Options, sequence: &mut u8) -> Result<Self, String> {
        let target = telemetry(options)?;
        let plan = missing_feedback_streams(&target, Instant::now());
        let mut lease = Self { options, ids: Vec::new(), sequence: *sequence, generation: target.generation, uid: target.uid };
        for (id, interval) in plan {
            let sent = Instant::now();
            write(options, mavlink::command((options.system, options.component), 511,
                [id, interval, 0., 0., 0., 0., 0.], *sequence))?;
            lease.ids.push(id); *sequence = sequence.wrapping_add(1); lease.sequence = *sequence;
            loop {
                let current = telemetry(options)?;
                if !current.fresh(Instant::now()) || !current.hil || current.generation != lease.generation
                    || lease.uid.is_some_and(|uid| current.uid != Some(uid)) {
                    return Err("配置缺失反馈流期间飞控状态变化".into());
                }
                if let Some(ack) = current.acks.get(&511).filter(|ack| ack.at >= sent) {
                    if ack.result != 0 { return Err(format!("飞控拒绝反馈消息 {id} 的发送周期，结果 {}", ack.result)); }
                    break;
                }
                if sent.elapsed() > Duration::from_millis(1500) { return Err(format!("反馈消息 {id} 发送周期配置未确认")); }
                thread::sleep(Duration::from_millis(5));
            }
        }
        Ok(lease)
    }
}
impl Drop for TelemetryStreams<'_> {
    fn drop(&mut self) {
        if self.ids.is_empty() { return; }
        let Ok(target) = telemetry(self.options) else { return; };
        // Leave feedback running while airborne/armed. Deleting streams during
        // an exit-mode transition must not interrupt that vehicle's feedback.
        if target.armed || !target.fresh(Instant::now()) || !target.hil || target.generation != self.generation
            || self.uid.is_some_and(|uid| target.uid != Some(uid)) { return; }
        for id in &self.ids {
            let _ = write(self.options, mavlink::command((self.options.system, self.options.component), 511,
                [*id, 0., 0., 0., 0., 0., 0.], self.sequence));
            self.sequence = self.sequence.wrapping_add(1);
        }
    }
}

fn preflight(
    options: &Options,
    cancel: &AtomicBool,
    sequence: &mut u8,
    angles: bool,
    manual_takeoff: bool,
    heading_test: bool,
    recovery_test: bool,
    extra_parameters: &[&str],
) -> Result<(Telemetry, (f64, String, u64)), String> {
    let first = telemetry(options)?;
    if !first.fresh(Instant::now()) || !first.hil {
        return Err("飞控未确认 HIL 仿真模式或心跳已超时".into());
    }
    let scene = simulator(options.instance)?;
    if angles && !scene.1.eq_ignore_ascii_case("MorphQuad") {
        return Err("此姿态扫描适配当前 MorphQuad / 矢量 HIL 映射，请选择 MorphQuad 实例".into());
    }
    // Legacy angle tests retain optional calibration reads. Heading templates
    // require fresh stick/rate/tilt calibration before any flight actions.
    let mut requested = preflight_parameter_names(angles);
    requested.extend_from_slice(extra_parameters);
    let mut required_parameters = if heading_test { requested.clone() } else if recovery_test { vec!["MPC_MAN_TILT_MAX","MPC_TILTMAX_AIR"] } else { vec![] };
    required_parameters.extend_from_slice(extra_parameters);
    let parameter_since = Instant::now();
    for _ in 0..3 {
        if cancel.load(Ordering::Acquire) {
            return Err("操作已取消".into());
        }
        let sent = Instant::now();
        // The hardware parameter responder has a bounded pending queue. Space
        // read-only requests and retry only responses missing from this run;
        // sending the entire set in one burst can repeatedly lose one channel.
        let pending = pending_preflight_parameters(&requested, &telemetry(options)?, parameter_since);
        for name in pending {
            if cancel.load(Ordering::Acquire) { return Err("操作已取消".into()); }
            write(
                options,
                mavlink::request_param_named((options.system, options.component), name, *sequence),
            )?;
            *sequence = sequence.wrapping_add(1);
            thread::sleep(Duration::from_millis(35));
        }
        if angles || manual_takeoff {
            write(
                options,
                mavlink::command(
                    (options.system, options.component),
                    512,
                    [31., 0., 0., 0., 0., 0., 0.],
                    *sequence,
                ),
            )?;
            *sequence = sequence.wrapping_add(1);
            write(
                options,
                mavlink::command(
                    (options.system, options.component),
                    512,
                    [32., 0., 0., 0., 0., 0., 0.],
                    *sequence,
                ),
            )?;
            *sequence = sequence.wrapping_add(1);
        }
        let mut last_pose = sent;
        while sent.elapsed() < Duration::from_millis(700) {
            if cancel.load(Ordering::Acquire) {
                return Err("操作已取消".into());
            }
            if (angles || manual_takeoff) && last_pose.elapsed() >= Duration::from_millis(100) {
                for id in [31., 32., 33., 245.] {
                    write(
                        options,
                        mavlink::command(
                            (options.system, options.component),
                            512,
                            [id, 0., 0., 0., 0., 0., 0.],
                            *sequence,
                        ),
                    )?;
                    *sequence = sequence.wrapping_add(1);
                }
                last_pose = Instant::now();
            }
            let t = telemetry(options)?;
            if !t.fresh(Instant::now()) || !t.hil || t.generation != first.generation {
                return Err("飞控状态在预检查期间发生变化".into());
            }
            if angles && preflight_feedback(&t, Instant::now()).is_err() {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            if manual_takeoff && manual_takeoff_feedback(&t, Instant::now()).is_err() {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            if required_parameters.iter().any(|name| !t.params.get(*name).is_some_and(|p| p.2 >= parameter_since)) {
                thread::sleep(Duration::from_millis(10));
                continue;
            }
            let current = simulator(options.instance)?;
            if current.1 != scene.1 || current.2 != scene.2 {
                return Err("预检查期间仿真实例发生变化".into());
            }
            return Ok((t, current));
        }
    }
    let t = telemetry(options)?;
    if angles {
        preflight_feedback(&t, Instant::now())?;
    }
    if manual_takeoff {
        manual_takeoff_feedback(&t, Instant::now())?;
    }
    let missing:Vec<_> = required_parameters.iter().filter(|name| !t.params.get(**name).is_some_and(|p|p.2 >= parameter_since)).copied().collect();
    if !missing.is_empty() { return Err(format!("航向/回位测试参数未完成本次回读：{}",missing.join(", "))); }
    Err("预检查期间飞控状态尚未就绪，未发送控制指令".into())
}
fn manual_takeoff_feedback(t: &Telemetry, now: Instant) -> Result<(), String> {
    let values = t.values(now);
    let missing: Vec<_> = ["landed", "relative-alt-m", "climb-rate-mps"]
        .into_iter()
        .filter(|key| !values.contains_key(&format!("test/fc/{key}")))
        .collect();
    if missing.is_empty() {
        if values.get("test/fc/landed") == Some(&1.) && values["test/fc/relative-alt-m"].abs() > 1. {
            return Err("地面相对高度不接近 0 m；模型与飞控高度参考未对齐，请在当前地面模型运行时重建飞控参考，未发送控制指令".into());
        }
        Ok(())
    } else {
        Err(format!(
            "手动油门起飞缺少最新反馈：{}，未发送控制指令",
            missing.join("、")
        ))
    }
}
fn pending_preflight_parameters<'a>(names: &[&'a str], t: &Telemetry, since: Instant) -> Vec<&'a str> {
    let mut pending = Vec::new();
    for &name in names {
        if !t.params.get(name).is_some_and(|p| p.2 >= since) && !pending.contains(&name) {
            pending.push(name);
        }
    }
    pending
}

#[cfg(test)]
#[test]
fn parameter_read_plan_requires_current_run_and_retries_only_missing() {
    let now = Instant::now();
    let mut t = Telemetry::default();
    t.params.insert("SYS_HITL".into(), (1., 6, now));
    t.params.insert("HIL_ACT_FUNC4".into(), (104., 6, now-Duration::from_millis(1)));
    let names = ["SYS_HITL", "HIL_ACT_FUNC4", "HIL_ACT_FUNC8", "HIL_ACT_FUNC4"];
    assert_eq!(pending_preflight_parameters(&names, &t, now), vec!["HIL_ACT_FUNC4", "HIL_ACT_FUNC8"]);
    t.params.insert("HIL_ACT_FUNC4".into(), (104., 6, now));
    assert_eq!(pending_preflight_parameters(&names, &t, now), vec!["HIL_ACT_FUNC8"]);
    t.params.insert("HIL_ACT_FUNC8".into(), (108., 6, now));
    assert!(pending_preflight_parameters(&names, &t, now).is_empty());
}

pub fn preflight_parameter_names(angles: bool) -> Vec<&'static str> {
    let mut names = Vec::new();
    if angles {
        names.extend(["MPC_MAN_TILT_MAX", "MPC_TILTMAX_AIR", "VEC_ATT_MAX", "VEC_REF_EN", "MPC_MAN_Y_MAX", "MAN_DEADZONE", "VEC_HEAD_RATE"]);
    }
    names
}
pub fn preflight_feedback(t: &Telemetry, now: Instant) -> Result<(), String> {
    let values = t.values(now);
    let mut missing = Vec::new();
    if attitude::quaternion(&values).is_err() {
        missing.push("ATTITUDE_QUATERNION（姿态四元数）");
    }
    if ["test/fc/local-x-m", "test/fc/local-y-m", "test/fc/local-vx-mps", "test/fc/local-vy-mps"]
        .iter()
        .any(|key| !values.contains_key(*key))
    {
        missing.push("LOCAL_POSITION_NED（本地位置）");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "飞控遥测未就绪：{}缺失或过期；未发送控制指令",
            missing.join("、")
        ))
    }
}
fn update_attitude_mapping(engine: &mut Engine, t: &Telemetry) {
    let get = |name: &str| t.params.get(name).map(|p| p.0).filter(|v| v.is_finite());
    if let Some(limit) = get("MPC_MAN_TILT_MAX").filter(|v| *v > 0. && *v <= 180.) {
        engine.set("test/profile/manual-tilt-deg", limit);
    }
    let aux = if get("VEC_REF_EN") == Some(0.) {
        get("MPC_MAN_TILT_MAX")
    } else {
        get("VEC_ATT_MAX")
    };
    if let Some(limit) = aux.filter(|v| *v > 0. && *v <= 180.) {
        engine.set("test/profile/aux-angle-deg", limit);
    }
    for (name,path,min,max) in [("MPC_TILTMAX_AIR","altitude-tilt-deg",1.,89.),
        ("MPC_MAN_Y_MAX","yaw-max-rate-deg-s",1.,400.),("MAN_DEADZONE","stick-deadzone",0.,0.49),
        ("VEC_HEAD_RATE","vector-heading-rate-deg-s",1.,400.)] {
        if let Some(value) = get(name).filter(|v| (min..=max).contains(v)) { engine.set(&format!("test/profile/{path}"),value); }
    }
}
fn validate_script_parameters(engine: &Engine, t: &Telemetry) -> Result<(),String> {
    if engine.needs_heading() {
        for name in ["MPC_MAN_TILT_MAX","MPC_TILTMAX_AIR","MPC_MAN_Y_MAX","MAN_DEADZONE","VEC_HEAD_RATE"] {
            if !t.params.get(name).is_some_and(|p| p.2.elapsed() < Duration::from_secs(5)) {
                return Err(format!("航向/回位测试缺少本次参数回读 {name}，未开始测试"));
            }
        }
        for (key,param) in [("manual-tilt-deg","MPC_MAN_TILT_MAX"),("altitude-tilt-deg","MPC_TILTMAX_AIR"),("vector-tilt-deg","VEC_ATT_MAX")] {
            if let Some(required) = engine.value(&format!("test/requirements/{key}")) {
                let actual = t.params.get(param).filter(|p| p.2.elapsed() < Duration::from_secs(5)).map(|p|p.0)
                    .ok_or_else(||format!("缺少本次参数回读 {param}"))?;
                if !required.is_finite() || required <= 0. || actual < required { return Err(format!("模板需要 {key}={required}°，当前 {param}={actual}°，未开始测试")); }
                if key == "vector-tilt-deg" && t.params.get("VEC_REF_EN").map(|p|p.0) != Some(1.) { return Err("矢量±120°模板需要 VEC_REF_EN=1".into()); }
            }
        }
    }
    if engine.needs_recovery() || engine.needs_heading() {
        for (name,min,max) in [("MPC_MAN_TILT_MAX",1.,89.),("MPC_TILTMAX_AIR",1.,89.)] {
            let value=t.params.get(name).filter(|p|p.2.elapsed()<Duration::from_secs(5)).map(|p|p.0).ok_or_else(||format!("回位缺少本次参数回读 {name}"))?;
            if !value.is_finite() || !(min..=max).contains(&value) {return Err(format!("回位参数 {name}={value} 无效"));}
        }
    }
    if engine.needs_heading() {
        for (name,min,max) in [("MPC_MAN_Y_MAX",1.,400.),("MAN_DEADZONE",0.,0.49),("VEC_HEAD_RATE",1.,400.)] {
            let value=t.params.get(name).map(|p|p.0).ok_or_else(||format!("缺少 {name}"))?;
            if !value.is_finite() || !(min..=max).contains(&value) {return Err(format!("航向参数 {name}={value} 无效"));}
        }
    }
    Ok(())
}
fn channel_profile(options: &Options, cancel: &AtomicBool, sequence: &mut u8, expected: &Telemetry, vector: bool, required_aux: [bool; 6]) -> Result<channels::RcProfile, String> {
    let since = Instant::now();
    let names = if options.rc_emulation { channels::receiver_parameter_names() } else { channels::parameter_names(vector) };
    if options.rc_emulation {
        write(options, mavlink::command((options.system, options.component), 512, [65., 0., 0., 0., 0., 0., 0.], *sequence))?;
        *sequence = sequence.wrapping_add(1);
    }
    let mut error = String::new();
    for _ in 0..3 {
        for name in &names {
            if cancel.load(Ordering::Acquire) { return Err("操作已取消".into()); }
            write(options, mavlink::request_param_named((options.system, options.component), name, *sequence))?;
            *sequence = sequence.wrapping_add(1);
            // Parameter reads share the simulator transport; bound the burst.
            thread::sleep(Duration::from_millis(4));
        }
        let until = Instant::now() + Duration::from_millis(700);
        while Instant::now() < until {
            if cancel.load(Ordering::Acquire) { return Err("操作已取消".into()); }
            let t = telemetry(options)?;
            if !t.fresh(Instant::now()) || !t.hil || !same_target(&t, expected) {
                return Err("读取通道映射期间身份或 HIL 链路失效".into());
            }
            let result = if options.rc_emulation { channels::RcProfile::receiver_from_telemetry(&t, since, vector, required_aux) }
                else { channels::RcProfile::from_telemetry(&t, since, vector) };
            match result {
                Ok(profile) => return Ok(profile),
                Err(e) => error = e,
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
    Err(error)
}
struct Pending {
    command: Command,
    wire_id: u16,
    sent: Instant,
    accepted: bool,
    exit: bool,
    cancelled_at: Option<Instant>,
}
fn send_command(
    options: &Options,
    c: Command,
    t: &Telemetry,
    sequence: &mut u8,
    exit: bool,
) -> Result<Pending, String> {
    let (id, args) = match c.kind {
        1 => (400, [1., 0., 0., 0., 0., 0., 0.]),
        2 => {
            if t.values(Instant::now()).get("test/fc/landed") != Some(&1.) {
                return Err("上锁需要飞控最新落地状态确认".into());
            }
            (400, [0., 0., 0., 0., 0., 0., 0.])
        }
        3 => {
            if c.argument.fract() != 0. {
                return Err("模式代码须为整数".into());
            }
            (176, mavlink::mode_args(c.argument as u8)?)
        }
        4 => {
            if !(0.5..=1000.).contains(&c.argument) {
                return Err("起飞高度无效".into());
            }
            let values = t.values(Instant::now());
            let msl = values
                .get("test/fc/altitude-msl-m")
                .ok_or("起飞需要最新海拔高度")?;
            let relative = values
                .get("test/fc/relative-alt-m")
                .ok_or("起飞需要最新相对高度")?;
            (
                22,
                [
                    0.,
                    0.,
                    0.,
                    f32::NAN,
                    f32::NAN,
                    f32::NAN,
                    (msl + c.argument - relative) as f32,
                ],
            )
        }
        5 => (21, [0., 0., 0., f32::NAN, f32::NAN, f32::NAN, 0.]),
        _ => return Err("飞控指令类型无效".into()),
    };
    let sent = Instant::now();
    write(
        options,
        mavlink::command((options.system, options.component), id, args, *sequence),
    )?;
    *sequence = sequence.wrapping_add(1);
    Ok(Pending {
        command: c,
        wire_id: id,
        sent,
        accepted: false,
        exit,
        cancelled_at: None,
    })
}
fn confirmed(p: &mut Pending, t: &Telemetry) -> Result<bool, String> {
    if let Some(ack) = t.acks.get(&p.wire_id) {
        if ack.at >= p.sent && ack.command == p.wire_id {
            match ack.result {
                0 => p.accepted = true,
                5 => {}
                other => return Err(format!("飞控拒绝指令 {}，结果 {other}", p.wire_id)),
            }
        }
    }
    if !p.accepted {
        return Ok(false);
    }
    let now = Instant::now();
    let values = t.values(now);
    let fresh = |key: &str| {
        t.samples
            .get(key)
            .filter(|(_, at)| {
                *at >= p.sent && now.saturating_duration_since(*at) < Duration::from_millis(1500)
            })
            .map(|(value, _)| *value)
    };
    Ok(match p.command.kind {
        1 => fresh("test/fc/armed") == Some(1.),
        2 => fresh("test/fc/armed") == Some(0.),
        3 => fresh("test/fc/mode") == Some(p.command.argument),
        4 => {
            fresh("test/fc/relative-alt-m").is_some_and(|v| v >= p.command.argument - 0.5)
                && values.get("test/fc/landed") == Some(&0.)
        }
        5 => {
            if p.exit {
                fresh("test/fc/mode") == Some(8.)
            } else {
                fresh("test/fc/landed") == Some(1.)
            }
        }
        _ => false,
    })
}
fn same_target(current: &Telemetry, expected: &Telemetry) -> bool {
    current.generation == expected.generation
        && expected.uid.is_none_or(|uid| current.uid == Some(uid))
}
fn write_neutral(options: &Options, profile: Option<&channels::RcProfile>, values: [f64; 4], sequence: &mut u8) -> Result<(), String> {
    let bytes = if options.rc_emulation {
        let pwm = profile.ok_or("缺少遥控器输入映射，停止发送")?.receiver_values(values, [0.; 6], &[None; 18])?;
        mavlink::rc_channels((options.system, options.component), pwm, *sequence)
    } else { mavlink::manual(options.system, values, *sequence) };
    write(options, bytes)?;
    *sequence = sequence.wrapping_add(1);
    Ok(())
}
pub fn receiver_feedback_ready(t: &Telemetry, pwm: &[u16; 18], since: Instant, now: Instant) -> bool {
    t.rc_channels.as_ref().is_some_and(|(raw, at)| *at >= since && now.saturating_duration_since(*at) < Duration::from_millis(400) && raw == pwm)
        && t.rc_health.is_some_and(|(healthy, at)| healthy && at >= since && now.saturating_duration_since(at) < Duration::from_millis(1500))
}
fn prepare_receiver(options: &Options, cancel: &AtomicBool, snapshot: &Arc<Mutex<Snapshot>>, sequence: &mut u8,
    expected: &Telemetry, profile: &channels::RcProfile, neutral: [f64; 4], scene: &(f64, String, u64),
) -> Result<(), String> {
    record(snapshot, 0., "info", "准备模拟遥控器：持续中位/低油门输入，等待 RC 回传匹配及飞控遥控输入健康确认；脚本尚未开始");
    let pwm = profile.receiver_values(neutral, [0.; 6], &[None; 18])?;
    let started = Instant::now(); let mut stable = None;
    let mut last_input = started - Duration::from_secs(1); let mut last_heartbeat = last_input;
    while started.elapsed() < Duration::from_secs(6) {
        if cancel.load(Ordering::Acquire) { return Err("遥控器准备已取消，未执行脚本动作".into()); }
        let now = Instant::now(); let t = telemetry(options)?;
        if !t.fresh(now) || !t.hil || !same_target(&t, expected) || t.armed != expected.armed { return Err("遥控器准备期间身份、HIL、心跳或解锁状态变化，未执行脚本动作".into()); }
        let current = simulator(options.instance)?;
        if current.1 != scene.1 || current.2 != scene.2 { return Err("遥控器准备期间仿真实例发生变化".into()); }
        if now.duration_since(last_input) >= Duration::from_secs_f64(1. / options.rate_hz as f64) {
            write_neutral(options, Some(profile), neutral, sequence)?;last_input = now;
        }
        if now.duration_since(last_heartbeat) >= Duration::from_secs(1) {
            write(options,mavlink::encode(0,&[0,0,0,0,6,8,0,4,3],*sequence))?;
            *sequence=sequence.wrapping_add(1);last_heartbeat=now;
        }
        let ready = receiver_feedback_ready(&t, &pwm, started, now);
        if ready { stable.get_or_insert(now); } else { stable = None; }
        let held = stable.map(|at| now.duration_since(at).as_secs_f64()).unwrap_or(0.);
        if let Ok(mut s) = snapshot.lock() {
            s.values = t.values(now);
            s.rc = neutral;
            s.values.insert("test/receiver/ready".into(), (held >= 1.) as u8 as f64);
            s.values.insert("test/receiver/held-s".into(), held);
        }
        if held >= 1. { record(snapshot,0.,"info","模拟遥控器已就绪：RC 回传匹配，飞控遥控输入健康连续确认 1 秒；开始执行脚本");return Ok(()); }
        thread::sleep(Duration::from_millis(10));
    }
    Err("模拟遥控器未就绪：RC 回传不匹配、反馈过期或飞控尚未接受遥控输入；未执行脚本动作，也未请求解锁".into())
}
fn finish_landing(
    options: &Options, snapshot: &Arc<Mutex<Snapshot>>, sequence: &mut u8,
    time: f64, neutral: [f64; 4], expected: &Telemetry, landed_after: Instant, profile: Option<&channels::RcProfile>,
) -> Result<String, String> {
    record(snapshot,time,"info","已进入降落模式，继续保持输入链路，等待着陆与上锁确认");
    let started=Instant::now(); let mut last_input=started-Duration::from_secs(1);
    let mut last_heartbeat=last_input; let mut disarm:Option<Pending>=None;
    while started.elapsed()<Duration::from_secs(120) {
        let now=Instant::now();let t=telemetry(options)?;
        if !t.fresh(now) || !t.hil || !same_target(&t,expected) {return Err("降落确认期间飞控身份、心跳或 HIL 状态变化，未确认上锁".into());}
        let landed=t.samples.get("test/fc/landed").is_some_and(|(value,at)| *value==1. && *at>=landed_after && now.saturating_duration_since(*at)<Duration::from_millis(1500));
        if landed {
            if !t.armed {return Ok("已确认着陆并上锁，停止输入流".into());}
            if let Some(p)=disarm.as_mut() {
                if confirmed(p,&t)? {return Ok("已确认着陆并上锁，停止输入流".into());}
            } else {
                disarm=Some(send_command(options,Command{owner:"exit-disarm".into(),kind:2,argument:0.},&t,sequence,true)?);
            }
        }
        if now.duration_since(last_input)>=Duration::from_millis(20) {
            let mut rc=neutral;rc[3]=if landed {0.} else {0.5};
            write_neutral(options,profile,rc,sequence)?;last_input=now;
        }
        if now.duration_since(last_heartbeat)>=Duration::from_secs(1) {
            write(options,mavlink::encode(0,&[0,0,0,0,6,8,0,4,3],*sequence))?;*sequence=sequence.wrapping_add(1);last_heartbeat=now;
        }
        if let Ok(mut state)=snapshot.lock(){state.values=t.values(now);}
        thread::sleep(Duration::from_millis(10));
    }
    Err("等待着陆/上锁超过 120 秒；未发送强制上锁指令".into())
}

fn exit_policy(
    options: &Options,
    policy: &str,
    snapshot: &Arc<Mutex<Snapshot>>,
    sequence: &mut u8,
    time: f64,
    neutral: [f64; 4],
    expected: &Telemetry,
    uncertain_command: bool,
    profile: Option<&channels::RcProfile>,
) -> Result<String, String> {
    if options.dry_run {
        return Ok(format!("预演退出：{policy}"));
    }
    let t = telemetry(options).map_err(|_| "链路已失效，停止发送；退出状态未确认")?;
    if !options.rc_emulation && !receiver::configured(&t,1) {
        return Err("主输入选择已改变，停止发送；退出状态未确认".into());
    }
    if !t.fresh(Instant::now()) || !t.hil || !same_target(&t, expected) {
        return Err("心跳或 HIL 状态失效，停止发送；退出状态未确认".into());
    }
    write_neutral(options, profile, neutral, sequence)?;
    if policy == "release" {
        return Ok("已停止遥控输入流；后续行为由飞控输入失联配置决定".into());
    }
    // A fresh disarmed heartbeat needs no additional flight-mode command.
    if !t.armed && !uncertain_command {
        return Ok("飞控已上锁；停止输入流".into());
    }
    // PX4 filters stick derivatives over 0.1 s. Centering and requesting an
    // automatic mode in the same tick can cancel LAND as "pilot takeover".
    // Let that movement settle first, keeping the original protections active.
    let neutral = [0., 0., 0., 0.5];
    let centered_until = Instant::now() + Duration::from_millis(800);
    write(options, mavlink::encode(0, &[0,0,0,0,6,8,0,4,3], *sequence))?;
    *sequence = sequence.wrapping_add(1);
    while Instant::now() < centered_until {
        let t = telemetry(options)?;
        if !t.fresh(Instant::now()) || !t.hil || !same_target(&t, expected) {
            return Err("退出回中期间身份或链路失效；未发送模式指令".into());
        }
        if !t.armed && !uncertain_command { return Ok("飞控已上锁；停止输入流".into()); }
        write_neutral(options, profile, neutral, sequence)?;
        thread::sleep(Duration::from_millis(20));
    }
    let t = telemetry(options)?;
    let c = Command {
        owner: "exit".into(),
        kind: if policy == "land" { 5 } else { 3 },
        argument: 4.,
    };
    let mut pending =
        send_command(options, c, &t, sequence, true).map_err(|e| format!("退出请求未确认：{e}"))?;
    let until = Instant::now() + Duration::from_secs(3);
    let mut last_neutral = Instant::now();
    while Instant::now() < until {
        if let Ok(t) = telemetry(options) {
            if !t.fresh(Instant::now()) || !t.hil || !same_target(&t, expected) {
                break;
            }
            match confirmed(&mut pending, &t) {
                Ok(true) => {
                    if policy=="land" {return finish_landing(options,snapshot,sequence,time,neutral,expected,pending.sent,profile);}
                    return Ok(format!("已确认退出模式：{policy}"));
                }
                Err(e) => return Err(format!("退出请求被拒绝：{e}")),
                _ => {}
            }
        }
        if last_neutral.elapsed() >= Duration::from_millis(50) {
            write_neutral(options, profile, neutral, sequence)?;
            last_neutral = Instant::now();
        }
        thread::sleep(Duration::from_millis(15));
    }
    record(
        snapshot,
        time,
        "error",
        "退出指令已发送，但未同时取得 ACK 与状态确认",
    );
    Err("退出结果未确认；已停止输入流".into())
}
fn run(
    script: xml::Script,
    options: Options,
    cancel: Arc<AtomicBool>,
    snapshot: &Arc<Mutex<Snapshot>>,
    trace: &Arc<Mutex<Vec<Trace>>>,
) {
    let mut sequence = 0u8;
    let mut engine = Engine::new(script);
    if !options.dry_run && !options.rc_emulation {
        if let Err(error)=engine.manual_control_compatible() {
            record(snapshot,0.,"error",&error);
            if let Ok(mut s)=snapshot.lock(){s.status="failed".into();s.exit_result="脚本不兼容，未发送控制指令".into();}
            return;
        }
    }
    let trace_interval = trace_interval_seconds(engine.script.end);
    engine.set("test/profile/manual-tilt-deg", 45.);
    engine.set("test/profile/aux-angle-deg", 120.);
    if options.dry_run {
        for (key,value) in [("altitude-tilt-deg",35.),("yaw-max-rate-deg-s",60.),("stick-deadzone",0.1),("vector-heading-rate-deg-s",20.)] {
            engine.set(&format!("test/profile/{key}"),value);
        }
    }
    engine.set("test/profile/rc-emulation", options.rc_emulation as u8 as f64);
    let mut first = Telemetry::default();
    let mut scene_origin = None;
    let mut rc_profile = None;
    if !options.dry_run {
        match preflight(
            &options,
            &cancel,
            &mut sequence,
            engine.needs_attitude(),
            engine.needs_manual_takeoff(),
            engine.needs_heading(),
            engine.needs_recovery(),
            &xcd20::parameters(&engine),
        ).and_then(|(t, scene)| {
            if !options.rc_emulation { receiver::require_manual(&options,&t,&mut sequence,&cancel)?; }
            if options.rc_emulation {
                rc_profile = Some(channel_profile(&options, &cancel, &mut sequence, &t, engine.needs_vector_switch(), engine.required_aux())?);
                let current = simulator(options.instance)?;
                if current.1 != scene.1 || current.2 != scene.2 {
                    return Err("读取通道配置期间仿真实例发生变化".into());
                }
            }
            validate_script_parameters(&engine,&t)?;
            xcd20::preflight(&engine,&t,options.instance)?;
            Ok((t, scene))
        }) {
            Ok((t, scene)) => {
                let peer = link()
                    .lock()
                    .ok()
                    .and_then(|s| s.peer)
                    .map(|p| p.to_string())
                    .unwrap_or_default();
                if let Ok(mut s) = snapshot.lock() {
                    s.binding = Some(Binding {
                        session_id: options.session_id.unwrap_or_default(),
                        system: options.system,
                        component: options.component,
                        instance: options.instance,
                        peer,
                        hardware_uid: t.uid.map(|uid| format!("{uid:016x}")),
                        model: scene.1.clone(),
                        scene_epoch: scene.2,
                    });
                }
                first = t;
                if engine.needs_manual_takeoff()
                    && first.values(Instant::now()).get("test/fc/landed") == Some(&0.)
                {
                    engine.set("test/rc/throttle-norm", 0.5);
                }
                if engine.needs_attitude() {
                    update_attitude_mapping(&mut engine, &first);
                }
                scene_origin = Some(scene);
            }
            Err(e) => {
                record(snapshot, 0., "error", &e);
                if let Ok(mut s) = snapshot.lock() {
                    s.status = if cancel.load(Ordering::Acquire) {
                        "stopped"
                    } else {
                        "failed"
                    }
                    .into();
                    s.exit_result = "预检查未通过，未发送控制指令".into();
                }
                return;
            }
        }
    }
    if !options.dry_run {
        let neutral = [0.,0.,0.,if first.values(Instant::now()).get("test/fc/landed") == Some(&1.) && !first.armed {0.} else {engine.value("test/rc/throttle-norm").unwrap_or(0.5)}];
        let prepared=if options.rc_emulation { prepare_receiver(&options,&cancel,snapshot,&mut sequence,&first,rc_profile.as_ref().expect("receiver profile validated"),neutral,scene_origin.as_ref().expect("scene validated")) }
            else { receiver::prepare_manual(&options,&cancel,snapshot,&mut sequence,&first,neutral) };
        if let Err(error) = prepared {
            record(snapshot,0.,"error",&error);
            let exit = exit_policy(&options,&options.on_abort,snapshot,&mut sequence,0.,neutral,&first,false,rc_profile.as_ref()).unwrap_or_else(|e| e);
            record(snapshot,0.,"info",&exit);
            if let Ok(mut s) = snapshot.lock() {s.status=if cancel.load(Ordering::Acquire){"stopped"}else{"failed"}.into();s.exit_result=exit;s.values.insert("test/receiver/ready".into(),0.);}
            return;
        }
        engine.set("test/receiver/ready",1.);
    }
    record(
        snapshot,
        0.,
        "info",
        if options.dry_run {
            "离线预演：使用示例飞控状态，不发送设备指令"
        } else {
            if options.rc_emulation { "目标、HIL 及仿真实例已确认，使用校准后的完整 RC 帧模拟遥控器" }
            else { "目标、HIL 及仿真实例已确认，开始测试" }
        },
    );
    let started = Instant::now();
    let mut last_send = Instant::now() - Duration::from_secs(1);
    let mut last_heartbeat = last_send;
    let mut last_identity_request = last_send;
    let mut pending: Option<Pending> = None;
    let mut processed = BTreeSet::new();
    let mut simulated = BTreeMap::<String, (Command, Instant)>::new();
    let mut fake = BTreeMap::from([
        ("test/fc/armed".into(), 1.),
        ("test/fc/hil".into(), 1.),
        ("test/fc/mode".into(), 3.),
        ("test/fc/relative-alt-m".into(), 5.),
        ("test/fc/altitude-msl-m".into(), 100.),
        ("test/fc/roll-abs-deg".into(), 2.),
        ("test/fc/pitch-abs-deg".into(), 1.),
        ("test/fc/landed".into(), 0.),
        ("test/fc/groundspeed-mps".into(), 0.),
        ("test/fc/climb-rate-mps".into(), 0.),
        ("test/fc/q1".into(), 1.),
        ("test/fc/q2".into(), 0.),
        ("test/fc/q3".into(), 0.),
        ("test/fc/q4".into(), 0.),
        ("test/fc/roll-rate-rad-s".into(), 0.),
        ("test/fc/pitch-rate-rad-s".into(), 0.),
        ("test/fc/yaw-rate-rad-s".into(), 0.),
        ("test/fc/local-x-m".into(), 0.),
        ("test/fc/local-y-m".into(), 0.),
        ("test/fc/local-z-m".into(), -5.),
        ("test/fc/local-vx-mps".into(), 0.),
        ("test/fc/local-vy-mps".into(), 0.),
    ]);
    if options.dry_run && engine.needs_manual_takeoff() {
        engine.set("test/rc/throttle-norm", 0.5);
    }
    let mut outcome = "passed";
    let mut reason = String::new();
    let mut last_sim_time = scene_origin.as_ref().map(|s| s.0);
    let mut last_progress = Instant::now();
    let mut last_trace = -1.;
    let structured = engine.properties.contains_key("test/runtime/complete");
    let result = (|| -> Result<(), String> {
        // Stream subscriptions avoid a 50 Hz REQUEST_MESSAGE / ACK exchange
        // competing with the HIL sensor/actuator traffic on the shared link.
        let _streams = if options.dry_run { None } else { Some(TelemetryStreams::start(&options, &mut sequence)?) };
        loop {
            if cancel.load(Ordering::Acquire) {
                outcome = "stopped";
                reason = "用户终止测试".into();
                break;
            }
            let now = Instant::now();
            let mut time = started.elapsed().as_secs_f64() * if options.dry_run { 4. } else { 1. };
            let t = if options.dry_run {
                None
            } else {
                let t = telemetry(&options)?;
                if !t.fresh(now)
                    || !t.hil
                    || t.generation != first.generation
                    || first.uid.is_some_and(|uid| Some(uid) != t.uid)
                {
                    return Err("飞控失联、重启、身份或 HIL 状态发生变化".into());
                }
                if first.uid.is_none() {
                    first.uid = t.uid;
                }
                if !options.rc_emulation && !receiver::configured(&t,1) { return Err("COM_RC_IN_MODE 不再选择 MAVLink 主输入，停止测试".into()); }
                let scene = simulator(options.instance)?;
                let origin = scene_origin.as_ref().unwrap();
                if scene.1 != origin.1
                    || scene.2 != origin.2
                    || scene.0 + 1e-6 < last_sim_time.unwrap_or(scene.0)
                {
                    return Err("仿真实例或时钟已重置".into());
                }
                if scene.0 > last_sim_time.unwrap_or(scene.0) + 1e-6 {
                    last_progress = now;
                }
                if now.duration_since(last_progress) > Duration::from_secs(2) {
                    return Err("仿真时间停止推进".into());
                }
                last_sim_time = Some(scene.0);
                if options.clock == "simulation" {
                    time = scene.0 - origin.0;
                }
                Some(t)
            };
            if started.elapsed().as_secs_f64() > xml::MAX_TEST_SECONDS {
                return Err("测试真实运行时长超过上限".into());
            }
            if engine.needs_attitude() {
                if let Some(t) = &t {
                    update_attitude_mapping(&mut engine, t);
                }
            }
            engine
                .properties
                .retain(|key, _| !key.starts_with("test/fc/"));
            for (key, value) in t
                .as_ref()
                .map(|v| v.values(now))
                .unwrap_or_else(|| fake.clone())
            {
                engine.set(&key, value);
            }
            engine.properties.retain(|key,_|!key.starts_with("test/sim/"));
            if !options.dry_run {for (key,value) in xcd20::values(&engine,options.instance)?{engine.set(&key,value);}}
            xcd20::derived(&mut engine);
            engine.set("test/runtime/ready", 1.);
            if let Some(p) = pending.as_mut() {
                if engine.value(&format!("{}/request", p.command.owner)) != Some(1.)
                    && p.cancelled_at.is_none()
                {
                    p.cancelled_at = Some(now);
                }
                if confirmed(p, t.as_ref().unwrap())? {
                    let owner = p.command.owner.clone();
                    engine.set(&format!("{owner}/status"), 1.);
                    pending = None;
                } else if p
                    .cancelled_at
                    .is_some_and(|at| now.duration_since(at) > Duration::from_secs(3))
                {
                    return Err("已取消分支的飞控指令结果未确认，终止后续状态指令".into());
                }
            }
            if options.dry_run {
                let complete: Vec<_> = simulated
                    .iter()
                    .filter(|(_, (_, at))| now.duration_since(*at) >= Duration::from_millis(100))
                    .map(|(key, _)| key.clone())
                    .collect();
                for key in complete {
                    let (c, _) = simulated.remove(&key).unwrap();
                    match c.kind {
                        1 => {
                            fake.insert("test/fc/armed".into(), 1.);
                        }
                        2 => {
                            fake.insert("test/fc/armed".into(), 0.);
                        }
                        3 => {
                            fake.insert("test/fc/mode".into(), c.argument);
                        }
                        4 => {
                            fake.insert("test/fc/relative-alt-m".into(), c.argument);
                            fake.insert("test/fc/landed".into(), 0.);
                        }
                        5 => {
                            fake.insert("test/fc/landed".into(), 1.);
                        }
                        _ => {}
                    }
                    engine.set(&format!("{key}/status"), 1.);
                }
            }
            engine.tick(time)?;
            if cancel.load(Ordering::Acquire) {
                outcome = "stopped";
                reason = "用户终止测试".into();
                break;
            }
            for message in &engine.messages {
                record(snapshot, time, "info", message);
            }
            if engine.failed() {
                return Err(format!(
                    "脚本失败：{}",
                    engine
                        .messages
                        .last()
                        .cloned()
                        .unwrap_or_else(|| "条件或指令未满足".into())
                ));
            }
            let inputs = engine.inputs()?;
            let rc = engine.rc()?;
            // Offline auto mapping uses simulated RC8; live runs always use
            // RC_MAP_VECTOR_SW read from the bound controller.
            let (aux, channel_values, manual_buttons) = if options.rc_emulation || options.dry_run {
                let (aux,channels)=engine.channel_outputs(rc_profile.as_ref().map(|p|p.vector_channel).unwrap_or(8))?;
                (aux,channels,0)
            } else { let (aux,buttons)=engine.manual_outputs()?;(aux,[None;18],buttons) };
            let pwm = if !options.dry_run && options.rc_emulation {
                Some(rc_profile.as_ref().ok_or("缺少 RC 通道校准")?.receiver_values(rc, aux, &channel_values)?)
            } else { None };
            let commands = engine.commands()?;
            if !inputs.is_empty() && (pending.is_some() || !simulated.is_empty()) {
                return Err("飞控状态指令与打杆动作重叠".into());
            }
            if commands
                .iter()
                .filter(|c| !processed.contains(&c.owner))
                .count()
                > 1
            {
                return Err("并行分支同时改变飞控状态，请将飞控指令串行排列".into());
            }
            for c in commands {
                if processed.contains(&c.owner) {
                    continue;
                }
                if !simulated.is_empty() {
                    return Err("并行飞控状态指令冲突".into());
                }
                if let Some(old) = &pending {
                    if engine.value(&format!("{}/request", old.command.owner)) == Some(1.) {
                        return Err("并行飞控状态指令冲突".into());
                    }
                    continue;
                }
                if !inputs.is_empty() {
                    return Err("飞控状态指令与打杆动作重叠".into());
                }
                processed.insert(c.owner.clone());
                if options.dry_run {
                    simulated.insert(c.owner.clone(), (c, now));
                } else {
                    pending = Some(send_command(
                        &options,
                        c,
                        t.as_ref().unwrap(),
                        &mut sequence,
                        false,
                    )?);
                }
            }
            let values: BTreeMap<_, _> = engine
                .properties
                .iter()
                .filter(|(k, _)| {
                    k.starts_with("test/fc/")
                        || k.starts_with("test/output/")
                        || k.starts_with("test/receiver/")
                        || k.starts_with("test/altitude/")
                        || (k.starts_with("test/manual/") && !k.ends_with("/status"))
                        || (k.starts_with("test/attitude/") && !k.ends_with("/status"))
                        || (k.starts_with("test/heading/") && !k.ends_with("/status"))
                        || k.starts_with("test/reference/")
                })
                .map(|(k, v)| (k.clone(), *v))
                .collect();
            if let Ok(mut s) = snapshot.lock() {
                s.status = "running".into();
                s.elapsed = time;
                s.real_elapsed = started.elapsed().as_secs_f64();
                s.rc = rc;
                s.active_blocks = engine.active_blocks();
                s.values = values.clone();
                if let Some(binding) = s.binding.as_mut() {
                    if binding.hardware_uid.is_none() {
                        binding.hardware_uid = first.uid.map(|uid| format!("{uid:016x}"));
                    }
                }
            }
            if time - last_trace >= trace_interval {
                if let Ok(mut points) = trace.lock() {
                    if points.len() < 40000 {
                        points.push(Trace { time, rc, values });
                    }
                }
                last_trace = time;
            }
            if engine.done() && pending.is_none() && simulated.is_empty() {
                break;
            }
            if time > engine.script.end {
                if pending.is_some() || !simulated.is_empty() {
                    return Err("脚本结束时仍有飞控指令未取得 ACK 与状态双确认".into());
                }
                if structured {
                    return Err("脚本运行到 end，流程尚未完成".into());
                }
                break;
            }
            if !options.dry_run {
                if now.duration_since(last_heartbeat) >= Duration::from_secs(1) {
                    write(
                        &options,
                        mavlink::encode(0, &[0, 0, 0, 0, 6, 8, 0, 4, 3], sequence),
                    )?;
                    sequence = sequence.wrapping_add(1);
                    last_heartbeat = now;
                }
                if now.duration_since(last_identity_request) >= Duration::from_secs(5) {
                    write(&options, mavlink::command((options.system, options.component), 512,
                        [148., 0., 0., 0., 0., 0., 0.], sequence))?;
                    sequence = sequence.wrapping_add(1); last_identity_request = now;
                    if !options.rc_emulation { receiver::query(&options,&mut sequence,true)?; }
                }
                if engine.value("test/rc/enabled") == Some(1.)
                    && now.duration_since(last_send)
                        >= Duration::from_secs_f64(1. / options.rate_hz as f64)
                {
                    if !options.rc_emulation {
                        write(&options, mavlink::manual_with_buttons(options.system, rc, aux, manual_buttons, sequence))?;
                        sequence = sequence.wrapping_add(1);
                    }
                    if let Some(pwm) = pwm {
                        write(&options, mavlink::rc_channels((options.system, options.component), pwm, sequence))?;
                        sequence = sequence.wrapping_add(1);
                    }
                    last_send = now;
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    })();
    if let Err(e) = result {
        outcome = "failed";
        reason = e;
    }
    if !reason.is_empty() {
        record(
            snapshot,
            engine.time,
            if outcome == "failed" { "error" } else { "info" },
            reason,
        );
    }
    if let Ok(mut s) = snapshot.lock() {
        s.status = "exiting".into();
        s.values.retain(|k, _| !k.starts_with("test/output/"));
        s.active_blocks.clear();
        s.rc = [
            0.,
            0.,
            0.,
            engine.value("test/rc/throttle-norm").unwrap_or(0.5),
        ];
    }
    let neutral = [
        0.,
        0.,
        0.,
        if engine.needs_manual_takeoff() && engine.value("test/fc/landed") == Some(0.) {
            0.5
        } else {
            engine.value("test/rc/throttle-norm").unwrap_or(0.5)
        },
    ];
    // A stopped script cannot retract a command already accepted by the FC.
    // Drain its result before choosing the exit mode, and never treat an older
    // disarmed heartbeat as proof that a pending arm had no effect.
    let mut uncertain_command = false;
    if !options.dry_run {
        if let Some(p) = pending.as_mut() {
            let until = Instant::now() + Duration::from_secs(3);
            let mut resolved = false;
            while Instant::now() < until {
                let Ok(t) = telemetry(&options) else {
                    break;
                };
                if !t.fresh(Instant::now()) || !t.hil || !same_target(&t, &first) {
                    break;
                }
                match confirmed(p, &t) {
                    Ok(true) => {
                        resolved = true;
                        break;
                    }
                    Err(e) => {
                        record(snapshot, engine.time, "error", e);
                        resolved = true;
                        break;
                    }
                    _ => {}
                }
                if write_neutral(&options, rc_profile.as_ref(), neutral, &mut sequence).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            if !resolved {
                uncertain_command = true;
                outcome = "failed";
                record(
                    snapshot,
                    engine.time,
                    "error",
                    "退出时在途飞控指令结果未确认",
                );
            }
        }
    }
    let policy = if outcome == "passed" {
        &options.on_finish
    } else {
        &options.on_abort
    };
    let exit = match exit_policy(
        &options,
        policy,
        snapshot,
        &mut sequence,
        engine.time,
        neutral,
        &first,
        uncertain_command,
        rc_profile.as_ref(),
    ) {
        Ok(v) => v,
        Err(e) => {
            outcome = "failed";
            e
        }
    };
    record(snapshot, engine.time, "info", &exit);
    if let Ok(mut s) = snapshot.lock() {
        s.status = outcome.into();
        s.exit_result = exit;
        s.active_blocks.clear();
        s.real_elapsed = started.elapsed().as_secs_f64();
    }
}

#[tauri::command]
pub async fn flight_test_validate(source: String) -> Result<serde_json::Value, String> {
    crate::run_blocking(move||{let script=xml::parse(&source)?;Ok(serde_json::json!({"name":script.name,"events":script.events.len(),"properties":script.properties.len(),"end":script.end}))}).await
}
#[tauri::command]
pub async fn flight_test_start(source: String, options: Options) -> Result<Snapshot, String> {
    crate::run_blocking(move || start(source, options)).await
}
#[tauri::command]
pub fn flight_test_status() -> Snapshot {
    status()
}
#[tauri::command]
pub async fn flight_test_rc_source_status(options: Options) -> Result<receiver::SourceStatus, String> {
    crate::run_blocking(move || receiver::status(options)).await
}
#[tauri::command]
pub async fn flight_test_rc_source_select(options: Options, source: u8) -> Result<receiver::SourceStatus, String> {
    crate::run_blocking(move || receiver::select(options, source)).await
}
#[tauri::command]
pub async fn flight_test_stop(id: Option<u64>) -> Result<Snapshot, String> {
    crate::run_blocking(move || stop(id)).await
}
#[tauri::command]
pub fn flight_test_report() -> Result<serde_json::Value, String> {
    let c = controller().lock().map_err(|e| e.to_string())?;
    if running() {
        return Err("请在测试退出完成后保存记录".into());
    }
    let snapshot = c.snapshot.lock().map_err(|e| e.to_string())?.clone();
    let trace = c.trace.lock().map_err(|e| e.to_string())?.clone();
    Ok(
        serde_json::json!({"format":"px4-jsbsim-flight-test","version":1,"sourceXml":c.source,"options":c.options,"result":snapshot,"trace":trace,"traceIntervalSeconds":c.trace_interval_seconds,"traceLimit":40000,"eventLogLimit":2000}),
    )
}

#[cfg(test)]
mod link_recovery_tests {
    use super::*;
    #[test]
    fn abandoned_forwarding_is_recoverable_after_heartbeat_timeout() {
        let now = Instant::now();
        let mut s = Link { session: 9, bound_at: Some(now), connected: true, forwarded: true, ..Default::default() };
        assert_eq!(s.stale_session(now), None, "do not reclaim a connection still waiting for its first heartbeat");
        assert_eq!(s.stale_session(now + Duration::from_secs(5)), Some(9));
        s.telemetry.heartbeat = Some(now + Duration::from_secs(4));
        assert_eq!(s.stale_session(now + Duration::from_secs(5)), None, "fresh heartbeat owns its session");
        assert_eq!(s.stale_session(now + Duration::from_secs(9)), Some(9));
        s.connected = false;
        assert_eq!(s.stale_session(now + Duration::from_secs(5)), Some(9));
        s.forwarded = false;
        assert_eq!(s.stale_session(now + Duration::from_secs(9)), None, "do not reclaim another transport type");
    }
}

#[cfg(test)]
mod takeoff_reference_tests {
    use super::*;
    #[test]
    fn grounded_takeoff_rejects_stale_home_height_before_arming() {
        let mut t = Telemetry::default(); let now = Instant::now();
        let mut hb = vec![0; 9]; hb[5] = 12; hb[6] = 32;
        t.ingest(&mavlink::Frame { id: 0, system: 1, component: 1, payload: hb, signed: false }, now);
        let mut p = vec![0; 28]; p[16..20].copy_from_slice(&(-174_000_i32).to_le_bytes());
        t.ingest(&mavlink::Frame { id: 33, system: 1, component: 1, payload: p.clone(), signed: false }, now);
        t.ingest(&mavlink::Frame { id: 245, system: 1, component: 1, payload: vec![0, 1], signed: false }, now);
        assert!(manual_takeoff_feedback(&t, now).unwrap_err().contains("高度参考未对齐"));
        p[16..20].copy_from_slice(&0_i32.to_le_bytes());
        t.ingest(&mavlink::Frame { id: 33, system: 1, component: 1, payload: p, signed: false }, now);
        manual_takeoff_feedback(&t, now).unwrap();
    }
}

#[cfg(test)]
mod feedback_plan_tests {
    use super::*;
    #[test]
    fn reuse_default_streams_and_fill_only_stale_feedback() {
        let now = Instant::now(); let mut target = Telemetry::default();
        assert_eq!(missing_feedback_streams(&target, now).len(), 4);
        for key in ["q1", "local-vx-mps", "relative-alt-m", "landed"] {
            target.samples.insert(format!("test/fc/{key}"), (0., now));
        }
        assert!(missing_feedback_streams(&target, now).is_empty());
        target.samples.insert("test/fc/q1".into(), (1., now-Duration::from_millis(150)));
        assert_eq!(missing_feedback_streams(&target, now), vec![(31., 20_000.)]);
    }
}

#[cfg(test)]
mod four_mode_parameter_tests {
    use super::*;
    #[test]
    fn current_parameters_are_required_before_full_template_actions() {
        let e=Engine::new(xml::parse(include_str!("../../../examples/flight-tests/morphquad-attitude/10_four_mode_complete.xml")).unwrap());
        let now=Instant::now();let mut t=Telemetry::default();
        for (name,value) in [("MPC_MAN_TILT_MAX",60.),("MPC_TILTMAX_AIR",35.),("VEC_ATT_MAX",120.),("VEC_REF_EN",1.),("MPC_MAN_Y_MAX",120.),("MAN_DEADZONE",0.1),("VEC_HEAD_RATE",20.)] {t.params.insert(name.into(),(value,0,now));}
        validate_script_parameters(&e,&t).unwrap();
        t.params.get_mut("MPC_TILTMAX_AIR").unwrap().0=34.;assert!(validate_script_parameters(&e,&t).unwrap_err().contains("35"));
        t.params.get_mut("MPC_TILTMAX_AIR").unwrap().0=35.;t.params.get_mut("VEC_REF_EN").unwrap().0=0.;assert!(validate_script_parameters(&e,&t).unwrap_err().contains("VEC_REF_EN"));
        t.params.get_mut("VEC_REF_EN").unwrap().0=1.;t.params.get_mut("MAN_DEADZONE").unwrap().2=now-Duration::from_secs(6);assert!(validate_script_parameters(&e,&t).unwrap_err().contains("MAN_DEADZONE"));
        t.params.get_mut("MAN_DEADZONE").unwrap().2=now;t.params.get_mut("MPC_MAN_Y_MAX").unwrap().0=0.;assert!(validate_script_parameters(&e,&t).unwrap_err().contains("MPC_MAN_Y_MAX"));
    }
}
