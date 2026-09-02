// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod xml_parser;
mod xml_generator;
mod expression_xml;
mod sim_client;
mod file_index;
mod aircraft_library;
mod dataflow;
mod jsbsim_process;
mod ftp_sync;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

// ── Shared application state ────────────────────────────────────────────────

struct AppState {
    sim_client: Mutex<sim_client::SimClient>,
    file_index: Mutex<Option<file_index::FileIndex>>,
    jsbsim: Mutex<jsbsim_process::JsbsimManager>,
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
    matches!(
        std::env::var("SIM_EXTERNAL").ok().as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("TRUE") | Some("YES")
    )
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

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
) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let mut index_guard = state.file_index.lock().map_err(|e| e.to_string())?;
    let file_index = index_guard.get_or_insert_with(|| file_index::build_file_index());

    let package_files: Vec<serde_json::Value> = files.as_ref().map(|items| items.iter().map(|file| {
        let lower = file.name.to_ascii_lowercase();
        let category = if lower.ends_with("reset.xml") || lower.ends_with("initfile.xml") {
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
    let mut index_guard = state.file_index.lock().map_err(|e| e.to_string())?;
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
fn get_aircraft_library() -> Result<serde_json::Value, String> {
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
        return Ok(serde_json::json!({ "library": library, "source": "nuttx-ftp" }));
    }
    match aircraft_library::get_aircraft_library() {
        Ok(library) => Ok(serde_json::json!({ "library": library })),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn load_aircraft(
    app: tauri::AppHandle,
    aircraft_id: String,
) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let xml = ftp_sync::download_model(&aircraft_id)?;
        let mut refs: Vec<ReferenceFile> = Vec::new();
        let mut cursor = xml.as_str();
        while let Some(start) = cursor.find("file=\"") {
            cursor = &cursor[start + 6..];
            let Some(end) = cursor.find('"') else { break };
            let value = &cursor[..end];
            let stem = value.trim_end_matches(".xml");
            let candidates = [format!("systems/{stem}.xml"), format!("engine/{stem}.xml"), format!("aircraft/{aircraft_id}/{stem}.xml")];
            for path in candidates {
                if let Ok(content) = ftp_sync::download_path(&path) {
                    refs.push(ReferenceFile { name: path, xml: content });
                    break;
                }
            }
            cursor = &cursor[end + 1..];
        }
        let result = parse_xml(app.clone(), xml, Some(refs))?;
        return Ok(result);
    }
    let state = app.state::<AppState>();
    let mut index_guard = state.file_index.lock().map_err(|e| e.to_string())?;
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
    let mut index_guard = state.file_index.lock().map_err(|e| e.to_string())?;
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

    dataflow::parse_dataflow_json(&xml, &file_map)
}

// ── JSBSim Process Control Commands ─────────────────────────────────────────

#[derive(Deserialize)]
struct SimStartRequest {
    script: Option<String>,
    model: Option<String>,
}

#[tauri::command]
fn sim_start(
    app: tauri::AppHandle,
    script: Option<String>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let state = app.state::<AppState>();
        let client = state.sim_client.lock().map_err(|e| e.to_string())?;
        if let Some(script_name) = script.as_deref() {
            let model_name = model.as_deref()
                .ok_or("The selected script has no associated aircraft model")?;
            client.send_load_script(script_name, model_name).map_err(|e| e.to_string())?;
        } else if let Some(model_name) = model.as_deref() {
            client.send_load(model_name).map_err(|e| e.to_string())?;
        } else {
            client.send_command(1).map_err(|e| e.to_string())?;
        }
        client.request_lifecycle_state("running");
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
        let client = state.sim_client.lock().map_err(|e| e.to_string())?;
        client.send_command(3).map_err(|e| e.to_string())?;
        client.request_lifecycle_state("paused");
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
        let client = state.sim_client.lock().map_err(|e| e.to_string())?;
        client.send_command(4).map_err(|e| e.to_string())?;
        client.request_lifecycle_state("running");
        return Ok(serde_json::json!({"running": true, "paused": false}));
    }
    let state = app.state::<AppState>();
    let manager = state.jsbsim.lock().map_err(|e| e.to_string())?;
    manager.resume()?;
    Ok(serde_json::json!({ "running": true, "paused": false }))
}

#[tauri::command]
fn sim_restart(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let state = app.state::<AppState>();
        let client = state.sim_client.lock().map_err(|e| e.to_string())?;
        client.send_command(6).map_err(|e| e.to_string())?;
        client.request_lifecycle_state("running");
        return Ok(serde_json::json!({"running": true, "restarting": true, "external": true}));
    }
    let state = app.state::<AppState>();
    let manager = state.jsbsim.lock().map_err(|e| e.to_string())?;
    manager.restart(app.clone())?;
    Ok(serde_json::json!({ "running": true }))
}

#[tauri::command]
fn sim_stop(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let state = app.state::<AppState>();
        let client = state.sim_client.lock().map_err(|e| e.to_string())?;
        client.send_command(2).map_err(|e| e.to_string())?;
        client.request_lifecycle_state("stopped");
        return Ok(serde_json::json!({"running": false, "external": true}));
    }
    let state = app.state::<AppState>();
    let manager = state.jsbsim.lock().map_err(|e| e.to_string())?;
    manager.stop()?;
    Ok(serde_json::json!({ "running": false }))
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
        let remote_state = if task_alive == Some(false) {
            "crashed".to_owned()
        } else { client.lifecycle_state()
            .unwrap_or_else(|| if connected {
                "waiting".to_owned()
            } else {
                "disconnected".to_owned()
            }) };
        let model = latest.as_ref()
            .and_then(|value| value.get("model"))
            .and_then(|value| value.as_str());
        let cpu = client.jsbsim_cpu_load();
        let cpu_cores = client.cpu_core_loads();
        let memory = client.memory_usage();
        let fdm_run_ms = client.fdm_run_ms();
        let simulation_dt = client.simulation_dt();
        return Ok(serde_json::json!({
            "external": true,
            "running": connected && (remote_state == "running" || remote_state == "paused"),
            "paused": remote_state == "paused",
            "stopped": remote_state == "stopped",
            "state": remote_state,
            "connected": connected,
            "taskAlive": task_alive,
            "model": model,
            "packets": client.packet_count(),
            "cpu": cpu,
            "cpuCores": cpu_cores,
            "memory": memory,
            "fdmRunMs": fdm_run_ms,
            "simulationDt": simulation_dt,
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
fn sim_list_tests() -> Result<serde_json::Value, String> {
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
        return Ok(serde_json::json!({ "tests": tests, "source": "nuttx-ftp" }));
    }
    let tests = jsbsim_process::JsbsimManager::list_tests()?;
    Ok(serde_json::json!({ "tests": tests }))
}

#[tauri::command]
fn sim_list_models() -> Result<serde_json::Value, String> {
    if external_sim_mode() {
        let models = ftp_sync::list_models()?.into_iter().map(|name| {
            serde_json::json!({
                "name": name,
                "file": format!("{}.xml", name),
                "path": name,
                "remote": true
            })
        }).collect::<Vec<_>>();
        return Ok(serde_json::json!({ "models": models, "source": "nuttx-ftp" }));
    }
    let models = jsbsim_process::JsbsimManager::list_models()?;
    Ok(serde_json::json!({ "models": models }))
}

#[tauri::command]
fn ftp_download_model(model: String) -> Result<serde_json::Value, String> {
    let xml = ftp_sync::download_model(&model)?;
    Ok(serde_json::json!({ "model": model, "xml": xml, "source": "nuttx-ftp" }))
}

#[tauri::command]
fn ftp_download_xml(path: String) -> Result<serde_json::Value, String> {
    let content = ftp_sync::download_path(&path)?;
    Ok(serde_json::json!({ "path": path, "content": content, "source": "nuttx-ftp" }))
}

#[tauri::command]
fn ftp_list_systems() -> Result<serde_json::Value, String> {
    let files = ftp_sync::list_systems()?;
    Ok(serde_json::json!({ "files": files, "source": "nuttx-ftp" }))
}

#[tauri::command]
fn ftp_list_engines() -> Result<serde_json::Value, String> {
    let (engines, propellers) = ftp_sync::list_engine_catalog()?;
    Ok(serde_json::json!({ "engines": engines, "propellers": propellers, "source": "nuttx-ftp" }))
}

#[tauri::command]
fn ftp_list_dsdl() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "files": ftp_sync::list_dsdl_files()?, "root": "/mnt/sdcard/dsdl/px4", "source": "nuttx-ftp" }))
}

