// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod xml_parser;
mod xml_diagnostics;
mod load_diagnostics;
mod xml_generator;
mod expression_xml;
mod sim_client;
mod flight_controller_status;
mod telemetry_recorder;
mod plotjuggler;
mod log_picker;
mod file_index;
mod aircraft_library;
mod dataflow;
mod jsbsim_process;
mod ftp_sync;
mod usb_file;
mod transport;
mod sim_network;
mod model_import;
mod remote_model;
mod firmware_picker;
mod usb_file_picker;
mod usb_file_editor;
mod serial_assistant;

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

// ── Shared application state ────────────────────────────────────────────────

struct AppState {
    sim_client: Mutex<sim_client::SimClient>,
    file_index: Mutex<Option<file_index::FileIndex>>,
    jsbsim: Mutex<jsbsim_process::JsbsimManager>,
}

// The XML index is a rebuildable cache. A previous parser panic can poison
// this mutex without corrupting the cached files; allow later loads to retry.
fn lock_file_index(state: &AppState) -> std::sync::MutexGuard<'_, Option<file_index::FileIndex>> {
    state.file_index.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── Request / Response types ────────────────────────────────────────────────

#[derive(Deserialize)]
struct ParseXmlRequest {
    xml: String,
    #[serde(default)]
    files: Option<Vec<ReferenceFile>>,
}

#[derive(Deserialize)]
struct ReferenceFile {
    name: String,
    xml: String,
    #[serde(default)]
    category: Option<String>,
}

#[derive(Deserialize)]
struct GenerateSubFileRequest {
    #[serde(rename = "type")]
    file_type: String,
    name: String,
    params: serde_json::Value,
}

#[derive(Deserialize)]
struct ParseSubFileRequest {
    xml: String,
    #[serde(rename = "fileType")]
    file_type: String,
}

#[derive(Deserialize)]
struct SaveProjectRequest {
    filename: Option<String>,
    #[serde(flatten)]
    data: serde_json::Value,
}

#[derive(Deserialize)]
struct LoadProjectRequest {
    filename: Option<String>,
}

#[derive(Deserialize)]
struct LoadAircraftRequest {
    #[serde(rename = "aircraftId")]
    aircraft_id: String,
}

#[derive(Deserialize)]
struct ControlMessage {
    #[serde(rename = "override")]
    override_flag: bool,
    channels: Vec<f32>,
}

fn external_sim_mode() -> bool {
    /* This application is packaged primarily as the NuttX upper computer.
     * A release/AppImage does not pass through run-tauri.sh, so requiring
     * SIM_EXTERNAL=1 made its HUD consume remote telemetry while the toolbar
     * queried the stopped local JSBSim manager.  Default to the remote board;
     * local-only development remains available with SIM_EXTERNAL=0. */
    !matches!(
        std::env::var("SIM_EXTERNAL").ok().as_deref(),
        Some("0") | Some("false") | Some("no") | Some("FALSE") | Some("NO")
    )
}

/* USB and FTP calls are blocking.  Execute them on the runtime's blocking
 * pool so a device timeout cannot stop the desktop window from repainting. */
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("background I/O task failed: {error}"))?
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn select_model_import(window: tauri::WebviewWindow, directory: bool, initial_directory: Option<String>) -> Result<Option<model_import::ModelImport>, String> {
    #[cfg(target_os = "linux")]
    { model_import::pick_model(window, directory, initial_directory).await }
    #[cfg(not(target_os = "linux"))]
    { let _ = (window, directory, initial_directory); Err("此平台暂不支持原生目录扫描，请使用文件多选导入。".into()) }
}

#[tauri::command]
fn generate_xml(data: serde_json::Value) -> Result<serde_json::Value, String> {
    match xml_generator::generate_xml(&data) {
        Ok(xml) => Ok(serde_json::json!({ "xml": xml })),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn parse_xml(
    app: tauri::AppHandle,
    xml: String,
    files: Option<Vec<ReferenceFile>>,
    source_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let source_name = source_name.as_deref().unwrap_or("model.xml");
    xml_diagnostics::validate(&xml, source_name)?;
    if let Some(files) = &files {
        for file in files { xml_diagnostics::validate(&file.xml, &file.name)?; }
    }
    let state = app.state::<AppState>();
    let mut index_guard = lock_file_index(&state);
    let file_index = index_guard.get_or_insert_with(|| file_index::build_file_index());

    let package_files: Vec<serde_json::Value> = files.as_ref().map(|items| items.iter().map(|file| {
        let lower = file.name.to_ascii_lowercase();
        let selected_category = file.category.as_deref().filter(|category| {
            matches!(*category, "initialization" | "model-config" | "system" | "engine" | "companion")
        });
        let category = if let Some(category) = selected_category {
            category
        } else if lower.ends_with("reset.xml") || lower.ends_with("initfile.xml")
            || file.xml.contains("<initialize") {
            "initialization"
        } else if lower.ends_with("-set.xml") {
            "model-config"
        } else if lower.contains("/systems/") || lower.starts_with("systems/") {
            "system"
        } else if lower.contains("/engine/") || lower.starts_with("engine/") {
            "engine"
        } else {
            "companion"
        };
        serde_json::json!({ "path": file.name, "category": category, "xml": file.xml })
    }).collect()).unwrap_or_default();

    let mut file_map = std::collections::HashMap::new();
    if let Some(user_files) = files {
        for f in user_files {
            file_map.insert(f.name.clone(), f.xml.clone());
            let base = f.name.split('/').last().unwrap_or(&f.name);
            file_map.insert(base.to_string(), f.xml.clone());
            let no_ext = base.trim_end_matches(".xml");
            file_map.insert(no_ext.to_string(), f.xml);
        }
    }
    for (key, content) in file_index.iter() {
        if !file_map.contains_key(key) {
            file_map.insert(key.clone(), content.clone());
        }
    }

    drop(index_guard);

    match xml_parser::parse_xml(&xml, &file_map) {
        Ok(mut result) => {
            result["packageFiles"] = serde_json::Value::Array(package_files);
            Ok(result)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn get_jsbsim_files(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let mut index_guard = lock_file_index(&state);
    let file_index = index_guard.get_or_insert_with(|| file_index::build_file_index());

    let mut seen = std::collections::HashSet::new();
    let mut files: Vec<serde_json::Value> = Vec::new();
    for (key, content) in file_index.iter() {
        if key.contains('/') && seen.insert(key.clone()) {
            files.push(serde_json::json!({
                "path": key,
                "size": content.len()
            }));
        }
    }
    files.sort_by(|a, b| a["path"].as_str().unwrap().cmp(b["path"].as_str().unwrap()));
    Ok(serde_json::json!({ "files": files, "total": files.len() }))
}

#[tauri::command]
fn generate_subfile(req: GenerateSubFileRequest) -> Result<serde_json::Value, String> {
    match xml_generator::generate_subfile_xml(&req.file_type, &req.name, &req.params) {
        Ok(xml) => Ok(serde_json::json!({ "xml": xml })),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn parse_subfile(req: ParseSubFileRequest) -> Result<serde_json::Value, String> {
    match expression_xml::parse_subfile_xml(&req.xml, &req.file_type) {
        Ok(result) => Ok(result),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn save_project(
    app: tauri::AppHandle,
    filename: Option<String>,
    data: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let projects_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&projects_dir).map_err(|e| e.to_string())?;
    let file_path = projects_dir.join(filename.unwrap_or_else(|| "project.json".into()));
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, json).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "success": true,
        "path": file_path.to_string_lossy()
    }))
}

#[tauri::command]
fn get_project_path(app: tauri::AppHandle, filename: String) -> Result<serde_json::Value, String> {
    let projects_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "path": projects_dir.join(filename).to_string_lossy() }))
}

#[tauri::command]
fn load_project(
    app: tauri::AppHandle,
    filename: Option<String>,
) -> Result<serde_json::Value, String> {
    let projects_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let file_path = projects_dir.join(filename.unwrap_or_else(|| "project.json".into()));
    let data = std::fs::read_to_string(&file_path).map_err(|_| "Project not found".to_string())?;
    let mut json: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| e.to_string())?;
    if let Some(object) = json.as_object_mut() {
        object.insert("_projectPath".into(), serde_json::json!(file_path.to_string_lossy()));
    }
    Ok(json)
}

