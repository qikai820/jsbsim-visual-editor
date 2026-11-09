//! Reuse the persistent debug transport with independent ownership for each tool.
use crate::serial_assistant::{NetworkConfig, PortConfig, SerialEvent, SerialManager, SessionInfo};
use serde::Deserialize;
use std::sync::OnceLock;
use tauri::ipc::Channel;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Owner {
    Px4,
    Nsh,
}

fn manager(owner: Owner) -> &'static SerialManager {
    static PX4: OnceLock<SerialManager> = OnceLock::new();
    static NSH: OnceLock<SerialManager> = OnceLock::new();
    match owner {
        Owner::Px4 => PX4.get_or_init(SerialManager::new),
        Owner::Nsh => NSH.get_or_init(SerialManager::new),
    }
}

#[tauri::command]
pub async fn tool_transport_open(
    owner: Owner,
    serial: Option<PortConfig>,
    network: Option<NetworkConfig>,
    on_event: Channel<SerialEvent>,
) -> Result<SessionInfo, String> {
    crate::run_blocking(move || match (serial, network) {
        (Some(config), None) => manager(owner).open(config, on_event),
        (None, Some(config)) => manager(owner).open_network(config, on_event),
        _ => Err("请选择一种连接方式".into()),
    })
    .await
}

#[tauri::command]
pub async fn tool_transport_write(
    owner: Owner,
    session_id: u64,
    bytes: Vec<u8>,
) -> Result<usize, String> {
    crate::run_blocking(move || manager(owner).write(session_id, bytes)).await
}

#[tauri::command]
pub async fn tool_transport_close(owner: Owner, session_id: u64) -> Result<(), String> {
    crate::run_blocking(move || manager(owner).close(session_id)).await
}

#[tauri::command]
pub async fn tool_transport_pin_peer(
    owner: Owner,
    session_id: u64,
    address: String,
) -> Result<(), String> {
    let address = address.parse().map_err(|_| "UDP 目标地址无效")?;
    crate::run_blocking(move || manager(owner).pin_peer(session_id, address)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NshTarget {
    host: String,
    port: u16,
}
#[tauri::command]
pub async fn tool_simulator_nsh_target() -> Result<Option<NshTarget>, String> {
    crate::run_blocking(|| {
        let port = std::env::var("NSH_TELNET_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p > 0)
            .unwrap_or(23);
        Ok(crate::transport::network_host().map(|host| NshTarget {
            host: host.to_string(),
            port,
        }))
    })
    .await
}
