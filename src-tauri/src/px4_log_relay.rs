use crate::px4_log_relay_wire::{receive, start_commands, Progress};
use serde::Deserialize;
use std::{
    io::Write,
    net::{Ipv4Addr, SocketAddr, TcpStream},
    sync::Mutex,
    time::{Duration, Instant},
};

const PORT: u16 = 14625;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    simulator: Ipv4Addr,
    session_id: u64,
    system: u8,
    component: u8,
    hardware_uid: String,
    log_id: u16,
    time: u32,
    size: u32,
}

static ACTIVE: Mutex<Option<(u64, Progress)>> = Mutex::new(None);

struct Lease;
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            *active = None;
        }
    }
}

fn update(id: u64, progress: Progress) {
    if let Ok(mut active) = ACTIVE.lock() {
        if let Some((_, current)) = active.as_mut().filter(|(job, _)| *job == id) {
            *current = progress;
        }
    }
    crate::mcp_logs::progress(id, u64::from(progress.staged.max(progress.saved)));
}

fn relay(id: u64, request: Request) -> Result<(), String> {
    if crate::transport::network_host() != Some(request.simulator) {
        return Err("任务机网络目标已变化".into());
    }
    let uid = u64::from_str_radix(&request.hardware_uid, 16)
        .ok()
        .filter(|uid| *uid != 0)
        .ok_or("飞控 UID 无效")?;
    if request.log_id == u16::MAX || crate::px4_files::pending_size(id)? != u64::from(request.size)
    {
        return Err("任务机日志选择已变化".into());
    }
    let generation = || {
        crate::flight_test::log_relay_generation(
            request.session_id,
            request.simulator,
            (request.system, request.component),
            uid,
        )
    };
    let initial = generation()?;
    let check = || {
        crate::px4_files::pending_size(id)?;
        if generation()? != initial {
            return Err("下载期间飞控重启或链路状态发生变化".into());
        }
        Ok(())
    };
    {
        let mut active = ACTIVE.lock().map_err(|e| e.to_string())?;
        if active.is_some() {
            return Err("已有任务机日志下载正在进行".into());
        }
        *active = Some((id, Progress::default()));
    }
    let _lease = Lease;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let fields = format!(
        "{token}{:02x}{:02x}{:04x}{:08x}{:08x}{uid:016x}",
        request.system, request.component, request.log_id, request.time, request.size
    );
    let (assignment, launch) = start_commands(&fields)?;
    let response = crate::romfs_network::with_host_session(request.simulator, |session| {
        check()?;
        session.command_progress(&assignment, Duration::from_secs(3), |_| {})?;
        check()?;
        session.command_progress(launch, Duration::from_secs(3), |_| {})
    })?;
    if !response
        .lines()
        .any(|line| line.trim() == "PX4_LOG_READY protocol=1")
    {
        let reason = response
            .lines()
            .find_map(|line| line.trim().strip_prefix("PX4_LOG_ERROR "));
        return Err(match reason {
            Some("storage_unavailable") => "任务机缓存盘未挂载",
            Some("router_unavailable_or_busy") => "任务机转发服务未运行，或已有任务机日志下载",
            Some("invalid_request") => "任务机拒绝了日志缓存启动参数",
            Some("task_start_failed") => "任务机无法创建日志缓存任务",
            _ => "任务机未能启动日志缓存服务，请检查任务机固件与转发状态",
        }
        .into());
    }
    let address = SocketAddr::from((request.simulator, PORT));
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut stream = loop {
        check()?;
        match TcpStream::connect_timeout(&address, Duration::from_millis(300)) {
            Ok(stream) => break stream,
            Err(error) if Instant::now() >= deadline => {
                return Err(format!("无法连接任务机日志服务：{error}"))
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(token.as_bytes())
        .map_err(|e| e.to_string())?;
    receive(
        &mut stream,
        request.size,
        check,
        |offset, data| crate::px4_files::write_chunk(id, u64::from(offset), data),
        |progress| update(id, progress),
    )
}

#[tauri::command]
pub async fn px4_log_relay(id: u64, request: Request) -> Result<(), String> {
    crate::run_blocking(move || relay(id, request)).await
}

#[tauri::command]
pub fn px4_log_relay_progress(id: u64) -> Option<Progress> {
    ACTIVE
        .lock()
        .ok()?
        .as_ref()
        .filter(|(job, _)| *job == id)
        .map(|(_, progress)| *progress)
}