#[tauri::command]
fn list_projects(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let projects_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    if !projects_dir.exists() {
        return Ok(serde_json::json!([]));
    }
    let files: Vec<String> = std::fs::read_dir(&projects_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "json")
                .unwrap_or(false)
        })
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    Ok(serde_json::json!(files))
}

#[tauri::command]
fn generate_aircraft(data: serde_json::Value) -> Result<serde_json::Value, String> {
    match aircraft_library::generate_aircraft_xml(&data) {
        Ok(xml) => Ok(serde_json::json!({ "xml": xml })),
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn get_aircraft_library() -> Result<serde_json::Value, String> {
    run_blocking(|| {
      if external_sim_mode() {
        let library = ftp_sync::list_models()?.into_iter().map(|name| {
            serde_json::json!({
                "id": name,
                "name": name,
                "directory": name,
                "mainFile": format!("{}.xml", name),
                "filePath": format!("aircraft/{0}/{0}.xml", name),
                "version": "NuttX",
                "release": "remote",
                "description": "NuttX /mnt/sdcard/jsbsim 中的模型",
                "author": "",
                "type": "fixed_wing",
                "size": 0,
                "subFileCount": 0,
                "subFiles": [],
                "remote": true
            })
        }).collect::<Vec<_>>();
        return Ok(serde_json::json!({ "library": library, "source": ftp_sync::transport_source() }));
      }
      match aircraft_library::get_aircraft_library() {
        Ok(library) => Ok(serde_json::json!({ "library": library })),
        Err(e) => Err(e),
      }
    }).await
}

#[tauri::command]
async fn load_aircraft(
    app: tauri::AppHandle,
    aircraft_id: String,
) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let remote_aircraft_id = aircraft_id.clone();
        let (xml, refs) = run_blocking(move || {
            remote_model::load(&remote_aircraft_id, ftp_sync::download_path)
        }).await?;
        let mut result = parse_xml(app.clone(), xml.clone(), Some(refs.iter().map(|file| ReferenceFile {
            name: file.path.clone(), xml: file.xml.clone(), category: None,
        }).collect()), Some(format!("aircraft/{0}/{0}.xml", aircraft_id)))?;
        remote_model::attach_sources(&mut result, &aircraft_id, &xml, &refs);
        return Ok(result);
    }
    let state = app.state::<AppState>();
    let mut index_guard = lock_file_index(&state);
    let file_index = index_guard.get_or_insert_with(|| file_index::build_file_index());

    match aircraft_library::load_aircraft(&aircraft_id, file_index) {
        Ok(result) => Ok(result),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn send_control(app: tauri::AppHandle, msg: ControlMessage) -> Result<(), String> {
    let state = app.state::<AppState>();
    let client = state.sim_client.lock().map_err(|e| e.to_string())?;
    let _ = client.send_control(msg.override_flag, &msg.channels);
    Ok(())
}

#[tauri::command]
fn get_sim_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let client = state.sim_client.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "connected": client.is_connected(),
        "latest": client.latest(),
        "packets": client.packet_count()
    }))
}

#[tauri::command]
fn sim_sync_time(app: tauri::AppHandle, threshold_secs: u64) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let client = state.sim_client.lock().map_err(|e| e.to_string())?;
    let difference = client.sync_clock_if_needed(threshold_secs)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "checked": difference.is_some(),
        "synchronized": difference.map(|value| value != 0).unwrap_or(false),
        "differenceSeconds": difference
    }))
}

/// Parse JSBSim XML into a Simulink-style signal graph.
/// Returns all computation blocks, signal connections, and external I/O.
#[tauri::command]
fn parse_dataflow(
    app: tauri::AppHandle,
    xml: String,
    files: Option<Vec<ReferenceFile>>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let mut index_guard = lock_file_index(&state);
    let file_index = index_guard.get_or_insert_with(|| file_index::build_file_index());

    let mut file_map = std::collections::HashMap::new();
    if let Some(user_files) = files {
        for f in user_files {
            file_map.insert(f.name.clone(), f.xml.clone());
            let base = f.name.split('/').last().unwrap_or(&f.name);
            file_map.insert(base.to_string(), f.xml.clone());
            let no_ext = base.trim_end_matches(".xml");
            file_map.insert(no_ext.to_string(), f.xml);
        }
    }
    for (key, content) in file_index.iter() {
        if !file_map.contains_key(key) {
            file_map.insert(key.clone(), content.clone());
        }
    }

    drop(index_guard);

    dataflow::parse_dataflow_json(&xml, &file_map)
}

// ── JSBSim Process Control Commands ─────────────────────────────────────────

#[derive(Deserialize)]
struct SimStartRequest {
    script: Option<String>,
    model: Option<String>,
}

#[tauri::command]
async fn sim_start(
    app: tauri::AppHandle,
    script: Option<String>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    run_blocking(move || sim_start_blocking(app, script, model)).await
}

fn sim_start_blocking(
    app: tauri::AppHandle,
    script: Option<String>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let state = app.state::<AppState>();
        /* Model load can take 30 seconds.  Do not hold this shared mutex
         * while the background command waits for board confirmation. */
        let client = state.sim_client.lock().map_err(|e| e.to_string())?.clone();
        // MCAP chooses its directory and filename as soon as the bridge loads
        // a model. Synchronize the board clock first so a stale boot clock
        // cannot create logs under an old date such as 2022-03-01.
        client.sync_clock_now().map_err(|e| e.to_string())?;
        let request_id = if let Some(script_name) = script.as_deref() {
            let model_name = model.as_deref()
                .ok_or("The selected script has no associated aircraft model")?;
            client.send_load_script(script_name, model_name).map_err(|e| e.to_string())?
        } else if let Some(model_name) = model.as_deref() {
            client.send_load(model_name).map_err(|e| e.to_string())?
        } else {
            client.send_command(1).map_err(|e| e.to_string())?;
            0
        };
        client.request_lifecycle_state("running");
        let expected_model = model.as_deref()
            .or_else(|| script.as_deref())
            .ok_or("The selected launch has no model")?;
        let result = client.wait_for_running_model(expected_model, request_id, std::time::Duration::from_secs(30));
        if !matches!(result, Ok(true)) {
            client.clear_lifecycle_request("running");
            if let Err(error) = result { return Err(error); }
            return Err(format!(
                "NuttX did not confirm model '{}' running within 30 seconds",
                expected_model
            ));
        }
        return Ok(serde_json::json!({"running": true, "external": true,
                                     "script": script, "model": model}));
    }
    let state = app.state::<AppState>();
    let manager = state.jsbsim.lock().map_err(|e| e.to_string())?;

    match (script, model) {
        (Some(s), _) => {
            manager.start_script(&s, app.clone())?;
            Ok(serde_json::json!({ "running": true, "script": s }))
        }
        (None, Some(m)) => {
            manager.start_model(&m, app.clone())?;
            Ok(serde_json::json!({ "running": true, "model": m }))
        }
        (None, None) => Err("Either 'script' or 'model' must be provided".to_string()),
    }
}

