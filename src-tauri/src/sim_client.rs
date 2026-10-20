//! UDP simulation client — receives telemetry from JSBSim sim_server.
//!
//! Desktop simulation client:
//!   - Listens on a UDP port (default 5801) for JSON telemetry packets.
//!   - Stores the latest frame; marks disconnected after 2 s without packets.
//!   - Sends 72-byte VisControlFrame (magic "VCTL" + override + 16×f32) back
//!     to the simulation host.

use serde_json::{json, Value};
use serde::Deserialize;
use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/* Until a board is discovered, keep the placeholder on loopback so commands
 * cannot be sent to a stale address from a different network. */
const DEFAULT_CTRL_HOST: &str = "127.0.0.1";
const DEFAULT_CTRL_PORT: u16 = 5802;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceInitial {
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub altitude_m: f64,
    pub roll_deg: f64,
    pub pitch_deg: f64,
    pub yaw_deg: f64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct InstanceNetworkEndpoint { pub ip: String, pub port: String }
#[derive(Clone, Debug, Deserialize)]
pub struct InstanceNetwork {
    pub input: Option<InstanceNetworkEndpoint>,
    pub sensor: Option<InstanceNetworkEndpoint>,
    pub gps: Option<InstanceNetworkEndpoint>,
}
#[cfg(not(test))]
const DISCOVERY_PORT: u16 = 5803;
#[cfg(test)]
const DISCOVERY_PORT: u16 = 0;

fn model_basename(model: &str) -> &str {
    model.rsplit('/').next().unwrap_or(model).trim_end_matches(".xml")
}

fn lifecycle_packet(command: u8) -> [u8; 5] {
    [b'V', b'C', b'M', b'D', command]
}

fn instance_command_packet(id: u8, action: u8, model: Option<&str>, host: Option<&str>,
                           port: Option<u16>, initial: Option<&InstanceInitial>,
                           network: Option<&InstanceNetwork>) -> std::io::Result<Vec<u8>> {
    if !(1..=8).contains(&id) || !(1..=4).contains(&action) {
        return Err(std::io::Error::other("invalid instance or action"));
    }
    let mut packet = vec![b'V', b'C', b'M', b'D', 10, id, action];
    if action == 1 {
        let model = model.ok_or_else(|| std::io::Error::other("model is required"))?;
        if model.is_empty() || model.len() >= 64 || !model.bytes().all(|byte|
            byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
            return Err(std::io::Error::other("invalid model name"));
        }
        let host = host.unwrap_or("");
        if !host.is_empty() {
            host.parse::<std::net::Ipv4Addr>()
                .map_err(|_| std::io::Error::other("invalid PX4 IPv4 address"))?;
        }
        if port == Some(0) { return Err(std::io::Error::other("invalid PX4 UDP port")); }
        let pose = if let Some(initial) = initial {
            let values = [initial.latitude_deg, initial.longitude_deg, initial.altitude_m,
                initial.roll_deg, initial.pitch_deg, initial.yaw_deg];
            if !values.iter().all(|value| value.is_finite()) ||
                initial.latitude_deg.abs() > 90.0 || initial.longitude_deg.abs() > 180.0 ||
                !(-1000.0..=100000.0).contains(&initial.altitude_m) ||
                [initial.roll_deg, initial.pitch_deg, initial.yaw_deg].iter().any(|value| value.abs() > 360.0) {
                return Err(std::io::Error::other("invalid initial position or attitude"));
            }
            Some(values.map(|value| value.to_string()).join(","))
        } else { None };
        packet.extend_from_slice(model.as_bytes());
        if let Some(network) = network {
            let mut fields = Vec::with_capacity(6);
            let mut any = false;
            for (key, endpoint) in [("input", &network.input), ("sensor", &network.sensor), ("gps", &network.gps)] {
                if let Some(endpoint) = endpoint {
                    let ip = endpoint.ip.trim();
                    if (!ip.is_empty() || key == "input") && ip.parse::<std::net::Ipv4Addr>().is_err() {
                        return Err(std::io::Error::other(format!("invalid {key} IPv4 address")));
                    }
                    let parsed = endpoint.port.parse::<u16>().map_err(|_| std::io::Error::other(format!("invalid {key} port")))?;
                    if parsed == 0 { return Err(std::io::Error::other(format!("invalid {key} port"))); }
                    fields.push(ip.to_string()); fields.push(parsed.to_string()); any = true;
                } else { fields.push(String::new()); fields.push("0".into()); }
            }
            if !any { return Err(std::io::Error::other("empty network override")); }
            packet.extend_from_slice(format!("|{host}|{}|{}|{}", port.map(|value| value.to_string()).unwrap_or_default(),
                pose.unwrap_or_default(), fields.join(",")).as_bytes());
        } else {
            if !host.is_empty() || port.is_some() {
                packet.push(b'|'); packet.extend_from_slice(host.as_bytes());
                if let Some(port) = port {
                    packet.push(b'|'); packet.extend_from_slice(port.to_string().as_bytes());
                }
            }
            if let Some(pose) = pose {
                if host.is_empty() && port.is_none() { packet.extend_from_slice(b"||"); }
                else if port.is_none() { packet.push(b'|'); }
                packet.push(b'|'); packet.extend_from_slice(pose.as_bytes());
            }
        }
    }
    Ok(packet)
}

// ── public struct ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SimClient {
    inner: Arc<Mutex<SimClientInner>>,
    /// Socket shared with the sender side so `send_control` can reuse the
    /// bound port (or any available local port when the receiver hasn't bound
    /// yet).
    send_socket: Arc<UdpSocket>,
    ctrl_addr: Arc<Mutex<SocketAddr>>,
    configured_ctrl_addr: Arc<Mutex<SocketAddr>>,
}

struct SimClientInner {
    /// Most recent UDP payload, including auxiliary frames such as task_top.
    latest: Option<Value>,
    /// Most recent complete visual telemetry frame.  Only these packets carry
    /// the JSBSim lifecycle state; auxiliary packets must not overwrite it.
    latest_sim_status: Option<Value>,
    /// Complete property snapshots per aircraft. The ordinary toolbar keeps
    /// its single-aircraft status; the fleet page reads this separate store.
    instance_frames: HashMap<u8, (Value, Instant)>,
    last_visual_status_time: Option<Instant>,
    active_load_id: Option<u32>,
    latest_load_diagnostic: Option<Value>,
    diagnostic_protocol: bool,
    /// Most recent task statistics packet.  Keep it separately because a
    /// lifecycle frame may arrive immediately afterwards and must not make
    /// the toolbar CPU indicator disappear.
    latest_task_top: Option<Value>,
    latest_flight_controller: Option<Value>,
    last_flight_controller_time: Option<Instant>,
    /// Receipt time of the latest CPU/RAM/FDM health frame, excluding task
    /// table slices which can arrive even when live CPU samples have stopped.
    last_health_packet_time: Option<Instant>,
    /// Task-list slices are assembled by generation before being exposed to
    /// the UI. Metrics packets remain independent and cannot erase the list.
    task_list_assembler: TaskListAssembler,
    last_complete_task_list_time: Option<Instant>,
    /// The last lifecycle command issued by this editor.  It remains
    /// authoritative until another lifecycle command is issued; telemetry is
    /// observational and may arrive delayed or out of order over UDP.
    commanded_lifecycle_state: Option<String>,
    /// Local receipt time of the most recent strictly advancing JSBSim clock.
    /// It is independent evidence that the FDM is running, even if one
    /// lifecycle packet is delayed or stale after a bridge replacement.
    last_simulation_progress: Option<Instant>,
    last_simulation_timestamp: Option<f64>,
    connected: bool,
    last_packet_time: Instant,
    packets: u64,
}

