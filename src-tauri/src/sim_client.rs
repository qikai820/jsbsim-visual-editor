//! UDP simulation client — receives telemetry from JSBSim sim_server.
//!
//! Desktop simulation client:
//!   - Listens on a UDP port (default 5801) for JSON telemetry packets.
//!   - Stores the latest frame; marks disconnected after 2 s without packets.
//!   - Sends 72-byte VisControlFrame (magic "VCTL" + override + 16×f32) back
//!     to the simulation host.

use serde_json::Value;
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

// ── public struct ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SimClient {
    inner: Arc<Mutex<SimClientInner>>,
    /// Socket shared with the sender side so `send_control` can reuse the
    /// bound port (or any available local port when the receiver hasn't bound
    /// yet).
    send_socket: Arc<UdpSocket>,
    ctrl_addr: Arc<Mutex<SocketAddr>>,
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
    /// The last lifecycle command issued by this editor.  It remains
    /// authoritative until another lifecycle command is issued; telemetry is
    /// observational and may arrive delayed or out of order over UDP.
    commanded_lifecycle_state: Option<String>,
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

// Compile-time assertion: SimClient must be Clone + Send + Sync for Tauri.
const _: fn() = || {
    fn _assert_clone_send_sync<T: Clone + Send + Sync>() {}
    _assert_clone_send_sync::<SimClient>();
};

// ── implementation ─────────────────────────────────────────────────────────

impl SimClient {
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

        // A separate socket for sending — avoids borrowing conflicts and
        // works even if the recv socket hasn't been bound yet.
        let send_socket =
            UdpSocket::bind("0.0.0.0:0").expect("SimClient: ephemeral send bind failed");
        let send_socket = Arc::new(send_socket);