#[tauri::command]
fn sim_pause(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let state = app.state::<AppState>();
        let client = state.sim_client.lock().map_err(|e| e.to_string())?.clone();
        client.request_lifecycle_state("paused");
        client.send_lifecycle_command(3, "paused", std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?;
        if !client.wait_for_lifecycle_state("paused", std::time::Duration::from_secs(3)) {
            // A script may finish between opening the menu and sending PAUSE.
            // In that case the bridge correctly reports stopped, not paused.
            if client.latest_sim_status().and_then(|frame|
                frame.get("state").and_then(|value| value.as_str()).map(|state| state == "stopped")
            ).unwrap_or(false) {
                client.clear_lifecycle_request("paused");
                return Ok(serde_json::json!({"running": false, "paused": false, "stopped": true}));
            }
            // Older bridge builds do not send the immediate control_ack.
            // A stopped simulation clock is independent confirmation that
            // PAUSE took effect, so retain compatibility with those builds.
            if !client.simulation_is_advancing() {
                client.clear_lifecycle_request("paused");
                return Ok(serde_json::json!({"running": true, "paused": true}));
            }
            client.clear_lifecycle_request("paused");
            return Err("仿真机未确认暂停，请检查 UDP 控制与回传连接".to_string());
        }
        return Ok(serde_json::json!({"running": true, "paused": true}));
    }
    let state = app.state::<AppState>();
    let manager = state.jsbsim.lock().map_err(|e| e.to_string())?;
    manager.pause()?;
    Ok(serde_json::json!({ "running": true, "paused": true }))
}

#[tauri::command]
fn sim_resume(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let state = app.state::<AppState>();
        let client = state.sim_client.lock().map_err(|e| e.to_string())?.clone();
        client.request_lifecycle_state("running");
        client.send_lifecycle_command(4, "running", std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?;
        if !client.wait_for_lifecycle_state("running", std::time::Duration::from_secs(3)) {
            client.clear_lifecycle_request("running");
            return Err("仿真机未确认继续，请检查 UDP 控制与回传连接".to_string());
        }
        return Ok(serde_json::json!({"running": true, "paused": false}));
    }
    let state = app.state::<AppState>();
    let manager = state.jsbsim.lock().map_err(|e| e.to_string())?;
    manager.resume()?;
    Ok(serde_json::json!({ "running": true, "paused": false }))
}

#[tauri::command]
async fn sim_restart(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
  run_blocking(move || {
    if external_sim_mode() {
        let state = app.state::<AppState>();
        let client = state.sim_client.lock().map_err(|e| e.to_string())?.clone();
        let request = client.send_restart().map_err(|e| e.to_string())?;
        client.request_lifecycle_state("running");
        let result = client.wait_for_running_model("", request, Duration::from_secs(30));
        if !matches!(result, Ok(true)) {
            client.clear_lifecycle_request("running");
            return Err(result.err().unwrap_or_else(|| "仿真机未在 30 秒内确认重新加载成功".into()));
        }
        return Ok(serde_json::json!({"running": true, "restarting": true, "external": true}));
    }
    let state = app.state::<AppState>();
    let manager = state.jsbsim.lock().map_err(|e| e.to_string())?;
    manager.restart(app.clone())?;
    Ok(serde_json::json!({ "running": true }))
  }).await
}

#[tauri::command]
fn sim_stop(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let state = app.state::<AppState>();
        let client = state.sim_client.lock().map_err(|e| e.to_string())?.clone();
        client.request_lifecycle_state("stopped");
        client.send_lifecycle_command(2, "stopped", std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?;
        if !client.wait_for_lifecycle_state("stopped", std::time::Duration::from_secs(3))
            && client.simulation_is_advancing()
        {
            client.clear_lifecycle_request("stopped");
            return Err("仿真机未确认停止，请检查 UDP 控制与回传连接".to_string());
        }
        client.clear_lifecycle_request("stopped");
        return Ok(serde_json::json!({"running": false, "external": true}));
    }
    let state = app.state::<AppState>();
    let manager = state.jsbsim.lock().map_err(|e| e.to_string())?;
    manager.stop()?;
    Ok(serde_json::json!({ "running": false }))
}

fn nsh_execute_tcp(command: &str) -> Result<String, String> {
    let log_info = command.starts_with("jsbsim --mcap-info ");
    let host = transport::network_host_override().map(|address| address.to_string())
        .unwrap_or_else(|| std::env::var("SIM_UDP_HOST")
            .unwrap_or_else(|_| "192.168.101.81".to_owned()));
    let port = std::env::var("NSH_TELNET_PORT")
        .ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(23);
    let address: SocketAddr = format!("{}:{}", host, port).parse()
        .map_err(|_| format!("invalid NSH target {}:{}", host, port))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| format!("cannot connect to NuttX NSH: {}", error))?;
    stream.set_read_timeout(Some(Duration::from_millis(250))).map_err(|e| e.to_string())?;
    stream.write_all(command.as_bytes()).and_then(|_| stream.write_all(b"\n"))
        .map_err(|error| format!("cannot send NSH command: {}", error))?;
    let mut output = Vec::new();
    let mut buffer = [0u8; 1024];
    let deadline = Instant::now() + Duration::from_secs(if log_info { 6 } else { 2 });
    let mut interrupted = false;
    loop {
        if Instant::now() >= deadline || output.len() >= 16384 {
            /* Commands such as `top` continuously refresh the terminal.
             * This console executes one command per connection, so stop the
             * remote foreground command rather than leaving the UI waiting
             * forever for a prompt that will never arrive. */
            let _ = stream.write_all(&[0x03]);
            interrupted = true;
            break;
        }
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => {
                output.extend_from_slice(&buffer[..length]);
                if log_info && output.iter().rposition(|byte| *byte == b'\n').is_some_and(|end| {
                    output[..end].windows(b"MCAP_INFO:".len()).any(|part| part == b"MCAP_INFO:") ||
                    output[..end].windows(b"MCAP_INFO_ERROR:".len()).any(|part| part == b"MCAP_INFO_ERROR:") ||
                    output[..end].windows(b"Unknown option: --mcap-info".len()).any(|part| part == b"Unknown option: --mcap-info")
                }) { break; }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock ||
                          error.kind() == std::io::ErrorKind::TimedOut => {
                if !log_info { break; }
            },
            Err(error) => return Err(format!("cannot read NSH output: {}", error)),
        }
    }

    /* Do not close an idle Telnet socket underneath nsh_session: it would
     * make the board print `readline failed` and reset the TCP state.  End
     * the shell session cleanly after this one-shot command instead. */
    if command != "exit" {
        let _ = stream.write_all(b"exit\n");
        let cleanup_deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < cleanup_deadline {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => output.extend_from_slice(&buffer[..length]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock ||
                              error.kind() == std::io::ErrorKind::TimedOut => break,
                Err(_) => break,
            }
        }
    }
    let mut text = String::from_utf8_lossy(&output).replace('\r', "");
    if interrupted {
        text.push_str(&format!("\n[continuous output stopped after {} seconds; Ctrl+C sent]\n",
                               if log_info { 6 } else { 2 }));
    }
    Ok(text)
}

