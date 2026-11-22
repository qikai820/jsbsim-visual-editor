//! Immutable target selection for this application session.
use std::sync::OnceLock;
pub const CONTROL_PORT: u16 = 15802;
pub const FTP_PORT: u16 = 2121;
pub const NSH_PORT: u16 = 2323;
static LOCAL: OnceLock<bool> = OnceLock::new();
pub fn initialize(enabled: bool) { let _ = LOCAL.set(enabled); }
pub fn active() -> bool { LOCAL.get().copied().unwrap_or(false) }
pub fn accepts_telemetry(peer: std::net::SocketAddr) -> bool {
    !active() || (peer.ip() == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) && peer.port() == CONTROL_PORT)
}
