//! Flash the USB flight controller through the simulator-owned gateway.
mod protocol;
mod remote;
mod library;
mod library_store;
use protocol::{Board, Firmware, ImageInfo, MAX_PACKAGE};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsbTarget {
    pub simulator: String,
    pub path: String,
    pub vid: u16,
    pub pid: u16,
    pub serial_number: Option<String>,
    pub label: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub id: u64,
    #[serde(flatten)]
    pub info: ImageInfo,
    pub simulator: Option<String>,
    pub library_id: Option<String>,
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: u64,
    pub running: bool,
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub message: String,
    pub board: Option<Board>,
    pub target: Option<UsbTarget>,
    pub firmware: Option<Selection>,
    pub can_cancel: bool,
    pub archive: Option<library::Entry>,
}
#[derive(Default)]
struct State {
    next: u64,
    staged: Option<(Selection, Arc<Firmware>)>,
    snapshot: Snapshot,
    cancelled: bool,
}
fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}
pub fn busy() -> bool {
    state().lock().map(|s| s.snapshot.running).unwrap_or(true)
}
pub fn status() -> Result<Snapshot, String> {
    Ok(state().lock().map_err(|e| e.to_string())?.snapshot.clone())
}
pub fn ports() -> Result<Vec<UsbTarget>, String> {
    remote::ports()
}