fn nsh_execute_inner(command: &str) -> Result<String, String> {
    if command.trim().is_empty() || command.len() > 512 || command.contains(['\r', '\n']) {
        return Err("NSH command must be one non-empty line of at most 512 bytes".to_owned());
    }

    match transport::mode() {
        transport::TransportMode::Usb => usb_file::nsh_execute(command),
        transport::TransportMode::Network => nsh_execute_tcp(command),
        transport::TransportMode::Auto => usb_file::nsh_execute(command)
            .or_else(|usb_error| nsh_execute_tcp(command).map_err(|network_error| {
                format!("USB NSH unavailable ({usb_error}); network NSH unavailable ({network_error})")
            })),
    }
}

#[tauri::command]
async fn nsh_execute(command: String) -> Result<String, String> {
    run_blocking(move || nsh_execute_inner(&command)).await
}

#[tauri::command]
async fn usb_console_read(cursor: u64) -> Result<usb_file::ConsoleChunk, String> {
    run_blocking(move || usb_file::console_read(cursor)).await
}

#[tauri::command]
async fn sim_network_read(app: tauri::AppHandle) -> Result<Vec<sim_network::Interface>, String> {
    let interfaces = run_blocking(sim_network::read).await?;
    if let Some(eth0) = interfaces.iter().find(|item| item.name == "eth0") {
        let host: std::net::Ipv4Addr = eth0.address.parse().map_err(|_| "Invalid simulator IP readback")?;
        if !host.is_unspecified() {
            transport::set_network_host_override(host);
            app.state::<AppState>().sim_client.lock().map_err(|e| e.to_string())?.set_control_host(host);
        }
    }
    Ok(interfaces)
}

#[tauri::command]
async fn sim_network_set(app: tauri::AppHandle, name: String, address: String, netmask: String, gateway: String) -> Result<sim_network::Interface, String> {
    let actual = run_blocking(move || sim_network::set(&name, &address, &netmask, &gateway)).await?;
    if actual.name == "eth0" {
        let host = actual.address.parse().map_err(|_| "Invalid simulator IP readback")?;
        transport::set_network_host_override(host);
        let state = app.state::<AppState>();
        state.sim_client.lock().map_err(|e| e.to_string())?.set_control_host(host);
    }
    Ok(actual)
}

#[tauri::command]
fn sim_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let state = app.state::<AppState>();
        let client = state.sim_client.lock().map_err(|e| e.to_string())?;
        let connected = client.is_connected();
        let task_alive = client.jsbsim_task_alive();
        /* task_top and other auxiliary UDP packets do not contain a
         * lifecycle state.  Use the last full visual telemetry frame so a
         * STOP acknowledgement cannot be overwritten by a later task_top
         * packet and make the Start/Stop control flicker. */
        let latest = client.latest_sim_status();
        /* Pending lifecycle requests take precedence over old packets. Once
         * a matching heartbeat acknowledges the request, the heartbeat state
         * becomes authoritative for natural completion and pause/stop. */
        let lifecycle_state = client.lifecycle_state();
        /* START/LOAD is acknowledged before XML and RunIC finish.  Expose
         * the board's explicit loading heartbeat even while the local
         * running request is pending. */
        let board_loading = connected && latest.as_ref()
            .and_then(|frame| frame.get("state"))
            .and_then(|state| state.as_str()) == Some("loading");
        let remote_state = if board_loading {
            "loading".to_owned()
        } else if task_alive == Some(false) {
            "crashed".to_owned()
        } else if lifecycle_state.as_deref() == Some("stopped") {
            /* The periodic communication-task heartbeat is authoritative.
             * A recently advancing timestamp remains true briefly after a
             * script ends and must not keep the Stop button selected. */
            "stopped".to_owned()
        } else if lifecycle_state.as_deref() == Some("paused") {
            "paused".to_owned()
        } else if client.simulation_is_advancing() {
            /* Timestamp progression proves the FDM is executing.  Prefer it
             * to any lifecycle label that could have been queued before a
             * model reload or a dropped control acknowledgement. */
            "running".to_owned()
        } else {
            // A naturally completed script publishes `stopped` and then no
            // longer advances its simulation clock. Do not let an old
            // optimistic `running` request mask that terminal state.
            lifecycle_state
                .unwrap_or_else(|| if connected {
                    "waiting".to_owned()
                } else {
                    "disconnected".to_owned()
                })
        };
        let model = latest.as_ref()
            .and_then(|value| value.get("model"))
            .and_then(|value| value.as_str());
        let cpu = client.jsbsim_cpu_load();
        let cpu_cores = client.cpu_core_loads();
        let health_age_ms = client.health_packet_age_ms();
        let memory = client.memory_usage();
        let fdm_run_ms = client.fdm_run_ms();
        let simulation_dt = client.simulation_dt();
        let flight_controller = client.flight_controller_status();
        return Ok(serde_json::json!({
            "external": true,
            /* Lifecycle and transport health are independent.  A brief UDP
             * timeout must not turn a running model's Stop button back into
             * Start; the connection chip reports `connected` separately. */
            "running": remote_state == "running" || remote_state == "paused",
            "paused": remote_state == "paused",
            "stopped": remote_state == "stopped",
            "state": remote_state,
            "connected": connected,
            "taskAlive": task_alive,
            "model": model,
            "packets": client.packet_count(),
            "cpu": cpu,
            "cpuCores": cpu_cores,
            "healthAgeMs": health_age_ms,
            "memory": memory,
            "network": client.network_counters(),
            "mcap": client.mcap_status(),
            "fdmRunMs": fdm_run_ms,
            "fdmWindow": client.fdm_window_stats(),
            "simulationDt": simulation_dt,
            "flightController": flight_controller,
        }));
    }
    let state = app.state::<AppState>();
    let manager = state.jsbsim.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "running": manager.is_running(),
        "paused": manager.is_paused(),
        "script": manager.current_script(),
        "model": manager.current_model(),
    }))
}

#[tauri::command]
async fn sim_list_tests() -> Result<serde_json::Value, String> {
    run_blocking(|| {
      if external_sim_mode() {
        let tests = ftp_sync::list_scripts()?.into_iter().map(|file| {
            let name = file.trim_end_matches(".xml");
            serde_json::json!({
                "name": name,
                "file": file,
                "path": format!("scripts/{}", file),
                "remote": true
            })
        }).collect::<Vec<_>>();
        return Ok(serde_json::json!({ "tests": tests, "source": ftp_sync::transport_source() }));
      }
      let tests = jsbsim_process::JsbsimManager::list_tests()?;
      Ok(serde_json::json!({ "tests": tests }))
    }).await
}

