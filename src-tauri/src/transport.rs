//! Runtime selection for every board communication channel.

use std::sync::atomic::{AtomicU8, Ordering};
use std::net::Ipv4Addr;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum TransportMode {
    Auto = 0,
    Network = 1,
    Usb = 2,
}

impl TransportMode {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "network" | "ftp" | "udp" => Some(Self::Network),
            "usb" => Some(Self::Usb),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Network => "network",
            Self::Usb => "usb",
        }
    }
}

static MODE: OnceLock<AtomicU8> = OnceLock::new();
static NETWORK_HOST_OVERRIDE: OnceLock<Mutex<Option<Ipv4Addr>>> = OnceLock::new();

pub fn network_host_override() -> Option<Ipv4Addr> {
    *NETWORK_HOST_OVERRIDE.get_or_init(|| Mutex::new(None)).lock().ok()?
}

pub fn set_network_host_override(address: Ipv4Addr) {
    if let Ok(mut current) = NETWORK_HOST_OVERRIDE.get_or_init(|| Mutex::new(None)).lock() {
        *current = Some(address);
    }
}

/// Explicit configuration wins; otherwise reuse a learned address or inspect
/// existing Ethernet neighbors for the NuttX FTP service.
pub fn network_host() -> Option<Ipv4Addr> {
    if let Some(host) = std::env::var("SIM_UDP_HOST").ok().and_then(|value| value.parse().ok()) {
        return Some(host);
    }
    if let Some(host) = network_host_override() { return Some(host); }
    let host = crate::network_discovery::discover(None)?;
    set_network_host_override(host);
    Some(host)
}

fn state() -> &'static AtomicU8 {
    MODE.get_or_init(|| {
        let configured = std::env::var("SIM_TRANSPORT_MODE")
            .or_else(|_| std::env::var("SIM_FILE_TRANSPORT"))
            .ok()
            .and_then(|value| TransportMode::parse(&value))
            .unwrap_or(TransportMode::Auto);
        AtomicU8::new(configured as u8)
    })
}

pub fn mode() -> TransportMode {
    match state().load(Ordering::Relaxed) {
        1 => TransportMode::Network,
        2 => TransportMode::Usb,
        _ => TransportMode::Auto,
    }
}

pub fn set_mode(value: &str) -> Result<TransportMode, String> {
    let mode = TransportMode::parse(value)
        .ok_or_else(|| "transport mode must be auto, network, or usb".to_string())?;
    state().store(mode as u8, Ordering::Relaxed);
    Ok(mode)
}

pub fn allows_network() -> bool {
    mode() != TransportMode::Usb
}

pub fn allows_usb() -> bool {
    mode() != TransportMode::Network
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ui_modes_and_legacy_network_aliases() {
        assert_eq!(TransportMode::parse("auto"), Some(TransportMode::Auto));
        assert_eq!(TransportMode::parse("network"), Some(TransportMode::Network));
        assert_eq!(TransportMode::parse("ftp"), Some(TransportMode::Network));
        assert_eq!(TransportMode::parse("usb"), Some(TransportMode::Usb));
        assert_eq!(TransportMode::parse("serial"), None);
    }
}
