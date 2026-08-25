//! UDP simulation client — receives telemetry from JSBSim sim_server.
//!
//! Mirrors `server/simClient.js`:
//!   - Listens on a UDP port (default 5801) for JSON telemetry packets.
//!   - Stores the latest frame; marks disconnected after 2 s without packets.
//!   - Sends 72-byte VisControlFrame (magic "VCTL" + override + 16×f32) back
//!     to the simulation host.

use serde_json::Value;
use std::net::{SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/* The external bridge normally runs on the i.MX board, while this editor
 * runs on the development PC.  Keep it configurable, but make the board
 * address the useful default instead of silently sending commands to the PC. */
const DEFAULT_CTRL_HOST: &str = "192.168.101.81";
const DEFAULT_CTRL_PORT: u16 = 5802;

// ── public struct ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SimClient {
    inner: Arc<Mutex<SimClientInner>>,
    /// Socket shared with the sender side so `send_control` can reuse the
    /// bound port (or any available local port when the receiver hasn't bound
    /// yet).
    send_socket: Arc<UdpSocket>,
    ctrl_addr: SocketAddr,
}

struct SimClientInner {
    latest: Option<Value>,
    connected: bool,
    last_packet_time: Instant,
    packets: u64,
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
        let ctrl_addr: SocketAddr = format!("{}:{}", ctrl_host, ctrl_port)
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

        let inner = Arc::new(Mutex::new(SimClientInner {
            latest: None,
            connected: false,
            last_packet_time: Instant::now(),
            packets: 0,
        }));

        // ── receiver thread ───────────────────────────────────────────
        {
            let inner = Arc::clone(&inner);
            let sock = recv_socket;
            std::thread::Builder::new()
                .name("sim-client-recv".into())
                .spawn(move || {
                    let mut buf = [0u8; 8192];
                    loop {
                        match sock.recv_from(&mut buf) {
                            Ok((n, _addr)) => {
                                if let Ok(text) = std::str::from_utf8(&buf[..n]) {
                                    if let Ok(val) = serde_json::from_str::<Value>(text) {
                                        if val.is_object() {
                                            let mut state = inner.lock().unwrap();
                                            state.latest = Some(val);
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

        Self {
            inner,
            send_socket: Arc::new(send_socket),
            ctrl_addr,
        }
    }

    /// `true` when a telemetry packet has been received within the last 2 s.
    pub fn is_connected(&self) -> bool {
        self.inner.lock().unwrap().connected
    }

    /// Clone of the most recently received telemetry frame, or `None`.
    pub fn latest(&self) -> Option<Value> {
        self.inner.lock().unwrap().latest.clone()
    }

    /// Total number of telemetry packets received since startup.
    pub fn packet_count(&self) -> u64 {
        self.inner.lock().unwrap().packets
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

        self.send_socket.send_to(&buf, self.ctrl_addr)?;
        Ok(())
    }

    pub fn send_command(&self, command: u8) -> std::io::Result<()> {
        let packet = [b'V', b'C', b'M', b'D', command];
        self.send_socket.send_to(&packet, self.ctrl_addr)?;
        Ok(())
    }

    /// Request a model reload.  The NuttX bridge accepts a basename only.
    pub fn send_load(&self, model: &str) -> std::io::Result<()> {
        let mut packet = [0u8; 80];
        packet[0..4].copy_from_slice(b"VCMD");
        packet[4] = 5; // VCMD_LOAD
        let name = model.rsplit('/').next().unwrap_or(model)
            .trim_end_matches(".xml");
        let bytes = name.as_bytes();
        let count = bytes.len().min(packet.len() - 5);
        packet[5..5 + count].copy_from_slice(&bytes[..count]);
        self.send_socket.send_to(&packet, self.ctrl_addr)?;
        Ok(())
    }
}