#[tauri::command]
async fn sim_list_models() -> Result<serde_json::Value, String> {
    run_blocking(|| {
      if external_sim_mode() {
        let models = ftp_sync::list_models()?.into_iter().map(|name| {
            serde_json::json!({
                "name": name,
                "file": format!("{}.xml", name),
                "path": name,
                "remote": true
            })
        }).collect::<Vec<_>>();
        return Ok(serde_json::json!({ "models": models, "source": ftp_sync::transport_source() }));
      }
      let models = jsbsim_process::JsbsimManager::list_models()?;
      Ok(serde_json::json!({ "models": models }))
    }).await
}

#[tauri::command]
async fn ftp_download_model(model: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let xml = ftp_sync::download_model(&model)?;
        Ok(serde_json::json!({ "model": model, "xml": xml, "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn ftp_download_xml(path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let content = ftp_sync::download_path(&path)?;
        Ok(serde_json::json!({ "path": path, "content": content, "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn ftp_get_simulator_version() -> Result<serde_json::Value, String> {
    run_blocking(|| {
        let content = ftp_sync::download_simulator_version()?;
        let version: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("invalid simulator VERSION.json: {e}"))?;
        Ok(serde_json::json!({ "version": version, "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn ftp_list_systems() -> Result<serde_json::Value, String> {
    run_blocking(|| {
        let files = ftp_sync::list_systems()?;
        Ok(serde_json::json!({ "files": files, "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn ftp_list_xml_parent(parent: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let files = ftp_sync::list_xml_parent(&parent)?;
        Ok(serde_json::json!({ "exists": files.is_some(), "files": files.unwrap_or_default(), "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn ftp_list_engines() -> Result<serde_json::Value, String> {
    run_blocking(|| {
        let (engines, propellers) = ftp_sync::list_engine_catalog()?;
        Ok(serde_json::json!({ "engines": engines, "propellers": propellers, "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn ftp_list_dsdl() -> Result<serde_json::Value, String> {
    run_blocking(|| Ok(serde_json::json!({ "files": ftp_sync::list_dsdl_files()?, "root": "/mnt/sdcard/dsdl/px4", "source": ftp_sync::transport_source() }))).await
}

#[tauri::command]
async fn ftp_list_logs() -> Result<serde_json::Value, String> {
    run_blocking(|| Ok(serde_json::json!({ "files": ftp_sync::list_logs()?, "root": "/mnt/sdcard/LOG", "source": ftp_sync::transport_source() }))).await
}

#[tauri::command]
async fn ftp_log_info(file: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let command = ftp_sync::log_info_command(&file)?;
        // MCAP inspection can spend several seconds seeking on the SD card.
        // Prefer Ethernet even when live simulation uses USB, so previewing a
        // log never has to monopolize the USB telemetry interface.
        let network_result = nsh_execute_tcp(&command);
        let output = match network_result {
            Ok(output) if output.contains("MCAP_INFO:") || output.contains("MCAP_INFO_ERROR:") ||
                          output.contains("Unknown option: --mcap-info") => output,
            Ok(output) if transport::mode() == transport::TransportMode::Network => output,
            Err(error) if transport::mode() == transport::TransportMode::Network => return Err(error),
            other => usb_file::nsh_execute(&command).map_err(|usb_error| {
                let network_error = other.err().unwrap_or_else(|| "任务机网口未返回 MCAP 信息".into());
                format!("网口读取失败：{network_error}；USB 备用读取失败：{usb_error}")
            })?,
        };
        if let Some(error) = output.lines().find_map(|line| line.find("MCAP_INFO_ERROR:").map(|position| &line[position + "MCAP_INFO_ERROR:".len()..])) {
            return Err(error.trim().to_string());
        }
        if output.contains("Unknown option: --mcap-info") {
            return Err("任务机固件尚不支持读取 MCAP 信息；下载和 PlotJuggler 查看仍可使用".into());
        }
        let json = output.lines().find_map(|line| line.find("MCAP_INFO:").map(|position| &line[position + "MCAP_INFO:".len()..]))
            .ok_or_else(|| format!("任务机没有返回 MCAP 信息：{}", output.trim()))?;
        serde_json::from_str(json).map_err(|error| format!("无法解析任务机 MCAP 信息：{error}"))
    }).await
}

#[tauri::command]
async fn ftp_download_log(app: tauri::AppHandle, file: String, directory: Option<String>, expected_size: Option<u64>, for_viewing: Option<bool>) -> Result<serde_json::Value, String> {
    run_blocking(move || {
    let partial = ftp_sync::log_download_partial_path(&file, directory.as_deref())?;
    let monitoring = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let monitor_flag = monitoring.clone();
    let monitor_app = app.clone();
    let monitor_file = file.clone();
    let monitor = std::thread::spawn(move || {
        let mut last_bytes = None;
        while monitor_flag.load(std::sync::atomic::Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(250));
            if let Ok(metadata) = std::fs::metadata(&partial) {
                let bytes = metadata.len();
                if last_bytes != Some(bytes) {
                    let _ = monitor_app.emit("ftp-log-download-progress", serde_json::json!({
                        "file": monitor_file, "bytes": bytes
                    }));
                    last_bytes = Some(bytes);
                }
            }
        }
    });
    let downloaded = ftp_sync::download_log(&file, directory.as_deref(), expected_size, for_viewing.unwrap_or(true));
    monitoring.store(false, std::sync::atomic::Ordering::Relaxed);
    let _ = monitor.join();
    let path = downloaded?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("cannot inspect downloaded log: {e}"))?;
    Ok(serde_json::json!({ "file": file, "path": path, "size": metadata.len(), "hasMcapMarkers": ftp_sync::complete_mcap_file(std::path::Path::new(&path)) }))
    }).await
}

#[tauri::command]
async fn plotjuggler_open_log(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("plotjuggler");
    run_blocking(move || plotjuggler::open_log(std::path::Path::new(&path), &directory)).await
}

#[tauri::command]
async fn plotjuggler_pick_log(window: tauri::WebviewWindow) -> Result<Option<log_picker::LogSelection>, String> {
    #[cfg(target_os = "linux")]
    { log_picker::pick_log(window).await }
    #[cfg(not(target_os = "linux"))]
    { let _ = window; Err("当前仅支持 Linux 桌面版".into()) }
}

#[tauri::command]
async fn plotjuggler_list_downloaded_logs(directory: Option<String>) -> Result<Vec<log_picker::LogSelection>, String> {
    run_blocking(move || log_picker::list_downloaded_logs(directory.as_deref())).await
}

#[tauri::command]
async fn ftp_delete_log(file: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        ftp_sync::delete_log(&file)?;
        Ok(serde_json::json!({ "file": file, "deleted": true }))
    }).await
}

#[tauri::command]
async fn ftp_download_dsdl(file: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let content = ftp_sync::download_dsdl(&file)?;
        Ok(serde_json::json!({ "file": file, "content": content, "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn ftp_upload_file(path: String, content: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        ftp_sync::upload_file(&path, &content)?;
        Ok(serde_json::json!({ "path": path, "uploaded": true, "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn ftp_upload_model_assets(source_directory: String, model: String, expected_files: Vec<String>) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let paths = model_import::scan_model_assets(std::path::Path::new(&source_directory))?;
        let actual_files = paths.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>();
        if actual_files != expected_files { return Err("模型资源列表在导入后发生变化，请重新导入模型".into()); }
        let assets = paths.into_iter().map(|(name, path)| {
            std::fs::read(&path).map(|bytes| (name, bytes))
                .map_err(|e| format!("无法读取模型资源 {}: {e}", path.display()))
        }).collect::<Result<Vec<_>, _>>()?;
        let mut uploaded = Vec::new();
        for (name, bytes) in assets {
            ftp_sync::upload_model_asset(&model, &name, &bytes)?;
            uploaded.push(format!("/mnt/sdcard/jsbsim/aircraft/{model}/{name}"));
        }
        Ok(serde_json::json!({ "files": uploaded, "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn check_model_assets(source_directory: String, expected_files: Vec<String>) -> Result<(), String> {
    run_blocking(move || {
        let paths = model_import::scan_model_assets(std::path::Path::new(&source_directory))?;
        if paths.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>() != expected_files {
            return Err("模型资源列表在导入后发生变化，请重新导入模型".into());
        }
        for (_, path) in paths {
            std::fs::read(&path).map_err(|e| format!("无法读取模型资源 {}: {e}", path.display()))?;
        }
        Ok(())
    }).await
}

#[tauri::command]
async fn ftp_download_script(file: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let xml = ftp_sync::download_script(&file)?;
        Ok(serde_json::json!({ "file": file, "xml": xml, "source": ftp_sync::transport_source() }))
    }).await
}

#[tauri::command]
async fn ftp_upload_model(model: String, xml: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        ftp_sync::upload_model(&model, &xml)?;
        Ok(serde_json::json!({ "model": model, "uploaded": true }))
    }).await
}

#[tauri::command]
async fn ftp_download_sim_config(path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let content = ftp_sync::download_config(&path)?;
        Ok(serde_json::json!({"path": path, "content": content}))
    }).await
}

#[tauri::command]
async fn ftp_upload_sim_config(path: String, content: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        ftp_sync::upload_config(&path, &content)?;
        Ok(serde_json::json!({"path": path, "saved": true}))
    }).await
}

#[tauri::command]
async fn usb_file_status() -> Result<usb_file::UsbStatus, String> {
    run_blocking(|| Ok(usb_file::status())).await
}

#[tauri::command]
async fn usb_file_ping() -> Result<serde_json::Value, String> {
    run_blocking(|| Ok(serde_json::json!({ "identity": usb_file::ping()?, "source": "usb-bulk" }))).await
}

#[tauri::command]
async fn usb_file_list(path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || Ok(serde_json::json!({ "path": path, "files": usb_file::list(&path)?, "source": "usb-bulk" }))).await
}

#[tauri::command]
async fn usb_file_list_with_modified(path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || Ok(serde_json::json!({ "path": path, "files": usb_file::list_with_modified(&path)?, "source": "usb-bulk" }))).await
}

#[tauri::command]
async fn usb_file_read(path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let bytes = usb_file::read_all(&path)?;
        Ok(serde_json::json!({ "path": path, "bytes": bytes, "source": "usb-bulk" }))
    }).await
}

#[tauri::command]
async fn usb_file_write(path: String, bytes: Vec<u8>) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        usb_file::write_all(&path, &bytes)?;
        Ok(serde_json::json!({ "path": path, "size": bytes.len(), "saved": true, "source": "usb-bulk" }))
    }).await
}

#[tauri::command]
async fn usb_file_delete(path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        usb_file::delete(&path)?;
        Ok(serde_json::json!({ "path": path, "deleted": true, "source": "usb-bulk" }))
    }).await
}

#[tauri::command]
async fn usb_file_delete_directory(path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        usb_file::delete_directory_tree(&path)?;
        Ok(serde_json::json!({ "path": path, "deleted": true, "source": "usb-bulk" }))
    }).await
}

#[tauri::command]
async fn usb_file_mkdir(path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        usb_file::mkdir(&path)?;
        Ok(serde_json::json!({ "path": path, "created": true, "source": "usb-bulk" }))
    }).await
}

#[tauri::command]
async fn usb_file_transfer(source: String, destination: String, move_source: bool) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        usb_file::transfer(&source, &destination, move_source)?;
        Ok(serde_json::json!({ "source": source, "destination": destination, "moved": move_source }))
    }).await
}

static USB_DOWNLOAD_LOCK: Mutex<()> = Mutex::new(());

fn download_usb_file(path: &str, directory: &str) -> Result<(std::path::PathBuf, u64, u32), String> {
    let _download_guard = USB_DOWNLOAD_LOCK.lock().map_err(|_| "下载锁已损坏")?;
    let name = path.rsplit('/').next().ok_or("文件名无效")?;
    if name.is_empty() || name == "." || name == ".." || name.contains('\\') {
        return Err("文件名无效".into());
    }

    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法确定当前用户主目录")?;
    let requested = directory.strip_prefix("~/")
        .map(|tail| std::path::PathBuf::from(&home).join(tail))
        .unwrap_or_else(|| std::path::PathBuf::from(&directory));
    if !requested.is_absolute() || !requested.starts_with(&home) {
        return Err("下载目录必须位于当前用户主目录内".into());
    }
    if requested.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("下载目录不能包含上级路径".into());
    }
    std::fs::create_dir_all(&requested).map_err(|e| format!("创建下载目录失败: {e}"))?;
    let requested = requested.canonicalize().map_err(|e| e.to_string())?;
    let home = std::path::Path::new(&home).canonicalize().map_err(|e| e.to_string())?;
    if !requested.starts_with(home) {
        return Err("下载目录必须位于当前用户主目录内".into());
    }

    let original = std::path::Path::new(name);
    let stem = original.file_stem().and_then(|value| value.to_str()).unwrap_or(name);
    let extension = original.extension().and_then(|value| value.to_str());
    let mut target = requested.join(name);
    for number in 1..=1000 {
        if !target.exists() { break; }
        let candidate = match extension {
            Some(ext) => format!("{stem} ({number}).{ext}"),
            None => format!("{stem} ({number})"),
        };
        target = requested.join(candidate);
    }
    if target.exists() { return Err("下载目录中已有过多同名文件".into()); }

    let partial = requested.join(format!(".{}.usbpart", target.file_name().unwrap().to_string_lossy()));
    let (size, checksum) = match usb_file::download_to_fingerprint(path, &partial) {
        Ok(result) => result,
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
    };
    if let Err(error) = std::fs::rename(&partial, &target) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("保存下载文件失败: {error}"));
    }
    Ok((target, size, checksum))
}

