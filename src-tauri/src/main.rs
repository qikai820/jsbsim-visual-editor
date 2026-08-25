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
        Ok(result) => Ok(result),
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
    let json: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| e.to_string())?;
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
        "latest": client.latest()
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
        client.send_command(1).map_err(|e| e.to_string())?;
        return Ok(serde_json::json!({"running": true, "external": true}));
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
        state.sim_client.lock().map_err(|e| e.to_string())?.send_command(3).map_err(|e| e.to_string())?;
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
        state.sim_client.lock().map_err(|e| e.to_string())?.send_command(4).map_err(|e| e.to_string())?;
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
        state.sim_client.lock().map_err(|e| e.to_string())?.send_command(1).map_err(|e| e.to_string())?;
        return Ok(serde_json::json!({"running": true, "external": true}));
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
        state.sim_client.lock().map_err(|e| e.to_string())?.send_command(2).map_err(|e| e.to_string())?;
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
        return Ok(serde_json::json!({
            "external": true,
            "running": client.is_connected(),
            "paused": false,
            "connected": client.is_connected(),
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
    let tests = jsbsim_process::JsbsimManager::list_tests()?;
    Ok(serde_json::json!({ "tests": tests }))
}

#[tauri::command]
fn sim_list_models() -> Result<serde_json::Value, String> {
    let models = jsbsim_process::JsbsimManager::list_models()?;
    Ok(serde_json::json!({ "models": models }))
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
            load_project,
            list_projects,
            generate_aircraft,
            get_aircraft_library,
            load_aircraft,
            send_control,
            get_sim_status,
            parse_dataflow,
            sim_start,
            sim_stop,
            sim_status,
            sim_pause,
            sim_resume,
            sim_restart,
            sim_list_tests,
            sim_list_models,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