#[derive(Default)]
struct TaskListAssembler {
    generation: Option<u64>,
    slots: Vec<Option<Value>>,
}

impl TaskListAssembler {
    /* A task table is sent in several UDP/USB packets.  Publishing the first
     * slice alone reports a healthy jsbsim task as dead until its slice
     * arrives.  Keep the previous complete table until every offset in the
     * new generation has been received. */
    fn push(&mut self, packet: &Value) -> Option<Vec<Value>> {
        let generation = packet.get("task_generation")?.as_u64()?;
        let offset = usize::try_from(packet.get("task_offset")?.as_u64()?).ok()?;
        let total = usize::try_from(packet.get("task_total")?.as_u64()?).ok()?;
        if total > 128 || offset > total { return None; }
        let tasks = packet.get("task_top")?.get("tasks")?.as_array()?;
        if tasks.len() > total - offset { return None; }
        if self.generation != Some(generation) {
            self.generation = Some(generation);
            self.slots = vec![None; total];
        }
        if self.slots.len() != total { return None; }
        for (index, task) in tasks.iter().enumerate() {
            self.slots[offset + index] = Some(task.clone());
        }
        if self.slots.iter().all(Option::is_some) {
            let complete: Vec<Value> = self.slots.iter().filter_map(Clone::clone).collect();
            let mut identities = std::collections::HashSet::new();
            for task in &complete {
                let identity = (task.get("pid")?.as_i64()?, task.get("name")?.as_str()?);
                if !identities.insert(identity) {
                    // Older firmware can reorder tasks between slices.  A
                    // duplicate means this generation may also omit jsbsim.
                    return None;
                }
            }
            return Some(complete);
        }
        None
    }
}