#[tauri::command]
async fn usb_file_download(path: String, directory: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let (target, size, _) = download_usb_file(&path, &directory)?;
        Ok(serde_json::json!({ "path": path, "localPath": target.to_string_lossy(), "size": size }))
    }).await
}

#[tauri::command]
async fn usb_file_open_editor(window: tauri::WebviewWindow, path: String, directory: String)
    -> Result<Option<usb_file_editor::EditorSessionInfo>, String> {
    usb_file_editor::open(window, path, directory).await
}

#[tauri::command]
async fn usb_file_open_builtin(path: String) -> Result<usb_file_editor::BuiltInDocument, String> {
    run_blocking(move || usb_file_editor::open_builtin(&path)).await
}

#[tauri::command]
async fn usb_file_save_builtin(path: String, content: String, expected_size: u64, expected_checksum: u32)
    -> Result<usb_file_editor::BuiltInSaveResult, String> {
    run_blocking(move || usb_file_editor::save_builtin(&path, content, expected_size, expected_checksum)).await
}

#[tauri::command]
async fn usb_file_edit_sessions() -> Result<Vec<usb_file_editor::EditorSessionInfo>, String> {
    run_blocking(usb_file_editor::sessions).await
}

#[tauri::command]
async fn usb_file_save_editor(id: String) -> Result<usb_file_editor::EditorSaveResult, String> {
    run_blocking(move || usb_file_editor::save(&id)).await
}