#[tauri::command]
fn ftp_list_logs() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "files": ftp_sync::list_logs()?, "root": "/mnt/sdcard/LOG", "source": "nuttx-ftp" }))
}

#[tauri::command]
fn ftp_download_log(file: String, directory: Option<String>) -> Result<serde_json::Value, String> {
    let path = ftp_sync::download_log(&file, directory.as_deref())?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("cannot inspect downloaded log: {e}"))?;
    /* Returning the download bytes lets the WebView open the file immediately.
     * Keep the IPC payload bounded; the on-disk file is still available for
     * large logs, which should be opened manually to avoid freezing the UI. */
    const AUTO_OPEN_MAX_BYTES: u64 = 64 * 1024 * 1024;
    let bytes = if metadata.len() <= AUTO_OPEN_MAX_BYTES {
        Some(std::fs::read(&path).map_err(|e| format!("cannot read downloaded log: {e}"))?)
    } else { None };
    Ok(serde_json::json!({ "file": file, "path": path, "size": metadata.len(), "bytes": bytes }))
}

#[tauri::command]
fn ftp_delete_log(file: String) -> Result<serde_json::Value, String> {
    ftp_sync::delete_log(&file)?;
    Ok(serde_json::json!({ "file": file, "deleted": true }))
}

#[tauri::command]
fn ftp_download_dsdl(file: String) -> Result<serde_json::Value, String> {
    let content = ftp_sync::download_dsdl(&file)?;
    Ok(serde_json::json!({ "file": file, "content": content, "source": "nuttx-ftp" }))
}

