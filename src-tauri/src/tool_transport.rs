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

/// Runner shares the already pinned toolbox session; it never opens another port.
pub fn px4_datagram_writer(session:u64)->Result<crate::serial_assistant::DatagramWriter,String>{manager(Owner::Px4).datagram_writer(session)}

#[tauri::command]
pub async fn tool_transport_open(
    owner: Owner,
    serial: Option<PortConfig>,
    network: Option<NetworkConfig>,
    on_event: Channel<SerialEvent>,
) -> Result<SessionInfo, String> {
    crate::run_blocking(move || {
        let px4=matches!(owner,Owner::Px4);
        if px4&&(crate::flight_test::running()||crate::flight_test::receiver::busy()){return Err("请先停止仿真测试或等待遥控器切换完成，再重建转发连接".into());}
        let _source_gate=if px4{Some(crate::flight_test::receiver::gate()?)}else{None};
        if px4&&(crate::flight_test::running()||crate::flight_test::receiver::busy()){return Err("请先停止仿真测试或等待遥控器切换完成，再重建转发连接".into());}
        let forwarded=network.as_ref().is_some_and(|c|matches!(c.mode,crate::serial_assistant::NetworkMode::Udp));
        if px4&&forwarded {
            if let Some(old)=crate::flight_test::stale_session(){
                crate::flight_test::receiver::clear_idle();
                manager(owner).close_if_current(old)?;
            }
        }
        let channel=if px4{Channel::new(move |body|{
            if let tauri::ipc::InvokeResponseBody::Json(source)=body{
                if let Ok(event)=serde_json::from_str::<SerialEvent>(&source){crate::flight_test::observe(&event);on_event.send(event)?;}
            }Ok(())
        })}else{on_event};
        let info=match (serial,network){(Some(config),None)=>manager(owner).open(config,channel),(None,Some(config))=>manager(owner).open_network(config,channel),_=>Err("请选择一种连接方式".into())}?;
        if px4{crate::flight_test::bind_session(info.session_id,crate::transport::network_host().map(std::net::IpAddr::V4),forwarded);}
        Ok(info)
    })
    .await
}

#[tauri::command]
pub async fn tool_transport_write(
    owner: Owner,
    session_id: u64,
    bytes: Vec<u8>,
) -> Result<usize, String> {
    crate::run_blocking(move || {if matches!(owner,Owner::Px4){crate::flight_test::guard_write(&bytes)?;}manager(owner).write(session_id, bytes)}).await
}

#[tauri::command]
pub async fn tool_transport_close(owner: Owner, session_id: u64) -> Result<(), String> {
    crate::run_blocking(move || {if matches!(owner,Owner::Px4){crate::flight_test::stop(None)?;}manager(owner).close(session_id)}).await
}

#[tauri::command]
pub async fn tool_transport_pin_peer(
    owner: Owner,
    session_id: u64,
    address: String,
) -> Result<(), String> {
    let address = address.parse().map_err(|_| "UDP 目标地址无效")?;
    crate::run_blocking(move || {if matches!(owner,Owner::Px4){crate::flight_test::guard_pin(session_id,address)?;}manager(owner).pin_peer(session_id,address)?;if matches!(owner,Owner::Px4){crate::flight_test::pin(session_id,address);}Ok(())}).await
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
        let port = if crate::sim_backend::active() { crate::sim_backend::NSH_PORT } else { std::env::var("NSH_TELNET_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p > 0)
            .unwrap_or(23) };
        Ok(crate::transport::network_host().map(|host| NshTarget {
            host: host.to_string(),
            port,
        }))
    })
    .await
}