#[tauri::command]
async fn usb_file_finish_editor(id: String) -> Result<(), String> {
    usb_file_editor::finish(&id)
}

#[tauri::command]
async fn usb_file_upload_local(
    window: tauri::WebviewWindow,
    directory: String,
    previous_path: Option<String>,
) -> Result<Option<usb_file_picker::UsbUploadSelection>, String> {
    usb_file_picker::pick_and_upload(window, directory, previous_path).await
}

#[tauri::command]
async fn usb_file_upload_folder(
    window: tauri::WebviewWindow,
    directory: String,
    previous_path: Option<String>,
) -> Result<Option<usb_file_picker::UsbFolderUploadSelection>, String> {
    usb_file_picker::pick_and_upload_folder(window, directory, previous_path).await
}

const FIRMWARE_REMOTE_PATH: &str = "fireware/nuttx.bin";
const FIRMWARE_MIN_SIZE: usize = 64 * 1024;
const FIRMWARE_MAX_SIZE: usize = 64 * 1024 * 1024;

#[tauri::command]
async fn select_firmware_file(window: tauri::WebviewWindow, previous_path: Option<String>) -> Result<Option<firmware_picker::FirmwareSelection>, String> {
    #[cfg(target_os = "linux")]
    { firmware_picker::pick_firmware(window, previous_path).await }
    #[cfg(not(target_os = "linux"))]
    { let _ = (window, previous_path); Err("此平台暂不支持原生固件选择框".into()) }
}

#[tauri::command]
async fn firmware_stage_file(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let selected = firmware_picker::inspect_firmware(std::path::Path::new(&path))?;
        if selected.size < FIRMWARE_MIN_SIZE as u64 || selected.size > FIRMWARE_MAX_SIZE as u64 {
            return Err("firmware size must be between 64 KiB and 64 MiB".into());
        }
        let bytes = std::fs::read(&selected.path).map_err(|e| format!("无法读取固件文件: {e}"))?;
        stage_firmware_bytes(&app, selected.name, bytes)
    }).await
}

#[tauri::command]
async fn firmware_stage(
    app: tauri::AppHandle,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<serde_json::Value, String> {
    run_blocking(move || stage_firmware_bytes(&app, file_name, bytes)).await
}

fn stage_firmware_bytes(app: &tauri::AppHandle, file_name: String, bytes: Vec<u8>) -> Result<serde_json::Value, String> {
    if !file_name.to_ascii_lowercase().ends_with(".bin") {
        return Err("firmware file must have a .bin extension".to_owned());
    }
    if bytes.len() < FIRMWARE_MIN_SIZE || bytes.len() > FIRMWARE_MAX_SIZE {
        return Err(format!(
            "firmware size must be between {} and {} bytes",
            FIRMWARE_MIN_SIZE, FIRMWARE_MAX_SIZE
        ));
    }

    let crc32 = usb_file::crc32(&bytes);
    let _ = app.emit("firmware-progress", serde_json::json!({
        "stage": "upload",
        "completed": 0,
        "total": bytes.len()
    }));
    usb_file::write_all_with_progress(FIRMWARE_REMOTE_PATH, &bytes,
        |completed, total| {
            let _ = app.emit("firmware-progress", serde_json::json!({
                "stage": "upload",
                "completed": completed,
                "total": total
            }));
        })?;
    let remote = usb_file::stat(FIRMWARE_REMOTE_PATH)?;
    if remote.directory || remote.size != bytes.len() as u64 {
        return Err(format!(
            "staged firmware size mismatch: local={} remote={}",
            bytes.len(), remote.size
        ));
    }

    Ok(serde_json::json!({
        "fileName": file_name,
        "path": format!("/data/{}", FIRMWARE_REMOTE_PATH),
        "size": remote.size,
        "crc32": crc32,
        "staged": true,
        "source": "usb-bulk"
    }))
}

#[tauri::command]
async fn firmware_apply(
    app: tauri::AppHandle,
    expected_size: u64,
    expected_crc32: u32,
) -> Result<serde_json::Value, String> {
    run_blocking(move || {
        let _ = app.emit("firmware-progress", serde_json::json!({
            "stage": "write",
            "completed": 0,
            "total": expected_size
        }));
        let verification = usb_file::apply_firmware_with_progress(
            FIRMWARE_REMOTE_PATH,
            |progress| {
                let stage = match progress.phase {
                    usb_file::FirmwareUpdatePhase::Write => "write",
                    usb_file::FirmwareUpdatePhase::Verify => "verify",
                };
                let _ = app.emit("firmware-progress", serde_json::json!({
                    "stage": stage,
                    "completed": progress.completed,
                    "total": progress.total
                }));
            },
        )?;
        let expected = format!("size={expected_size} crc32={expected_crc32:08x}");
        if verification.trim() != expected {
            return Err(format!(
                "installed firmware verification mismatch: expected '{expected}', board returned '{}'",
                verification.trim()
            ));
        }

        Ok(serde_json::json!({
            "path": format!("/data/{}", FIRMWARE_REMOTE_PATH),
            "installed": true,
            "verification": verification,
            "rebootRequired": true,
            "source": "usb-bulk"
        }))
    }).await
}

#[tauri::command]
fn simulator_transport_get() -> String {
    transport::mode().as_str().to_string()
}

#[tauri::command]
fn simulator_transport_set(mode: String) -> Result<String, String> {
    Ok(transport::set_mode(&mode)?.as_str().to_string())
}

#[tauri::command]
async fn telemetry_record_start(app: tauri::AppHandle, directory: Option<String>) -> Result<telemetry_recorder::Status, String> {
    let directory = match directory.filter(|path| !path.trim().is_empty()) {
        Some(path) => std::path::PathBuf::from(path),
        None => app.path().document_dir().map_err(|e| e.to_string())?.join("JSBSim").join("Telemetry"),
    };
    run_blocking(move || telemetry_recorder::global().start(&directory)).await
}
#[tauri::command]
async fn telemetry_record_stop() -> Result<telemetry_recorder::Status, String> {
    run_blocking(|| Ok(telemetry_recorder::global().stop())).await
}
#[tauri::command]
fn telemetry_record_status() -> telemetry_recorder::Status { telemetry_recorder::global().status() }

#[tauri::command]
async fn plotjuggler_start(app: tauri::AppHandle) -> Result<plotjuggler::Status, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("plotjuggler");
    run_blocking(move || plotjuggler::global().start(&directory)).await
}
#[tauri::command]
fn plotjuggler_status() -> plotjuggler::Status { plotjuggler::global().status() }
#[tauri::command]
fn plotjuggler_set_rate(rate_hz: u16) -> Result<plotjuggler::Status, String> {
    plotjuggler::global().set_rate(rate_hz)
}