fn resolve_lifecycle_state(requested: Option<&str>, latest: Option<&Value>) -> Option<String> {
    requested.map(str::to_owned).or_else(|| {
        latest
            .and_then(|frame| frame.get("state"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

fn frame_instance_id(frame: &Value) -> Option<u8> {
    let value = frame.get("instance_id");
    let number = match value {
        None => 1, // Existing single-aircraft firmware.
        Some(Value::String(text)) => text.parse::<u8>().ok()?,
        Some(Value::Number(number)) => u8::try_from(number.as_u64()?).ok()?,
        _ => return None,
    };
    (1..=8).contains(&number).then_some(number)
}

fn merge_instance_frame(instances: &mut HashMap<u8, (Value, Instant)>, frame: &Value) {
    if frame.get("model").and_then(Value::as_str).is_none()
        || frame.get("state").and_then(Value::as_str).is_none() {
        return;
    }
    let Some(id) = frame_instance_id(frame) else { return };
    let now = Instant::now();
    let entry = instances.entry(id).or_insert_with(|| (json!({}), now));
    let changed_model = entry.0.get("model") != frame.get("model");
    let changed_tree = entry.0.get("tree_generation").is_some()
        && frame.get("tree_generation").is_some()
        && entry.0.get("tree_generation") != frame.get("tree_generation");
    if changed_model || changed_tree || frame.get("state").and_then(Value::as_str) == Some("fault") {
        entry.0 = json!({});
    }
    if let (Some(target), Some(source)) = (entry.0.as_object_mut(), frame.as_object()) {
        for (key, value) in source {
            if key == "properties" {
                let properties = target.entry("properties").or_insert_with(|| json!({}));
                if let (Some(existing), Some(incoming)) = (properties.as_object_mut(), value.as_object()) {
                    for (path, sample) in incoming { existing.insert(path.clone(), sample.clone()); }
                }
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
        target.insert("instance_id".into(), Value::String(format!("{id:02}")));
    }
    entry.1 = now;
}

fn jsbsim_task_alive(frame: Option<&Value>) -> Option<bool> {
    let top = frame?.get("task_top")?;
    let tasks = top.get("tasks")?.as_array()?;
    let present = tasks.iter().any(|task| {
        task.get("name").and_then(Value::as_str)
            .map(|name| name.eq_ignore_ascii_case("jsbsim") || name.to_ascii_lowercase().starts_with("jsbsim "))
            .unwrap_or(false)
    });
    if present { Some(true) }
    else if top.get("list_complete").and_then(Value::as_bool) == Some(true) { Some(false) }
    else { None }
}

fn combined_telemetry(
    latest: Option<&Value>,
    latest_sim_status: Option<&Value>,
    latest_task_top: Option<&Value>,
) -> Option<Value> {
    /* The receiver gets visual and task-top as separate UDP datagrams.  The
     * Tauri event loop samples at 30 Hz, so returning only the last datagram
     * can permanently miss a 10 Hz task-top stream depending on packet
     * phase after a model reload.  Always publish one coherent snapshot. */
    let mut snapshot = latest_sim_status.cloned().or_else(|| latest.cloned())?;
    if let (Some(object), Some(task_top)) = (
        snapshot.as_object_mut(),
        latest_task_top.and_then(|frame| frame.get("task_top")),
    ) {
        object.insert("task_top".to_owned(), task_top.clone());
    }
    Some(snapshot)
}

fn merge_task_top_packet(existing: &mut Option<Value>, incoming: &Value) {
    let mut frame = existing.take()
        .unwrap_or_else(|| json!({"kind":"task_top","task_top":{}}));
    if !frame.is_object() {
        frame = json!({"kind":"task_top","task_top":{}});
    }
    let Some(source) = incoming.get("task_top").and_then(Value::as_object) else {
        *existing = Some(frame);
        return;
    };
    let target = frame.as_object_mut().unwrap()
        .entry("task_top".to_owned())
        .or_insert_with(|| json!({}));
    if !target.is_object() {
        *target = json!({});
    }
    let target = target.as_object_mut().unwrap();
    for (key, value) in source {
        /* Compact 10 Hz health frames intentionally contain no task list.
         * If an older board sends an empty list, retain the independently
         * assembled 1 Hz table instead of flashing it blank. */
        if key == "tasks" && incoming.get("kind").and_then(Value::as_str) != Some("task_top_tasks")
            && value.as_array().is_some_and(Vec::is_empty)
            && target.get("tasks").and_then(Value::as_array)
                .is_some_and(|tasks| !tasks.is_empty())
        {
            continue;
        }
        target.insert(key.clone(), value.clone());
    }
    *existing = Some(frame);
}

// Compile-time assertion: SimClient must be Clone + Send + Sync for Tauri.
const _: fn() = || {
    fn _assert_clone_send_sync<T: Clone + Send + Sync>() {}
    _assert_clone_send_sync::<SimClient>();
};

// ── implementation ─────────────────────────────────────────────────────────

impl SimClient {
    fn control_addresses(&self) -> std::io::Result<(SocketAddr, Option<SocketAddr>)> {
        let learned = *self.ctrl_addr.lock()
            .map_err(|_| std::io::Error::other("control address lock"))?;
        let configured = *self.configured_ctrl_addr.lock()
            .map_err(|_| std::io::Error::other("configured control address lock"))?;
        let fallback = (configured != learned).then_some(configured);
        Ok((learned, fallback))
    }

    pub fn set_control_host(&self, host: std::net::Ipv4Addr) {
        if let Ok(mut configured) = self.configured_ctrl_addr.lock() {
            let address = SocketAddr::new(host.into(), configured.port());
            *configured = address;
            if let Ok(mut learned) = self.ctrl_addr.lock() { *learned = address; }
        }
    }

    fn send_to_control_addresses(&self, packet: &[u8]) -> std::io::Result<()> {
        let mode = crate::transport::mode();
        let mut last_error = None;

        /* Auto mode uses USB as the first complete transport.  Returning after
         * a successful write avoids sending START/LOAD twice to the board;
         * UDP remains a fallback when USB is absent or its endpoint fails. */
        if mode != crate::transport::TransportMode::Network {
            /* Lifecycle and actuator commands must not be discarded merely
             * because the receiver currently owns the vendor interface for
             * one short bulk-read timeout.  The periodic heartbeat below
             * has a shorter bounded wait; actual user commands such as
             * START or LOAD can wait through a console read. */
            match crate::usb_file::sim_write_control(packet) {
                Ok(()) => return Ok(()),
                Err(error) => last_error = Some(std::io::Error::other(error)),
            }
            if mode == crate::transport::TransportMode::Usb {
                return Err(last_error.unwrap_or_else(|| std::io::Error::other(
                    "USB simulator communication is unavailable")));
            }
        }

        if mode != crate::transport::TransportMode::Usb {
            match self.control_addresses() {
                Ok((learned, fallback)) => {
                    let mut sent = false;
                    match self.send_socket.send_to(packet, learned) {
                        Ok(_) => sent = true,
                        Err(error) => last_error = Some(error),
                    }
                    if let Some(fallback) = fallback {
                        match self.send_socket.send_to(packet, fallback) {
                            Ok(_) => sent = true,
                            Err(error) => last_error = Some(error),
                        }
                    }
                    if sent {
                        return Ok(());
                    }
                }
                Err(error) => last_error = Some(error),
            }
        }

        Err(last_error.unwrap_or_else(|| std::io::Error::other(
            "no simulator communication transport is available")))
    }

    /// Create a new `SimClient` and spawn background threads for receiving
    /// telemetry and connection-watchdog timing.
    ///
    /// * `listen_port` – UDP port to bind for incoming telemetry (default 5801).
    ///   Control frames are sent back to `127.0.0.1:5802`.
    pub fn new(listen_port: u16) -> Self {
        let ctrl_port = std::env::var("SIM_UDP_CTRL_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(DEFAULT_CTRL_PORT);
        let ctrl_host = crate::transport::network_host()
            .map(|host| host.to_string())
            .unwrap_or_else(|| DEFAULT_CTRL_HOST.to_string());
        let initial_ctrl_addr: SocketAddr = format!("{}:{}", ctrl_host, ctrl_port)
            .parse()
            .expect("invalid ctrl address");

        // Bind the receiving socket.  0.0.0.0 so the sim can push from any
        // interface; OS picks an ephemeral send socket below.
        let recv_socket = UdpSocket::bind(format!("0.0.0.0:{}", listen_port))
            .unwrap_or_else(|e| panic!("SimClient: bind 0.0.0.0:{} failed: {}", listen_port, e));
        recv_socket
            .set_nonblocking(true)
            .expect("set_nonblocking");

        // Send control from the same bound UDP endpoint that receives
        // telemetry.  The bridge is rebuilt when a model/script is started
        // again and associates its peer with the packet source.  An
        // ephemeral sending socket made that association differ from the
        // desktop's telemetry endpoint (5801), which could leave lifecycle
        // commands/ACKs detached after the second start.
        let send_socket = Arc::new(
            recv_socket.try_clone().expect("SimClient: clone telemetry socket"),
        );

        let ctrl_addr = Arc::new(Mutex::new(initial_ctrl_addr));
        let configured_ctrl_addr = Arc::new(Mutex::new(initial_ctrl_addr));
        let inner = Arc::new(Mutex::new(SimClientInner {
                latest: None,
                latest_sim_status: None,
                instance_frames: HashMap::new(),
                last_visual_status_time: None,
                active_load_id: None,
                latest_load_diagnostic: None,
                diagnostic_protocol: false,
                latest_task_top: None,
                latest_flight_controller: None,
                last_flight_controller_time: None,
                last_health_packet_time: None,
                task_list_assembler: TaskListAssembler::default(),
                last_complete_task_list_time: None,
                commanded_lifecycle_state: None,
                last_simulation_progress: None,
                last_simulation_timestamp: None,
                connected: false,
            last_packet_time: Instant::now(),
            packets: 0,
        }));

        // ── receiver thread ───────────────────────────────────────────
        {
            let inner = Arc::clone(&inner);
            let telemetry_ctrl_addr = Arc::clone(&ctrl_addr);
            let telemetry_configured_addr = Arc::clone(&configured_ctrl_addr);
            let sock = recv_socket;
            std::thread::Builder::new()
                .name("sim-client-recv".into())
                .spawn(move || {
                    let mut buf = [0u8; 8192];
                    loop {
                        match sock.recv_from(&mut buf) {
                            Ok((n, peer)) => {
                                if !peer.ip().is_loopback() &&
                                    !crate::transport::allows_network()
                                {
                                    continue;
                                }
                                if let Ok(text) = std::str::from_utf8(&buf[..n]) {
                                    if let Ok(val) = serde_json::from_str::<Value>(text) {
                                        if val.is_object() {
                                            crate::telemetry_recorder::global().record(&peer.to_string(), &val);
                                            crate::plotjuggler::submit(&buf[..n]);
                                            /* Telemetry is authoritative proof of which board is
                                             * connected.  Route subsequent control packets to its
                                             * source IP: discovery packets or an outdated setting
                                             * must never leave the UI receiving telemetry from one
                                             * target while controlling another. */
                                            if !peer.ip().is_loopback() {
                                              if let Ok(mut address) = telemetry_ctrl_addr.lock() {
                                                *address = SocketAddr::new(peer.ip(), ctrl_port);
                                              }
                                              if let Ok(mut address) = telemetry_configured_addr.lock() {
                                                *address = SocketAddr::new(peer.ip(), ctrl_port);
                                              }
                                            }
                                            let mut state = inner.lock().unwrap();
                                            let xml_diagnostic = val.get("kind").and_then(Value::as_str) == Some("xml_diagnostic");
                                            let flight_controller = val.get("kind").and_then(Value::as_str) == Some("flight_controller");
                                            if flight_controller {
                                                state.latest_flight_controller = Some(val.clone());
                                                state.last_flight_controller_time = Some(Instant::now());
                                            }
                                            if xml_diagnostic {
                                                state.diagnostic_protocol = true;
                                                if val.get("request_id").and_then(Value::as_u64) == state.active_load_id.map(u64::from) {
                                                    state.latest_load_diagnostic = Some(val.clone());
                                                }
                                            }
                                            let heartbeat = val.get("kind")
                                                .and_then(Value::as_str) == Some("heartbeat");
                                            if heartbeat {
                                                state.diagnostic_protocol = val.get("xml_diagnostics")
                                                    .and_then(Value::as_u64) == Some(1);
                                            }
                                            // Existing single-aircraft controls continue to
                                            // describe 01 when other instance frames arrive.
                                            let primary_frame = val.get("model").is_none()
                                                || frame_instance_id(&val) == Some(1);
                                            if let Some(remote_state) = val.get("state").and_then(Value::as_str).filter(|_| primary_frame) {
                                                let control_ack = val.get("kind")
                                                    .and_then(Value::as_str) == Some("control_ack");
                                                if control_ack || heartbeat {
                                                    // ACK/heartbeat frames contain lifecycle state
                                                    // but no model payload. Merge the state into the
                                                    // visual frame so model and timestamp survive.
                                                    if let Some(status) = state.latest_sim_status.as_mut()
                                                        .and_then(Value::as_object_mut)
                                                    {
                                                        status.insert("state".to_owned(), Value::String(remote_state.to_owned()));
                                                        if heartbeat {
                                                            if let Some(wall_time) = val.get("wall_time_s") {
                                                                status.insert("wall_time_s".to_owned(), wall_time.clone());
                                                            }
                                                        }
                                                    } else {
                                                        state.latest_sim_status = Some(val.clone());
                                                    }
                                                } else {
                                                    state.latest_sim_status = Some(val.clone());
                                                    if val.get("latitude_deg").and_then(Value::as_f64).is_some()
                                                        && val.get("longitude_deg").and_then(Value::as_f64).is_some()
                                                        && val.get("altitude_m").and_then(Value::as_f64).is_some()
                                                    {
                                                        state.last_visual_status_time = Some(Instant::now());
                                                    }
                                                }
                                                /* Only a matching board state acknowledges a
                                                 * lifecycle request.  During LOAD/restart the old
                                                 * FDM can publish one final `stopped` frame after
                                                 * START was sent; clearing a pending `running`
                                                 * request on that stale frame made the toolbar
                                                 * flash back to Start immediately. */
                                                let acknowledged = state.commanded_lifecycle_state
                                                    .as_deref()
                                                    .map(|requested| requested == remote_state)
                                                    .unwrap_or(false);
                                                if acknowledged {
                                                    state.commanded_lifecycle_state = None;
                                                }
                                            }
                                            if let Some(timestamp) = val.get("timestamp").and_then(Value::as_f64).filter(|_| primary_frame) {
                                                match state.last_simulation_timestamp {
                                                    Some(previous) if timestamp > previous + 1e-6 => {
                                                        state.last_simulation_progress = Some(Instant::now());
                                                    }
                                                    /* A reload restarts JSBSim time at zero.  Accept
                                                     * the new baseline; the next advancing frame will
                                                     * prove the replacement FDM is running. */
                                                    Some(previous) if timestamp + 1e-6 < previous => {
                                                        state.last_simulation_timestamp = Some(timestamp);
                                                    }
                                                    None => state.last_simulation_timestamp = Some(timestamp),
                                                    _ => {}
                                                }
                                                if state.last_simulation_timestamp
                                                    .map(|previous| timestamp > previous)
                                                    .unwrap_or(false)
                                                {
                                                    state.last_simulation_timestamp = Some(timestamp);
                                                }
                                            }
                                            if val.get("task_top").is_some() {
                                                if val.get("kind").and_then(Value::as_str) == Some("task_top")
                                                    && val.get("task_top").and_then(|top| top.get("cpu_cores")).is_some()
                                                {
                                                    state.last_health_packet_time = Some(Instant::now());
                                                }
                                                let task_slice = val.get("kind")
                                                    .and_then(Value::as_str) == Some("task_top_tasks");
                                                if task_slice {
                                                    if let Some(tasks) = state.task_list_assembler.push(&val) {
                                                        let assembled = json!({
                                                            "kind":"task_top_tasks",
                                                            "task_top":{
                                                                "tasks":tasks,
                                                                "list_complete":val.get("task_complete")
                                                                    .and_then(Value::as_bool).unwrap_or(false)
                                                            }
                                                        });
                                                        merge_task_top_packet(
                                                            &mut state.latest_task_top, &assembled);
                                                        state.last_complete_task_list_time = Some(Instant::now());
                                                    }
                                                } else {
                                                    merge_task_top_packet(
                                                        &mut state.latest_task_top, &val);
                                                }
                                            }
                                            merge_instance_frame(&mut state.instance_frames, &val);
                                            /* Heartbeat acknowledgements prove board reachability
                                             * but carry no model data and must not replace the
                                             * latest visual/task snapshot. */
                                            if !heartbeat && !xml_diagnostic && !flight_controller && primary_frame {
                                                state.latest = Some(val);
                                            }
                                            state.connected = true;
                                            state.last_packet_time = Instant::now();
                                            state.packets += 1;
                                        }
                                    }
                                }
                                // Non-UTF8 / non-JSON / non-object → silently drop
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                // No data right now — sleep briefly then check
                                // the disconnect timeout ourselves so we don't
                                // need a second thread just for watchdog.
                                std::thread::sleep(Duration::from_millis(50));

                                let mut state = inner.lock().unwrap();
                                if state.connected
                                    && state.last_packet_time.elapsed() > DISCONNECT_TIMEOUT
                                {
                                    state.connected = false;
                                }
                            }
                            Err(_) => {
                                std::thread::sleep(Duration::from_millis(100));
                            }
                        }
                    }
                })
                .expect("spawn recv thread");
        }

        /* Feed USB telemetry into the same parser as UDP.  Loopback packets
         * are deliberately excluded from UDP peer learning above, so the
         * Ethernet control fallback keeps the configured board address. */
        {
            std::thread::Builder::new()
                .name("sim-client-usb".into())
                .spawn(move || {
                    let injector = UdpSocket::bind("127.0.0.1:0")
                        .expect("SimClient: bind USB telemetry injector");
                    let destination = format!("127.0.0.1:{listen_port}");
                    loop {
                        if !crate::transport::allows_usb() {
                            std::thread::sleep(Duration::from_millis(200));
                            continue;
                        }
                        match crate::usb_file::sim_read() {
                            Ok(Some(packet)) => { let _ = injector.send_to(&packet, &destination); }
                            /* sim_read holds the shared libusb interface for
                             * one short bulk-read timeout.  Yield before the
                             * next probe so the heartbeat writer can claim
                             * it after a hot-plug; without this, the reader
                             * could repeatedly reacquire the lock and the
                             * board would receive only the first heartbeat. */
                            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                            Err(_) => std::thread::sleep(Duration::from_millis(200)),
                        }
                    }
                })
                .expect("spawn USB receiver thread");
        }

        // Discovery is deliberately separate from telemetry so the editor can
        // find a board without asking the user for its IP address.
        {
            let discovery = UdpSocket::bind(format!("0.0.0.0:{}", DISCOVERY_PORT))
                .expect("SimClient: discovery bind failed");
            discovery.set_broadcast(true).expect("enable discovery broadcast");
            discovery.set_nonblocking(true).expect("discovery nonblocking");
            let discovered_ctrl = Arc::clone(&ctrl_addr);
            let discovered_configured = Arc::clone(&configured_ctrl_addr);
            let discovery_inner = Arc::clone(&inner);
            let discover_send = discovery.try_clone().expect("clone discovery socket");
            std::thread::Builder::new()
                .name("sim-client-discovery".into())
                .spawn(move || {
                    let mut buf = [0u8; 128];
                    let mut last_neighbor_probe = Instant::now() - Duration::from_secs(5);
                    loop {
                        if !crate::transport::allows_network() {
                            std::thread::sleep(Duration::from_secs(1));
                            continue;
                        }
                        let _ = discover_send.send_to(b"JSBSIM-DISCOVER", format!("255.255.255.255:{}", DISCOVERY_PORT));
                        if std::env::var("SIM_UDP_HOST").is_err() &&
                            last_neighbor_probe.elapsed() >= Duration::from_secs(5) &&
                            discovery_inner.lock().is_ok_and(|state| !state.connected) {
                            last_neighbor_probe = Instant::now();
                            if let Some(host) = crate::network_discovery::discover(
                                crate::transport::network_host_override()) {
                                if let Ok(mut addr) = discovered_ctrl.lock() {
                                    *addr = SocketAddr::new(host.into(), ctrl_port);
                                }
                                if let Ok(mut addr) = discovered_configured.lock() {
                                    *addr = SocketAddr::new(host.into(), ctrl_port);
                                }
                                crate::transport::set_network_host_override(host);
                            }
                        }
                        let deadline = Instant::now() + Duration::from_millis(800);
                        while Instant::now() < deadline {
                            match discovery.recv_from(&mut buf) {
                                Ok((n, peer)) if &buf[..n] == b"JSBSIM-HERE" => {
                                    if let std::net::IpAddr::V4(host) = peer.ip() {
                                      if crate::network_discovery::verify(host) {
                                        if let Ok(mut addr) = discovered_ctrl.lock() {
                                            *addr = SocketAddr::new(host.into(), ctrl_port);
                                        }
                                        if let Ok(mut addr) = discovered_configured.lock() {
                                            *addr = SocketAddr::new(host.into(), ctrl_port);
                                        }
                                        crate::transport::set_network_host_override(host);
                                      }
                                    }
                                }
                                Ok(_) => {}
                                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                    std::thread::sleep(Duration::from_millis(25));
                                }
                                Err(_) => break,
                            }
                        }
                        std::thread::sleep(Duration::from_millis(200));
                    }
                })
                .expect("spawn discovery thread");
        }

        // Register this editor as the telemetry consumer.  The NuttX bridge
        // learns our current IP from these packets and does not transmit to a
        // closed UDP port before the editor is present.
        {
            let sock = Arc::clone(&send_socket);
            let heartbeat_addr = Arc::clone(&ctrl_addr);
            std::thread::Builder::new()
                .name("sim-client-heartbeat".into())
                .spawn(move || loop {
                    let packet = [b'V', b'C', b'M', b'D', 7u8];
                    if crate::transport::allows_usb() {
                        /* The USB receiver owns the interface during each
                         * 100 ms read. Heartbeats wait up to 250 ms for it,
                         * independently of the EP3 file/NSH response lock. */
                        let _ = crate::usb_file::sim_write_control(&packet);
                    }
                    if crate::transport::allows_network() {
                        let addr = heartbeat_addr.lock().map(|a| *a).ok();
                        if let Some(addr) = addr { let _ = sock.send_to(&packet, addr); }
                    }
                    std::thread::sleep(Duration::from_secs(1));
                })
                .expect("spawn heartbeat thread");
        }

        Self {
            inner,
            send_socket,
            ctrl_addr,
            configured_ctrl_addr,
        }
    }

    /// `true` when a telemetry packet has been received within the last 2 s.
    pub fn is_connected(&self) -> bool {
        self.inner.lock().unwrap().connected
    }

    /// Coherent visual telemetry plus the latest independently received task
    /// statistics, or `None` before the first packet.
    pub fn latest(&self) -> Option<Value> {
        let state = self.inner.lock().unwrap();
        combined_telemetry(
            state.latest.as_ref(),
            state.latest_sim_status.as_ref(),
            state.latest_task_top.as_ref(),
        )
    }

    /// Latest packet which explicitly reports `running` / `paused` /
    /// `stopped`.  Do not derive lifecycle state from task-statistics or
    /// other auxiliary UDP frames.
    pub fn latest_sim_status(&self) -> Option<Value> {
        self.inner.lock().unwrap().latest_sim_status.clone()
    }

    pub fn instance_summaries(&self) -> Vec<Value> {
        let state = self.inner.lock().unwrap();
        let mut result: Vec<Value> = state.instance_frames.iter().map(|(id, (frame, seen))| {
            let mut fields = frame.as_object().map_or_else(serde_json::Map::new, |object| {
                object.iter()
                    .filter(|(key, _)| key.as_str() != "properties")
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            });
            let property_count = frame.get("properties")
                .and_then(Value::as_object).map_or(0, |properties| properties.len());
            fields.insert("property_count".into(), json!(property_count));
            fields.insert("instance_id".into(), json!(format!("{id:02}")));
            fields.insert("age_ms".into(), json!(seen.elapsed().as_millis().min(u128::from(u32::MAX))));
            Value::Object(fields)
        }).collect();
        result.sort_by(|a, b| a["instance_id"].as_str().cmp(&b["instance_id"].as_str()));
        result
    }

    pub fn instance_snapshot(&self, id: u8) -> Option<Value> {
        if !(1..=8).contains(&id) { return None; }
        let state = self.inner.lock().unwrap();
        let (frame, seen) = state.instance_frames.get(&id)?;
        let mut snapshot = frame.clone();
        snapshot["age_ms"] = json!(seen.elapsed().as_millis().min(u128::from(u32::MAX)));
        Some(snapshot)
    }

    pub fn latest_visual_status_fresh(&self, max_age: Duration) -> Option<Value> {
        let state = self.inner.lock().unwrap();
        state.last_visual_status_time.filter(|time| time.elapsed() <= max_age)?;
        state.latest_sim_status.as_ref().filter(|status|
            status.get("latitude_deg").and_then(Value::as_f64).is_some()
            && status.get("longitude_deg").and_then(Value::as_f64).is_some()
            && status.get("altitude_m").and_then(Value::as_f64).is_some()
        ).cloned()
    }

    pub fn request_lifecycle_state(&self, requested: &str) {
        let mut state = self.inner.lock().unwrap();
        state.commanded_lifecycle_state = Some(requested.to_owned());
        /* A command must be acknowledged by a new lifecycle frame.  Keeping
         * the previous `running` frame made STOP -> START succeed instantly
         * even when the stopped FDM never resumed. */
        state.latest_sim_status = None;
    }

    /// Drop an unacknowledged optimistic lifecycle request.  This is used
    /// after a command timeout so status polling exposes the board's real
    /// state instead of continuing to display the requested state locally.
    pub fn clear_lifecycle_request(&self, requested: &str) {
        let mut state = self.inner.lock().unwrap();
        if state.commanded_lifecycle_state.as_deref() == Some(requested) {
            state.commanded_lifecycle_state = None;
        }
    }

    pub fn lifecycle_state(&self) -> Option<String> {
        let state = self.inner.lock().unwrap();
        resolve_lifecycle_state(
            state.commanded_lifecycle_state.as_deref(),
            state.latest_sim_status.as_ref(),
        )
    }

    /// Total number of telemetry packets received since startup.
    pub fn packet_count(&self) -> u64 {
        self.inner.lock().unwrap().packets
    }

    /// Age of the latest live performance sample, independent of heartbeat
    /// and task-list packets that can keep the transport connected.
    pub fn health_packet_age_ms(&self) -> Option<u64> {
        self.inner.lock().unwrap().last_health_packet_time
            .map(|at| at.elapsed().as_millis().min(u64::MAX as u128) as u64)
    }

    pub fn flight_controller_status(&self) -> Option<Value> {
        let state = self.inner.lock().unwrap();
        crate::flight_controller_status::snapshot(
            state.latest_flight_controller.as_ref(),
            state.last_flight_controller_time.map(|at| at.elapsed()),
        )
    }

    /// Whether the reported JSBSim simulation clock advanced in the recent
    /// past.  This is more trustworthy than a stale lifecycle label.
    pub fn simulation_is_advancing(&self) -> bool {
        self.inner.lock().unwrap().last_simulation_progress
            .map(|at| at.elapsed() < Duration::from_secs(2))
            .unwrap_or(false)
    }

    /// `Some(false)` requires a fresh, explicitly complete task list without
    /// JSBSim. Older firmware sends only its top 12 tasks, so absence there
    /// is unknown rather than evidence of an exited bridge.
    pub fn jsbsim_task_alive(&self) -> Option<bool> {
        let state = self.inner.lock().unwrap();
        if !state.last_complete_task_list_time
            .is_some_and(|when| when.elapsed() < Duration::from_secs(3)) {
            return None;
        }
        jsbsim_task_alive(state.latest_task_top.as_ref())
    }

    /// CPU percentage consumed by the JSBSim task in the latest NuttX top
    /// snapshot.  This remains available between 1 Hz task-stat packets.
    pub fn jsbsim_cpu_load(&self) -> Option<f64> {
        let state = self.inner.lock().unwrap();
        state.latest_task_top.as_ref()?
            .get("task_top")?.get("tasks")?.as_array()?
            .iter()
            .find(|task| task.get("name").and_then(Value::as_str)
                .map(|name| name.to_ascii_lowercase().starts_with("jsbsim"))
                .unwrap_or(false))?
            .get("load")?.as_f64()
    }

    /// Per-core busy percentage calculated by the board's SMP counters.
    /// The task list uses a decaying average while this field measures a
    /// recent interval, so prefer the board's explicit per-core readings.
    pub fn cpu_core_loads(&self) -> Option<Vec<f64>> {
        let state = self.inner.lock().unwrap();
        let task_top = state.latest_task_top.as_ref()?.get("task_top")?;
        let cores = task_top.get("cpu_cores")?.as_array()?;
        let values: Vec<f64> = cores.iter().map(Value::as_f64).collect::<Option<_>>()?;
        (!values.is_empty() && values.iter().all(|value| value.is_finite() &&
            (0.0..=100.0).contains(value))).then_some(values)
    }

    /// Current NuttX user-heap usage reported alongside the task snapshot.
    pub fn memory_usage(&self) -> Option<Value> {
        let state = self.inner.lock().unwrap();
        state.latest_task_top.as_ref()?
            .get("task_top")?.get("memory").cloned()
    }

    /// Cumulative byte counters for the board's Ethernet interfaces.
    pub fn network_counters(&self) -> Option<Value> {
        let state = self.inner.lock().unwrap();
        state.latest_task_top.as_ref()?
            .get("task_top")?.get("network").cloned()
    }

    /// Current board MCAP recorder snapshot from the task_top health packet.
    pub fn mcap_status(&self) -> Option<Value> {
        let state = self.inner.lock().unwrap();
        state.latest_task_top.as_ref()?
            .get("task_top")?.get("mcap").cloned()
    }

    /// Wall-clock execution time of the most recent FGFDMExec::Run call.
    pub fn fdm_run_ms(&self) -> Option<f64> {
        let state = self.inner.lock().unwrap();
        state.latest_task_top.as_ref()?
            .get("task_top")?.get("fdm_run_ms")?.as_f64()
    }

    /// Board-side window statistics; older firmware may omit these fields.
    pub fn fdm_window_stats(&self) -> Option<Value> {
        let state = self.inner.lock().unwrap();
        let top = state.latest_task_top.as_ref()?.get("task_top")?;
        Some(serde_json::json!({
            "averageMs": top.get("fdm_avg_ms")?,
            "maxMs": top.get("fdm_max_ms")?,
            "samples": top.get("fdm_samples")?,
            "sequence": top.get("fdm_seq"),
            "coreMs": top.get("fdm_core_ms"),
            "ioMs": top.get("fdm_io_ms"),
            "captureMs": top.get("fdm_capture_ms"),
            "workMs": top.get("fdm_work_ms"),
            "periodMs": top.get("fdm_period_ms"),
            "realtimeFactor": top.get("fdm_rtf"),
            "overruns": top.get("fdm_overruns"),
            "windowMs": top.get("fdm_window_ms"),
        }))
    }

    /// Effective JSBSim integration step reported by the running FDM.
    pub fn simulation_dt(&self) -> Option<f64> {
        let state = self.inner.lock().unwrap();
        state.latest_task_top.as_ref()?
            .get("task_top")?.get("simulation_dt")?.as_f64()
    }

    /// Send a 72-byte VisControlFrame to the simulation host.
    ///
    /// Layout (little-endian):
    ///   `[0..4]`   magic  "VCTL"
    ///   `[4]`      override flag (1 = take over actuators, 0 = release)
    ///   `[5..8]`   padding (zero)
    ///   `[8..72]`  16 × f32 channel values (normalised actuator commands)
    pub fn send_control(&self, override_flag: bool, channels: &[f32]) -> std::io::Result<()> {
        let mut buf = [0u8; 72];

        // magic
        buf[0..4].copy_from_slice(b"VCTL");
        // override flag
        buf[4] = if override_flag { 1 } else { 0 };
        // buf[5..8] already zero (padding)

        // 16 × f32 channels (little-endian on all Tauri target platforms)
        for (i, &ch) in channels.iter().take(16).enumerate() {
            let offset = 8 + i * 4;
            buf[offset..offset + 4].copy_from_slice(&ch.to_le_bytes());
        }

        self.send_to_control_addresses(&buf)
    }

    pub fn send_command(&self, command: u8) -> std::io::Result<()> {
        let packet = [b'V', b'C', b'M', b'D', command];
        self.send_to_control_addresses(&packet)
    }

    /// VCMD 10 controls one Ethernet HIL instance. The board acknowledges
    /// queueing separately; telemetry confirms whether the model loaded.
    pub fn send_instance_command(&self, id: u8, action: u8, model: Option<&str>,
                                 host: Option<&str>, port: Option<u16>, initial: Option<&InstanceInitial>,
                                 network: Option<&InstanceNetwork>) -> std::io::Result<()> {
        let packet = instance_command_packet(id, action, model, host, port, initial, network)?;
        self.send_to_control_addresses(&packet)
    }

    /// Send a lifecycle command using the bridge's state acknowledgement as a
    /// handshake.  Retransmit only when the acknowledgement has not arrived
    /// by the next polling deadline; never send a fixed burst of copies.
    pub fn send_lifecycle_command(&self, command: u8, expected: &str, timeout: Duration) -> std::io::Result<()> {
        let packet = lifecycle_packet(command);
        eprintln!("[sim-control] VCMD {} via {}", command,
                  crate::transport::mode().as_str());
        let deadline = Instant::now() + timeout;
        loop {
            self.send_to_control_addresses(&packet)?;
            if self.wait_for_lifecycle_state(expected, Duration::from_millis(100))
                || Instant::now() >= deadline { break; }
        }
        Ok(())
    }

    /// Request a bridge restart.  The request identifier makes a retransmit
    /// idempotent across the old and replacement NuttX bridge tasks.
    pub fn send_restart(&self) -> std::io::Result<u32> {
        let request = crate::load_diagnostics::request_id();
        let mut packet = [0u8; 9];
        packet[0..4].copy_from_slice(b"VCMD");
        packet[4] = 6; // VCMD_RESTART
        packet[5..9].copy_from_slice(&request.to_le_bytes());

        {
            let mut state = self.inner.lock().unwrap();
            state.active_load_id = Some(request);
            state.latest_load_diagnostic = None;
            state.latest_sim_status = None;
            state.last_visual_status_time = None;
        }

        self.send_to_control_addresses(&packet)?;
        Ok(request)
    }

    /// Synchronize NuttX realtime clock only when telemetry reports a
    /// difference larger than the configured threshold.
    pub fn sync_clock_now(&self) -> std::io::Result<u64> {
        let local = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|e| std::io::Error::other(e.to_string()))?.as_secs();
        self.send_clock_value(local)?;
        // Give the bridge communication task a full set of polling cycles to
        // apply CLOCK_REALTIME before a following LOAD starts MCAP.
        std::thread::sleep(Duration::from_millis(100));
        Ok(local)
    }

    fn send_clock_value(&self, local: u64) -> std::io::Result<()> {
        let mut packet = [0u8; 13];
        packet[0..4].copy_from_slice(b"VCMD");
        packet[4] = 9; // VCMD_SET_WALL_CLOCK
        packet[5..13].copy_from_slice(&local.to_le_bytes());
        self.send_to_control_addresses(&packet)?;
        Ok(())
    }

    pub fn sync_clock_if_needed(&self, threshold_secs: u64) -> std::io::Result<Option<i64>> {
        let remote = self.latest_sim_status()
            .and_then(|value| value.get("wall_time_s").and_then(Value::as_u64));
        let Some(remote) = remote else { return Ok(None); };
        let local = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|e| std::io::Error::other(e.to_string()))?.as_secs();
        let difference = local as i128 - remote as i128;
        if difference.unsigned_abs() <= threshold_secs as u128 { return Ok(Some(0)); }
        self.send_clock_value(local)?;
        Ok(Some(difference.clamp(i64::MIN as i128, i64::MAX as i128) as i64))
    }

    /// Request a model reload.  The NuttX bridge accepts a basename only.
    fn send_xml_load(&self, command: u8, payload: &str) -> std::io::Result<u32> {
        let request = crate::load_diagnostics::request_id();
        let packet = crate::load_diagnostics::packet(command, payload, request)?;
        {
            let mut state = self.inner.lock().unwrap();
            state.active_load_id = Some(request);
            state.latest_load_diagnostic = None;
            state.latest_sim_status = None;
            state.last_visual_status_time = None;
        }
        self.send_to_control_addresses(&packet)?;
        Ok(request)
    }

    pub fn send_load(&self, model: &str) -> std::io::Result<u32> {
        self.send_xml_load(5, model_basename(model))
    }

    pub fn send_load_script(&self, script: &str, model: &str) -> std::io::Result<u32> {
        let script = script.rsplit('/').next().unwrap_or(script);
        self.send_xml_load(8, &format!("{}|{}", script, model_basename(model)))
    }

    /// New firmware echoes this request's result; old firmware retains the
    /// existing visual-state handshake. A diagnostic never replaces telemetry.
    pub fn wait_for_running_model(&self, model: &str, request: u32, timeout: Duration) -> Result<bool, String> {
        let expected = model_basename(model);
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            {
                let state = self.inner.lock().unwrap();
                if let Some(value) = state.latest_load_diagnostic.as_ref() {
                    if let Some(result) = crate::load_diagnostics::outcome(value, request, expected) {
                        return result.map(|()| true);
                    }
                }
                if !state.diagnostic_protocol && state.latest_sim_status.as_ref().is_some_and(|frame|
                    frame.get("state").and_then(Value::as_str) == Some("running") &&
                    (expected.is_empty() || frame.get("model").and_then(Value::as_str) == Some(expected))) {
                    return Ok(true);
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(false)
    }

    /// Wait for a fresh lifecycle telemetry acknowledgement from the bridge.
    pub fn wait_for_lifecycle_state(&self, expected: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let confirmed = self.latest_sim_status().map(|frame| {
                frame.get("state").and_then(Value::as_str) == Some(expected)
            }).unwrap_or(false);
            if confirmed {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_start_carries_independent_initial_override() {
        let initial = InstanceInitial { latitude_deg: 47.0, longitude_deg: 8.0,
            altitude_m: 0.0, roll_deg: -3.0, pitch_deg: 2.0, yaw_deg: 90.0 };
        let packet = instance_command_packet(2, 1, Some("F450"), None, None, Some(&initial), None).unwrap();
        assert_eq!(&packet[..7], b"VCMD\x0a\x02\x01");
        assert_eq!(&packet[7..], b"F450|||47,8,0,-3,2,90");
        assert_eq!(&instance_command_packet(2, 1, Some("F450"), None, None, None, None).unwrap()[7..], b"F450");
        assert!(instance_command_packet(2, 1, Some("F450"), None, None,
            Some(&InstanceInitial { latitude_deg: 91.0, ..initial }), None).is_err());
        let network = InstanceNetwork {
            input: Some(InstanceNetworkEndpoint { ip: "0.0.0.0".into(), port: "14561".into() }),
            sensor: Some(InstanceNetworkEndpoint { ip: "192.168.3.101".into(), port: "14560".into() }),
            gps: Some(InstanceNetworkEndpoint { ip: "192.168.3.102".into(), port: "14570".into() }),
        };
        let packet = instance_command_packet(2, 1, Some("F450"), None, None, Some(&initial), Some(&network)).unwrap();
        assert_eq!(&packet[7..], b"F450|||47,8,0,-3,2,90|0.0.0.0,14561,192.168.3.101,14560,192.168.3.102,14570");
    }

    #[test]
    fn instance_slices_remain_isolated_and_reset_on_model_change() {
        let mut instances = HashMap::new();
        merge_instance_frame(&mut instances, &json!({"instance_id":"01", "model":"H7", "state":"running", "tree_generation":1, "properties":{"/01/jsbsim/fcs/a":1}}));
        merge_instance_frame(&mut instances, &json!({"instance_id":"02", "model":"F450", "state":"running", "tree_generation":1, "properties":{"/02/jsbsim/fcs/a":2}}));
        merge_instance_frame(&mut instances, &json!({"instance_id":"01", "model":"H7", "state":"running", "tree_generation":1, "properties":{"/01/jsbsim/fcs/b":3}}));
        assert_eq!(instances[&1].0["properties"].as_object().unwrap().len(), 2);
        assert_eq!(instances[&2].0["properties"].as_object().unwrap().len(), 1);
        merge_instance_frame(&mut instances, &json!({"instance_id":"01", "model":"C172", "state":"running", "tree_generation":2, "properties":{"/01/jsbsim/fcs/c":4}}));
        assert_eq!(instances[&1].0["properties"].as_object().unwrap().len(), 1);
        assert!(instances[&1].0["properties"].get("/01/jsbsim/fcs/a").is_none());
        assert_eq!(instances[&2].0["model"], "F450");
    }

    #[test]
    fn stop_command_uses_bridge_lifecycle_protocol() {
        assert_eq!(lifecycle_packet(2), *b"VCMD\x02");
    }

    #[test]
    fn requested_stop_masks_delayed_running_telemetry() {
        let delayed_frame = serde_json::json!({ "state": "running" });
        assert_eq!(
            resolve_lifecycle_state(Some("stopped"), Some(&delayed_frame)),
            Some("stopped".to_owned())
        );
    }

    #[test]
    fn acknowledged_state_uses_latest_board_telemetry() {
        let acknowledged_frame = serde_json::json!({ "state": "stopped" });
        assert_eq!(
            resolve_lifecycle_state(None, Some(&acknowledged_frame)),
            Some("stopped".to_owned())
        );
    }

    #[test]
    fn task_snapshot_detects_jsbsim_exit() {
        let alive = serde_json::json!({"task_top":{"tasks":[{"name":"FTP_daemon"},{"name":"jsbsim"}]}});
        let crashed = serde_json::json!({"task_top":{"list_complete":true,"tasks":[{"name":"FTP_daemon"},{"name":"nsh_main"}]}});
        let truncated = serde_json::json!({"task_top":{"list_complete":false,"tasks":[{"name":"FTP_daemon"},{"name":"nsh_main"}]}});
        assert_eq!(jsbsim_task_alive(Some(&alive)), Some(true));
        assert_eq!(jsbsim_task_alive(Some(&crashed)), Some(false));
        assert_eq!(jsbsim_task_alive(Some(&truncated)), None);
        assert_eq!(jsbsim_task_alive(Some(&serde_json::json!({"state":"running"}))), None);
    }

    #[test]
    fn visual_snapshot_retains_independent_task_top_frame() {
        let visual = serde_json::json!({"state":"running","model":"F450","timestamp":9.6});
        let task_top = serde_json::json!({"kind":"task_top","task_top":{"tasks":[{"name":"jsbsim"}]}});
        let combined = combined_telemetry(Some(&visual), Some(&visual), Some(&task_top)).unwrap();
        assert_eq!(combined.get("state").and_then(Value::as_str), Some("running"));
        assert_eq!(
            combined.get("task_top").and_then(|value| value.get("tasks"))
                .and_then(Value::as_array).map(Vec::len),
            Some(1),
        );
    }

    #[test]
    fn health_packet_does_not_erase_assembled_task_list() {
        let mut stored = Some(serde_json::json!({
            "kind":"task_top_tasks",
            "task_top":{"tasks":[{"pid":8,"name":"jsbsim"}]}
        }));
        let health = serde_json::json!({
            "kind":"task_top",
            "task_top":{"fdm_run_ms":0.0,"cpu_cores":[55.4,0.0]}
        });
        merge_task_top_packet(&mut stored, &health);
        let top = stored.as_ref().unwrap().get("task_top").unwrap();
        assert_eq!(top.get("tasks").and_then(Value::as_array).map(Vec::len), Some(1));
        assert_eq!(top.get("cpu_cores").and_then(Value::as_array).map(Vec::len), Some(2));
    }

    #[test]
    fn task_list_is_published_only_after_all_slices_arrive() {
        let mut assembler = TaskListAssembler::default();
        let first = serde_json::json!({
            "kind":"task_top_tasks", "task_generation":7,
            "task_offset":0, "task_total":2,
            "task_top":{"tasks":[{"pid":1,"name":"nsh_main"}]}
        });
        let second = serde_json::json!({
            "kind":"task_top_tasks", "task_generation":7,
            "task_offset":1, "task_total":2,
            "task_top":{"tasks":[{"pid":10,"name":"jsbsim"}]}
        });
        assert!(assembler.push(&first).is_none());
        let complete = assembler.push(&second).unwrap();
        let packet = serde_json::json!({"task_top":{"tasks":complete}});
        assert_eq!(jsbsim_task_alive(Some(&packet)), Some(true));

        let next_first = serde_json::json!({
            "kind":"task_top_tasks", "task_generation":8,
            "task_offset":0, "task_total":2,
            "task_top":{"tasks":[{"pid":1,"name":"nsh_main"}]}
        });
        assert!(assembler.push(&next_first).is_none());
    }

    #[test]
    fn complete_empty_task_list_replaces_old_tasks() {
        let mut stored = Some(serde_json::json!({
            "kind":"task_top", "task_top":{"tasks":[{"pid":10,"name":"jsbsim"}]}
        }));
        let empty = serde_json::json!({
            "kind":"task_top_tasks", "task_top":{"list_complete":true,"tasks":[]}
        });
        merge_task_top_packet(&mut stored, &empty);
        assert_eq!(jsbsim_task_alive(stored.as_ref()), Some(false));
    }

    #[test]
    fn overlapping_slices_do_not_report_a_task_exit() {
        let mut assembler = TaskListAssembler::default();
        for offset in 0..2 {
            let packet = serde_json::json!({
                "kind":"task_top_tasks", "task_generation":9,
                "task_offset":offset, "task_total":2,
                "task_top":{"tasks":[{"pid":1,"name":"nsh_main"}]}
            });
            assert!(assembler.push(&packet).is_none());
        }
    }
}