fn stage(name: String, source: String, bytes: Vec<u8>) -> Result<Selection, String> {
    stage_firmware(Firmware::parse(name, source, &bytes)?,None,None)
}
fn stage_firmware(firmware:Firmware,simulator:Option<String>,library_id:Option<String>)->Result<Selection,String>{
    let firmware=Arc::new(firmware);
    let mut s = state().lock().map_err(|e| e.to_string())?;
    if s.snapshot.running {
        return Err("固件升级进行中，无法更换固件".into());
    }
    s.next += 1;
    let selection = Selection {
        id: s.next,
        info: firmware.info.clone(),
        simulator,
        library_id,
    };
    s.staged = Some((selection.clone(), firmware));
    Ok(selection)
}
pub fn library_list()->Result<library::Listing,String>{library::list()}
pub fn library_select(simulator:String,firmware_id:String)->Result<Selection,String>{
    if busy(){return Err("固件升级进行中，无法更换固件".into());}
    let firmware=library::load(&simulator,&firmware_id)?;
    stage_firmware(firmware,Some(simulator),Some(firmware_id))
}
#[tauri::command]
pub async fn px4_firmware_library()->Result<library::Listing,String>{crate::run_blocking(library_list).await}
#[tauri::command]
pub async fn px4_firmware_select(simulator:String,firmware_id:String)->Result<Selection,String>{
    crate::run_blocking(move||library_select(simulator,firmware_id)).await
}
pub(crate) fn local(path: &std::path::Path) -> Result<Selection, String> {
    if busy() {
        return Err("固件升级进行中".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| format!("无法读取固件：{e}"))?
        .take((MAX_PACKAGE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    stage(
        path.file_name()
            .ok_or("固件文件名无效")?
            .to_string_lossy()
            .into_owned(),
        path.to_string_lossy().into_owned(),
        bytes,
    )
}

fn update(stage: &str, completed: usize, total: usize, message: &str) {
    if let Ok(mut s) = state().lock() {
        s.snapshot.stage = stage.into();
        s.snapshot.completed = completed;
        s.snapshot.total = total;
        s.snapshot.message = message.into();
    }
}
fn cancelled() -> bool {
    state().lock().map(|s| s.cancelled).unwrap_or(true)
}
fn worker(firmware: &Firmware, target: &UsbTarget,job_id:u64) -> Result<(), String> {
    // This is shared by UI and MCP. No Bootloader/USB connection is acquired
    // until the original package and a per-use record have been read back.
    if cancelled(){return Err("已取消归档；未擦除飞控".into());}
    let archive=library::archive(firmware,target,job_id).map_err(|e|format!("固件归档失败，未开始刷写：{e}"))?;
    {
        let mut s=state().lock().map_err(|e|e.to_string())?;
        if let Some(f)=s.snapshot.firmware.as_mut(){f.library_id=Some(archive.id.clone());f.simulator=Some(target.simulator.clone());}
        s.snapshot.archive=Some(archive);
    }
    if cancelled(){return Err("固件已保存，升级已取消；未擦除飞控".into());}
    if crate::scene_telemetry::snapshots().iter().any(|s|s["state"]=="running"||s["state"]=="paused"){
        return Err("固件已保存，请先停止仿真模型；未开始刷写".into());
    }
    update("waiting",0,0,"固件已保存到仿真机，正在等待所选飞控 Bootloader");
    let mut wire = remote::RemoteWire::connect(target)?;
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut last_error = String::new();
    while Instant::now() < deadline {
        if cancelled() {
            return Err("已取消等待；未擦除飞控".into());
        }
        wire.reset()?;
        match protocol::identify(&mut wire) {
            Ok(board) => {
                protocol::compatible(firmware, &board)?;
                {
                    let mut s = state().lock().map_err(|e| e.to_string())?;
                    if s.cancelled {
                        return Err("已取消等待；未擦除飞控".into());
                    }
                    s.snapshot.board = Some(board.clone());
                    s.snapshot.can_cancel = false;
                    s.snapshot.stage = if wire.local_flash { "upload" } else { "erase" }.into();
                }
                let mut progress = |stage: &str, done, total| {
                    update(
                        stage,
                        done,
                        total,
                        match stage {
                            "upload" => "正在上传固件镜像，仿真机校验后将通过本机 USB 刷写",
                            "erase" => "仿真机正在擦除飞控 Flash，请保持连接和供电",
                            "program" => "仿真机正在写入飞控固件",
                            "verify" => "正在校验飞控 Flash",
                            _ => "校验通过，正在重启飞控",
                        },
                    )
                };
                return if wire.local_flash {
                    wire.flash_local(firmware, &board, &mut progress)
                } else {
                    protocol::flash(&mut wire, firmware, &board, &mut progress)
                };
            }
            Err(e) => {
                if !wire.healthy {
                    return Err(e);
                }
                last_error = e;
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "等待 Bootloader 超时；未擦除。请在仿真机上重新插拔飞控 USB 并刷新目标。{last_error}"
    ))
}

pub fn start(selection_id: u64, target: UsbTarget) -> Result<Snapshot, String> {
    let connection = crate::flight_test::connection_snapshot();
    if connection["fresh"] == true && connection["armed"] != false {
        return Err("请先上锁飞控再升级".into());
    }
    if crate::scene_telemetry::snapshots()
        .iter()
        .any(|s| s["state"] == "running" || s["state"] == "paused")
    {
        return Err("请先停止仿真模型再升级飞控".into());
    }
    let _gate = crate::flight_test::receiver::gate()?;
    if crate::flight_test::running() || crate::flight_test::receiver::busy() {
        return Err("请先停止仿真测试或等待遥控器来源切换完成".into());
    }
    if !ports()?.iter().any(|p| p == &target) {
        return Err("所选仿真机或 USB 设备已变化，请刷新并重新选择".into());
    }
    let mut s = state().lock().map_err(|e| e.to_string())?;
    if s.snapshot.running {
        return Err("已有固件升级正在进行".into());
    }
    let (selection, firmware) = s
        .staged
        .as_ref()
        .filter(|(info, _)| info.id == selection_id)
        .cloned()
        .ok_or("固件选择已过期，请重新选择")?;
    if selection.simulator.as_ref().is_some_and(|host|host!=&target.simulator){
        return Err("固件所属仿真机与升级目标不一致，请重新选择".into());
    }
    crate::flight_test::receiver::clear_idle();
    s.next += 1;
    s.cancelled = false;
    s.snapshot = Snapshot {
        id: s.next,
        running: true,
        stage: "archive".into(),
        can_cancel: true,
        message:"正在保存原始固件和升级记录到仿真机，校验成功后才开始刷写".into(),
        target: Some(target.clone()),
        firmware: Some(selection),
        ..Snapshot::default()
    };
    let result = s.snapshot.clone();
    let job_id=result.id;
    if let Err(e) = std::thread::Builder::new()
        .name("px4-firmware".into())
        .spawn(move || {
            let result = worker(&firmware, &target,job_id);
            if let Ok(mut s) = state().lock() {
                s.snapshot.running = false;
                s.snapshot.can_cancel = false;
                match result {
                    Ok(()) => {
                        s.snapshot.stage = "complete".into();
                        s.snapshot.message =
                            "固件写入和校验通过，已发送重启。请等待飞控启动并检查版本与参数。"
                                .into();
                    }
                    Err(e) => {
                        s.snapshot.stage = if s.cancelled { "cancelled" } else { "error" }.into();
                        s.snapshot.message = e;
                    }
                }
            }
        })
    {
        s.snapshot.running = false;
        s.snapshot.can_cancel = false;
        s.snapshot.stage = "error".into();
        s.snapshot.message = e.to_string();
        return Err(e.to_string());
    }
    Ok(result)
}
pub fn cancel(id: u64) -> Result<Snapshot, String> {
    let mut s = state().lock().map_err(|e| e.to_string())?;
    if !s.snapshot.running || s.snapshot.id != id {
        return Err("升级任务已结束或已变化".into());
    }
    if !s.snapshot.can_cancel {
        return Err("已进入上传或刷写阶段，请保持连接直至完成".into());
    }
    s.cancelled = true;
    s.snapshot.can_cancel = false;
    s.snapshot.message = "正在取消归档或 Bootloader 等待；不会开始擦除…".into();
    Ok(s.snapshot.clone())
}

#[tauri::command]
pub async fn px4_firmware_ports() -> Result<Vec<UsbTarget>, String> {
    crate::run_blocking(ports).await
}
#[tauri::command]
pub fn px4_firmware_status() -> Result<Snapshot, String> {
    status()
}
#[tauri::command]
pub async fn px4_firmware_start(selection_id: u64, target: UsbTarget) -> Result<Snapshot, String> {
    crate::run_blocking(move || start(selection_id, target)).await
}
#[tauri::command]
pub fn px4_firmware_cancel(id: u64) -> Result<Snapshot, String> {
    cancel(id)
}
pub(crate) fn remote_file(path: String) -> Result<Selection, String> {
    (move || {
        if busy() {
            return Err("固件升级进行中".into());
        }
        if !path.to_ascii_lowercase().ends_with(".px4") {
            return Err("请选择 .px4 固件包".into());
        }
        let transport = crate::sim_files::source();
        let host = crate::transport::network_host();
        let managed = crate::sim_files::managed_file_path(&path)?;
        let bytes = crate::sim_files::read_limited(&managed, MAX_PACKAGE)?;
        if crate::sim_files::source() != transport
            || (transport != "usb-bulk" && crate::transport::network_host() != host)
        {
            return Err("读取期间仿真机连接已变化，请重新选择固件".into());
        }
        let source = format!(
            "仿真机 {} · {path}",
            if transport == "usb-bulk" {
                "USB".into()
            } else {
                host.map(|h| h.to_string()).unwrap_or_else(|| "网络".into())
            }
        );
        let firmware=Firmware::parse(path.rsplit('/').next().ok_or("文件名无效")?.to_string(),source,&bytes)?;
        stage_firmware(firmware,host.map(|h|h.to_string()),None)
    })()
}
#[tauri::command]
pub async fn px4_firmware_remote(path: String) -> Result<Selection, String> {
    crate::run_blocking(move || remote_file(path)).await
}
#[tauri::command]
pub async fn px4_firmware_pick(window: tauri::WebviewWindow) -> Result<Option<Selection>, String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let (sender, receiver) =
            tokio::sync::oneshot::channel::<Result<Option<std::path::PathBuf>, String>>();
        let parent = window.clone();
        window
            .run_on_main_thread(move || {
                gtk::glib::MainContext::default().spawn_local(async move {
                    let result = async {
                        let parent = parent.gtk_window().map_err(|e| e.to_string())?;
                        let dialog = gtk::FileChooserNative::new(
                            Some("选择 PX4 固件"),
                            Some(&parent),
                            gtk::FileChooserAction::Open,
                            Some("选择"),
                            Some("取消"),
                        );
                        dialog.set_modal(true);
                        let filter = gtk::FileFilter::new();
                        filter.set_name(Some("PX4 固件包 (*.px4)"));
                        for pattern in ["*.px4", "*.PX4", "*.Px4", "*.pX4"] {
                            filter.add_pattern(pattern);
                        }
                        dialog.add_filter(filter);
                        let response = dialog.run_future().await;
                        let path = if response == gtk::ResponseType::Accept {
                            dialog.filename()
                        } else {
                            None
                        };
                        dialog.destroy();
                        Ok(path)
                    }
                    .await;
                    let _ = sender.send(result);
                });
            })
            .map_err(|e| e.to_string())?;
        match receiver.await.map_err(|e| e.to_string())?? {
            Some(path) => crate::run_blocking(move || local(&path).map(Some)).await,
            None => Ok(None),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Err("此平台暂不支持原生固件选择框".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_job_scoped_and_disabled_before_erasing() {
        {
            let mut s = state().lock().unwrap();
            s.snapshot = Snapshot {
                id: 42,
                running: true,
                can_cancel: true,
                stage: "waiting".into(),
                ..Snapshot::default()
            };
            s.cancelled = false;
        }
        assert!(cancel(41).is_err());
        assert!(!cancelled());
        assert!(!cancel(42).unwrap().can_cancel);
        assert!(cancelled());
        {
            let mut s = state().lock().unwrap();
            s.snapshot.can_cancel = false;
            s.snapshot.stage = "erase".into();
            s.cancelled = false;
        }
        assert!(cancel(42).is_err());
        assert!(!cancelled());
        *state().lock().unwrap() = State::default();
    }
}