#[tauri::command]
async fn serial_assistant_list_ports() -> Result<Vec<serial_assistant::PortInfo>, String> {
    run_blocking(serial_assistant::list_ports).await
}

#[tauri::command]
async fn serial_assistant_open(config: serial_assistant::PortConfig, on_event: tauri::ipc::Channel<serial_assistant::SerialEvent>)
    -> Result<serial_assistant::SessionInfo, String> {
    run_blocking(move || serial_assistant::global().open(config, on_event)).await
}

#[tauri::command]
async fn serial_assistant_close(session_id: u64) -> Result<(), String> {
    run_blocking(move || serial_assistant::global().close(session_id)).await
}

#[tauri::command]
async fn serial_assistant_write(session_id: u64, bytes: Vec<u8>) -> Result<usize, String> {
    run_blocking(move || serial_assistant::global().write(session_id, bytes)).await
}

#[tauri::command]
async fn serial_assistant_record_start(session_id: u64, path: String) -> Result<(), String> {
    run_blocking(move || serial_assistant::global().start_record(session_id, path)).await
}

#[tauri::command]
async fn serial_assistant_record_stop(session_id: u64) -> Result<(), String> {
    run_blocking(move || serial_assistant::global().stop_record(session_id)).await
}

#[tauri::command]
async fn serial_assistant_set_dtr(session_id: u64, value: bool) -> Result<(), String> {
    run_blocking(move || serial_assistant::global().set_dtr(session_id, value)).await
}

#[tauri::command]
async fn serial_assistant_set_rts(session_id: u64, value: bool) -> Result<(), String> {
    run_blocking(move || serial_assistant::global().set_rts(session_id, value)).await
}

#[tauri::command]
async fn serial_assistant_pick_capture(window: tauri::WebviewWindow, save: bool) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    { serial_assistant::pick_path(window, save).await }
    #[cfg(not(target_os = "linux"))]
    { let _ = (window, save); Err("此平台暂不支持记录文件选择".into()) }
}

#[tauri::command]
async fn serial_assistant_replay(path: String, on_event: tauri::ipc::Channel<serial_assistant::SerialEvent>) -> Result<usize, String> {
    run_blocking(move || serial_assistant::replay(path, on_event)).await
}

#[tauri::command]
async fn serial_assistant_export(window: tauri::WebviewWindow, kind: String, bytes: Vec<u8>) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    { serial_assistant::export(window, kind, bytes).await }
    #[cfg(not(target_os = "linux"))]
    { let _ = (window, kind, bytes); Err("此平台暂不支持原生导出文件选择".into()) }
}

// ── Main ────────────────────────────────────────────────────────────────────

fn main() {
    if std::env::args().any(|argument| argument == "--usb-self-test") {
        match usb_file::ping().and_then(|identity| {
            let entries = usb_file::list("romfs/jsbsim/aircraft")?;
            if !entries.iter().any(|entry| entry.directory && entry.name == "c172x") {
                return Err("ROMFS aircraft listing does not contain c172x".into());
            }
            let simulation_state = usb_file::simulation_self_test()?;
            Ok((identity, entries.len(), simulation_state))
        }) {
            Ok((identity, entry_count, simulation_state)) => {
                println!("USB bulk self-test PASS: {identity}; jsbsim entries={entry_count}; simulation={simulation_state}");
                return;
            }
            Err(error) => {
                eprintln!("USB bulk self-test FAIL: {error}");
                std::process::exit(1);
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let sim_client = sim_client::SimClient::new(5801);
            let app_handle = app.handle().clone();

            // Spawn telemetry broadcast task
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(async move {
                    let mut interval = tokio::time::interval(
                        std::time::Duration::from_millis(33),
                    );
                    let mut last_status: Option<bool> = None;
                    loop {
                        interval.tick().await;
                        let client = {
                            let state = app_handle.state::<AppState>();
                            let guard = state.sim_client.lock().unwrap();
                            guard.clone()
                        };
                        if client.is_connected() {
                            if let Some(data) = client.latest() {
                                let _ = app_handle.emit("telemetry", data);
                            }
                        }
                        let connected = client.is_connected();
                        if last_status != Some(connected) {
                            last_status = Some(connected);
                            let _ = app_handle.emit(
                                "sim-status",
                                serde_json::json!({ "connected": connected }),
                            );
                        }
                    }
                });
            });

            app.manage(AppState {
                sim_client: Mutex::new(sim_client),
                file_index: Mutex::new(None),
                jsbsim: Mutex::new(jsbsim_process::JsbsimManager::new()),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            select_model_import,
            generate_xml,
            parse_xml,
            get_jsbsim_files,
            generate_subfile,
            parse_subfile,
            save_project,
            get_project_path,
            load_project,
            list_projects,
            generate_aircraft,
            get_aircraft_library,
            load_aircraft,
            send_control,
            get_sim_status,
            sim_sync_time,
            parse_dataflow,
            telemetry_record_start,
            telemetry_record_stop,
            telemetry_record_status,
            plotjuggler_start,
            plotjuggler_status,
            plotjuggler_set_rate,
            plotjuggler_open_log,
            plotjuggler_pick_log,
            plotjuggler_list_downloaded_logs,
            sim_start,
            sim_stop,
            nsh_execute,
            usb_console_read,
            sim_network_read,
            sim_network_set,
            sim_status,
            sim_pause,
            sim_resume,
            sim_restart,
            sim_list_tests,
            sim_list_models,
            ftp_download_model,
            ftp_download_xml,
            ftp_get_simulator_version,
            ftp_list_systems,
            ftp_list_xml_parent,
            ftp_list_engines,
            ftp_list_dsdl,
            ftp_list_logs,
            ftp_log_info,
            ftp_download_log,
            ftp_delete_log,
            ftp_download_dsdl,
            ftp_upload_file,
            ftp_upload_model_assets,
            check_model_assets,
            ftp_download_script,
            ftp_upload_model,
            ftp_download_sim_config,
            ftp_upload_sim_config,
            usb_file_status,
            usb_file_ping,
            usb_file_list,
            usb_file_list_with_modified,
            usb_file_read,
            usb_file_write,
            usb_file_delete,
            usb_file_delete_directory,
            usb_file_mkdir,
            usb_file_transfer,
            usb_file_download,
            usb_file_open_editor,
            usb_file_open_builtin,
            usb_file_save_builtin,
            usb_file_edit_sessions,
            usb_file_save_editor,
            usb_file_finish_editor,
            usb_file_upload_local,
            usb_file_upload_folder,
            select_firmware_file,
            firmware_stage_file,
            firmware_stage,
            firmware_apply,
            simulator_transport_get,
            simulator_transport_set,
            serial_assistant_list_ports,
            serial_assistant_open,
            serial_assistant_close,
            serial_assistant_write,
            serial_assistant_record_start,
            serial_assistant_record_stop,
            serial_assistant_set_dtr,
            serial_assistant_set_rts,
            serial_assistant_pick_capture,
            serial_assistant_replay,
            serial_assistant_export,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                telemetry_recorder::global().stop();
                serial_assistant::global().shutdown();
            }
        });
}
