//! UDP simulation client — receives telemetry from JSBSim sim_server.
//!
//! Desktop simulation client:
//!   - Listens on a UDP port (default 5801) for JSON telemetry packets.
//!   - Stores the latest frame; marks disconnected after 2 s without packets.
//!   - Sends 72-byte VisControlFrame (magic "VCTL" + override + 16×f32) back
//!     to the simulation host.

use serde_json::{json, Value};
use std::net::{SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/* The external bridge normally runs on the i.MX board, while this editor
 * runs on the development PC.  Keep it configurable, but make the board
 * address the useful default instead of silently sending commands to the PC. */
const DEFAULT_CTRL_HOST: &str = "192.168.101.81";
const DEFAULT_CTRL_PORT: u16 = 5802;
const DISCOVERY_PORT: u16 = 5803;

fn model_basename(model: &str) -> &str {
    model.rsplit('/').next().unwrap_or(model).trim_end_matches(".xml")
}

fn lifecycle_packet(command: u8) -> [u8; 5] {
    [b'V', b'C', b'M', b'D', command]
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
    configured_ctrl_addr: SocketAddr,
}

struct SimClientInner {
    /// Most recent UDP payload, including auxiliary frames such as task_top.
    latest: Option<Value>,
    /// Most recent complete visual telemetry frame.  Only these packets carry
    /// the JSBSim lifecycle state; auxiliary packets must not overwrite it.
    latest_sim_status: Option<Value>,
    /// Most recent task statistics packet.  Keep it separately because a
    /// lifecycle frame may arrive immediately afterwards and must not make
    /// the toolbar CPU indicator disappear.
    latest_task_top: Option<Value>,
    /// Receipt time of the latest CPU/RAM/FDM health frame, excluding task
    /// table slices which can arrive even when live CPU samples have stopped.
    last_health_packet_time: Option<Instant>,
    /// Task-list slices are assembled by generation before being exposed to
    /// the UI. Metrics packets remain independent and cannot erase the list.
    task_list_generation: Option<u64>,
    task_list: Vec<Value>,
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

fn resolve_lifecycle_state(requested: Option<&str>, latest: Option<&Value>) -> Option<String> {
    requested.map(str::to_owned).or_else(|| {
        latest
            .and_then(|frame| frame.get("state"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

fn jsbsim_task_alive(frame: Option<&Value>) -> Option<bool> {
    let tasks = frame?
        .get("task_top")?
        .get("tasks")?
        .as_array()?;
    Some(tasks.iter().any(|task| {
        task.get("name").and_then(Value::as_str)
            .map(|name| name.eq_ignore_ascii_case("jsbsim") || name.to_ascii_lowercase().starts_with("jsbsim "))
            .unwrap_or(false)
    }))
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
        if key == "tasks" && value.as_array().is_some_and(Vec::is_empty)
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
        let fallback = (self.configured_ctrl_addr != learned)
            .then_some(self.configured_ctrl_addr);
        Ok((learned, fallback))
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
             * remains non-blocking; this bounded wait is only for an actual
             * user command such as START or LOAD. */
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
        let ctrl_host = std::env::var("SIM_UDP_HOST")
            .unwrap_or_else(|_| DEFAULT_CTRL_HOST.to_string());
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
        let inner = Arc::new(Mutex::new(SimClientInner {
                latest: None,
                latest_sim_status: None,
                latest_task_top: None,
                last_health_packet_time: None,
                task_list_generation: None,
                task_list: Vec::new(),
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
                                            }
                                            let mut state = inner.lock().unwrap();
                                            let heartbeat = val.get("kind")
                                                .and_then(Value::as_str) == Some("heartbeat");
                                            if let Some(remote_state) = val.get("state").and_then(Value::as_str) {
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
                                            if let Some(timestamp) = val.get("timestamp").and_then(Value::as_f64) {
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
                                                    let generation = val.get("task_generation")
                                                        .and_then(Value::as_u64).unwrap_or(0);
                                                    let offset = val.get("task_offset")
                                                        .and_then(Value::as_u64).unwrap_or(0);
                                                    if state.task_list_generation != Some(generation)
                                                        || offset == 0
                                                    {
                                                        state.task_list_generation = Some(generation);
                                                        state.task_list.clear();
                                                    }
                                                    if state.task_list_generation == Some(generation) {
                                                        if let Some(tasks) = val.get("task_top")
                                                            .and_then(|top| top.get("tasks"))
                                                            .and_then(Value::as_array)
                                                        {
                                                            for task in tasks {
                                                                let pid = task.get("pid").and_then(Value::as_i64);
                                                                if let Some(position) = state.task_list.iter().position(|old| {
                                                                    old.get("pid").and_then(Value::as_i64) == pid
                                                                }) {
                                                                    state.task_list[position] = task.clone();
                                                                } else {
                                                                    state.task_list.push(task.clone());
                                                                }
                                                            }
                                                        }
                                                        let assembled = json!({
                                                            "kind":"task_top_tasks",
                                                            "task_top":{"tasks":state.task_list.clone()}
                                                        });
                                                        merge_task_top_packet(
                                                            &mut state.latest_task_top, &assembled);
                                                    }
                                                } else {
                                                    merge_task_top_packet(
                                                        &mut state.latest_task_top, &val);
                                                }
                                            }
                                            /* Heartbeat acknowledgements prove board reachability
                                             * but carry no model data and must not replace the
                                             * latest visual/task snapshot. */
                                            if !heartbeat {
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
            let discover_send = discovery.try_clone().expect("clone discovery socket");
            std::thread::Builder::new()
                .name("sim-client-discovery".into())
                .spawn(move || {
                    let mut buf = [0u8; 128];
                    loop {
                        if !crate::transport::allows_network() {
                            std::thread::sleep(Duration::from_secs(1));
                            continue;
                        }
                        let _ = discover_send.send_to(b"JSBSIM-DISCOVER", format!("255.255.255.255:{}", DISCOVERY_PORT));
                        let deadline = Instant::now() + Duration::from_millis(800);
                        while Instant::now() < deadline {
                            match discovery.recv_from(&mut buf) {
                                Ok((n, peer)) if &buf[..n] == b"JSBSIM-HERE" => {
                                    if let Ok(mut addr) = discovered_ctrl.lock() {
                                        *addr = SocketAddr::new(peer.ip(), ctrl_port);
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
                        /* The USB receiver holds the shared interface during
                         * each 100 ms read.  Give this 1 Hz heartbeat the
                         * same bounded lock wait as lifecycle commands so
                         * repeated try_lock misses cannot trip the board's
                         * 10-second connection watchdog. */
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
            configured_ctrl_addr: initial_ctrl_addr,
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

    /// Whether the reported JSBSim simulation clock advanced in the recent
    /// past.  This is more trustworthy than a stale lifecycle label.
    pub fn simulation_is_advancing(&self) -> bool {
        self.inner.lock().unwrap().last_simulation_progress
            .map(|at| at.elapsed() < Duration::from_secs(2))
            .unwrap_or(false)
    }

    /// `Some(false)` means a fresh task snapshot was received and JSBSim is
    /// absent. `None` means no task snapshot is available yet.
    pub fn jsbsim_task_alive(&self) -> Option<bool> {
        let state = self.inner.lock().unwrap();
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
    pub fn send_restart(&self) -> std::io::Result<()> {
        let request = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|error| std::io::Error::other(error.to_string()))?
            .as_millis() as u32;
        let mut packet = [0u8; 9];
        packet[0..4].copy_from_slice(b"VCMD");
        packet[4] = 6; // VCMD_RESTART
        packet[5..9].copy_from_slice(&request.to_le_bytes());

        self.send_to_control_addresses(&packet)?;
        Ok(())
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
    pub fn send_load(&self, model: &str) -> std::io::Result<()> {
        let mut packet = [0u8; 80];
        packet[0..4].copy_from_slice(b"VCMD");
        packet[4] = 5; // VCMD_LOAD
        let name = model_basename(model);
        let bytes = name.as_bytes();
        let count = bytes.len().min(packet.len() - 5);
        packet[5..5 + count].copy_from_slice(&bytes[..count]);
        /* A bridge reload closes and reopens its UDP control socket.  Repeat
         * the idempotent LOAD datagram so a packet landing in that short gap
         * does not leave the desktop UI believing a model switch succeeded.
         * The bridge treats a duplicate request for its active model as a
         * start, rather than reconstructing it a second time. */
        self.send_to_control_addresses(&packet)?;
        Ok(())
    }

    /// Request a runscript reload. Payload is `script|aircraft`; both values
    /// are basenames validated again by the NuttX bridge.
    pub fn send_load_script(&self, script: &str, model: &str) -> std::io::Result<()> {
        let mut packet = [0u8; 160];
        packet[0..4].copy_from_slice(b"VCMD");
        packet[4] = 8; // VCMD_LOAD_SCRIPT
        let script = script.rsplit('/').next().unwrap_or(script);
        let model = model_basename(model);
        let payload = format!("{}|{}", script, model);
        let bytes = payload.as_bytes();
        let count = bytes.len().min(packet.len() - 5);
        packet[5..5 + count].copy_from_slice(&bytes[..count]);
        // Unlike model LOAD, script LOAD always rebuilds the bridge. Sending
        // duplicates can make the freshly-created task consume a trailing
        // datagram and immediately rebuild itself again.
        self.send_to_control_addresses(&packet)?;
        Ok(())
    }

    /// Wait for the board to confirm both the requested model and its running
    /// lifecycle state.  A successful `send_to` only confirms that Linux
    /// accepted a UDP datagram; it is not evidence that NuttX reloaded it.
    pub fn wait_for_running_model(&self, model: &str, timeout: Duration) -> bool {
        let expected = model_basename(model);
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let confirmed = self.latest_sim_status().map(|frame| {
                frame.get("state").and_then(Value::as_str) == Some("running") &&
                frame.get("model").and_then(Value::as_str) == Some(expected)
            }).unwrap_or(false);
            if confirmed {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
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
        let crashed = serde_json::json!({"task_top":{"tasks":[{"name":"FTP_daemon"},{"name":"nsh_main"}]}});
        assert_eq!(jsbsim_task_alive(Some(&alive)), Some(true));
        assert_eq!(jsbsim_task_alive(Some(&crashed)), Some(false));
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
}