        let ctrl_addr = Arc::new(Mutex::new(initial_ctrl_addr));
        let inner = Arc::new(Mutex::new(SimClientInner {
                latest: None,
                latest_sim_status: None,
                latest_task_top: None,
                commanded_lifecycle_state: None,
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
                                if let Ok(text) = std::str::from_utf8(&buf[..n]) {
                                    if let Ok(val) = serde_json::from_str::<Value>(text) {
                                        if val.is_object() {
                                            /* Telemetry is authoritative proof of which board is
                                             * connected.  Route subsequent control packets to its
                                             * source IP: discovery packets or an outdated setting
                                             * must never leave the UI receiving telemetry from one
                                             * target while controlling another. */
                                            if let Ok(mut address) = telemetry_ctrl_addr.lock() {
                                                *address = SocketAddr::new(peer.ip(), ctrl_port);
                                            }
                                            let mut state = inner.lock().unwrap();
                                            let heartbeat = val.get("kind")
                                                .and_then(Value::as_str) == Some("heartbeat");
                                            if let Some(remote_state) = val.get("state").and_then(Value::as_str) {
                                                state.latest_sim_status = Some(val.clone());
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
                                            if val.get("task_top").is_some() {
                                                state.latest_task_top = Some(val.clone());
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
                    let addr = heartbeat_addr.lock().map(|a| *a).ok();
                    if let Some(addr) = addr { let _ = sock.send_to(&packet, addr); }
                    std::thread::sleep(Duration::from_secs(1));
                })
                .expect("spawn heartbeat thread");
        }

        Self {
            inner,
            send_socket,
            ctrl_addr,
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

    /// Per-core busy percentage reconstructed from the SMP idle tasks.  The
    /// NuttX cpuload values are percentages of total machine time, so an idle
    /// task on an N-core target has a maximum load of 100/N percent.
    pub fn cpu_core_loads(&self) -> Option<Vec<f64>> {
        let state = self.inner.lock().unwrap();
        let tasks = state.latest_task_top.as_ref()?
            .get("task_top")?.get("tasks")?.as_array()?;
        let mut idle = Vec::<(usize, f64)>::new();
        for task in tasks {
            let name = task.get("name").and_then(Value::as_str)?;
            let upper = name.to_ascii_uppercase();
            if !upper.starts_with("CPU") || !upper.ends_with(" IDLE") {
                continue;
            }
            let core = upper[3..upper.len() - 5].trim().parse::<usize>().ok()?;
            idle.push((core, task.get("load")?.as_f64()?));
        }
        if idle.is_empty() { return None; }
        let core_count = idle.iter().map(|(core, _)| *core).max()? + 1;
        let mut loads = vec![0.0; core_count];
        for (core, idle_load) in idle {
            loads[core] = (100.0 - idle_load * core_count as f64).clamp(0.0, 100.0);
        }
        Some(loads)
    }

    /// Current NuttX user-heap usage reported alongside the task snapshot.
    pub fn memory_usage(&self) -> Option<Value> {
        let state = self.inner.lock().unwrap();
        state.latest_task_top.as_ref()?
            .get("task_top")?.get("memory").cloned()
    }

    /// Wall-clock execution time of the most recent FGFDMExec::Run call.
    pub fn fdm_run_ms(&self) -> Option<f64> {
        let state = self.inner.lock().unwrap();
        state.latest_task_top.as_ref()?
            .get("task_top")?.get("fdm_run_ms")?.as_f64()
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

        let addr = *self.ctrl_addr.lock().map_err(|_| std::io::Error::other("control address lock"))?;
        self.send_socket.send_to(&buf, addr)?;
        Ok(())
    }

    pub fn send_command(&self, command: u8) -> std::io::Result<()> {
        let packet = [b'V', b'C', b'M', b'D', command];
        let addr = *self.ctrl_addr.lock().map_err(|_| std::io::Error::other("control address lock"))?;
        self.send_socket.send_to(&packet, addr)?;
        Ok(())
    }

    /// Send a lifecycle command redundantly.  UDP `send_to` only means the
    /// local OS accepted the datagram; it does not mean the NuttX bridge saw
    /// it.  START/STOP/PAUSE/RESUME are idempotent, so retries are safe.
    pub fn send_lifecycle_command(&self, command: u8) -> std::io::Result<()> {
        let packet = [b'V', b'C', b'M', b'D', command];
        let addr = *self.ctrl_addr.lock().map_err(|_| std::io::Error::other("control address lock"))?;
        for attempt in 0..3 {
            self.send_socket.send_to(&packet, addr)?;
            if attempt != 2 {
                std::thread::sleep(Duration::from_millis(20));
            }
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

        let addr = *self.ctrl_addr.lock().map_err(|_| std::io::Error::other("control address lock"))?;
        for attempt in 0..3 {
            self.send_socket.send_to(&packet, addr)?;
            if attempt != 2 {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        Ok(())
    }

    /// Synchronize NuttX realtime clock only when telemetry reports a
    /// difference larger than the configured threshold.
    pub fn sync_clock_if_needed(&self, threshold_secs: u64) -> std::io::Result<Option<i64>> {
        let remote = self.latest_sim_status()
            .and_then(|value| value.get("wall_time_s").and_then(Value::as_u64));
        let Some(remote) = remote else { return Ok(None); };
        let local = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|e| std::io::Error::other(e.to_string()))?.as_secs();
        let difference = local as i128 - remote as i128;
        if difference.unsigned_abs() <= threshold_secs as u128 { return Ok(Some(0)); }
        let mut packet = [0u8; 13];
        packet[0..4].copy_from_slice(b"VCMD");
        packet[4] = 9; // VCMD_SET_WALL_CLOCK
        packet[5..13].copy_from_slice(&local.to_le_bytes());
        let addr = *self.ctrl_addr.lock().map_err(|_| std::io::Error::other("control address lock"))?;
        self.send_socket.send_to(&packet, addr)?;
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
        let addr = *self.ctrl_addr.lock().map_err(|_| std::io::Error::other("control address lock"))?;
        /* A bridge reload closes and reopens its UDP control socket.  Repeat
         * the idempotent LOAD datagram so a packet landing in that short gap
         * does not leave the desktop UI believing a model switch succeeded.
         * The bridge treats a duplicate request for its active model as a
         * start, rather than reconstructing it a second time. */
        for _ in 0..3 {
            self.send_socket.send_to(&packet, addr)?;
        }
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
        let addr = *self.ctrl_addr.lock().map_err(|_| std::io::Error::other("control address lock"))?;
        for _ in 0..3 {
            self.send_socket.send_to(&packet, addr)?;
        }
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
}