#[tauri::command]
fn ftp_upload_file(path: String, content: String) -> Result<serde_json::Value, String> {
    ftp_sync::upload_file(&path, &content)?;
    Ok(serde_json::json!({ "path": path, "uploaded": true, "source": "nuttx-ftp" }))
}

#[tauri::command]
fn ftp_download_script(file: String) -> Result<serde_json::Value, String> {
    let xml = ftp_sync::download_script(&file)?;
    Ok(serde_json::json!({ "file": file, "xml": xml, "source": "nuttx-ftp" }))
}

#[tauri::command]
fn ftp_upload_model(model: String, xml: String) -> Result<serde_json::Value, String> {
    ftp_sync::upload_model(&model, &xml)?;
    Ok(serde_json::json!({ "model": model, "uploaded": true }))
}

#[tauri::command]
fn ftp_download_sim_config(path: String) -> Result<serde_json::Value, String> {
    let content = ftp_sync::download_config(&path)?;
    Ok(serde_json::json!({"path": path, "content": content}))
}

#[tauri::command]
fn ftp_upload_sim_config(path: String, content: String) -> Result<serde_json::Value, String> {
    ftp_sync::upload_config(&path, &content)?;
    Ok(serde_json::json!({"path": path, "saved": true}))
}

// ── Main ────────────────────────────────────────────────────────────────────

fn main() {
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
            sim_start,
            sim_stop,
            sim_status,
            sim_pause,
            sim_resume,
            sim_restart,
            sim_list_tests,
            sim_list_models,
            ftp_download_model,
            ftp_download_xml,
            ftp_list_systems,
            ftp_list_engines,
            ftp_list_dsdl,
            ftp_list_logs,
            ftp_download_log,
            ftp_delete_log,
            ftp_download_dsdl,
            ftp_upload_file,
            ftp_download_script,
            ftp_upload_model,
            ftp_download_sim_config,
            ftp_upload_sim_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
