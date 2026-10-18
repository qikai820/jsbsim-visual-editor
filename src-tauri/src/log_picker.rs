use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSelection {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: Option<u64>,
}

pub fn inspect_log(path: &Path) -> Result<LogSelection, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.is_file() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("mcap")) {
        return Err("请选择 .mcap 日志文件".into());
    }
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    Ok(LogSelection {
        name: path.file_name().ok_or("日志文件名无效")?.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        size: metadata.len(),
        modified: metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as u64),
    })
}

fn scan_mcap_directory(directory: &Path) -> Result<Vec<LogSelection>, String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取日志下载目录 {}：{error}", directory.display())),
    };
    let mut logs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取日志下载目录失败：{error}"))?;
        // A partial download or a symlink must not appear as a finished local log.
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) { continue; }
        if !entry.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("mcap")) { continue; }
        if let Ok(log) = inspect_log(&entry.path()) { logs.push(log); }
    }
    logs.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    Ok(logs)
}

pub fn list_downloaded_logs(configured_directory: Option<&str>) -> Result<Vec<LogSelection>, String> {
    let directory = super::ftp_sync::log_download_directory(configured_directory)?;
    scan_mcap_directory(&directory)
}

#[cfg(target_os = "linux")]
pub async fn pick_log(window: tauri::WebviewWindow) -> Result<Option<LogSelection>, String> {
    use gtk::prelude::*;
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<PathBuf>, String>>();
    let parent = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent.gtk_window().map_err(|e| e.to_string())?;
                let dialog = gtk::FileChooserNative::new(
                    Some("选择 MCAP 日志"), Some(&parent), gtk::FileChooserAction::Open,
                    Some("打开"), Some("取消"),
                );
                dialog.set_modal(true);
                let filter = gtk::FileFilter::new();
                filter.set_name(Some("MCAP 日志 (*.mcap)"));
                filter.add_pattern("*.mcap");
                filter.add_pattern("*.MCAP");
                dialog.add_filter(filter);
                let response = dialog.run_future().await;
                let selected = if response == gtk::ResponseType::Accept { dialog.filename() } else { None };
                dialog.destroy();
                Ok(selected)
            }.await;
            let _ = sender.send(result);
        });
    }).map_err(|e| e.to_string())?;
    match receiver.await.map_err(|e| e.to_string())?? {
        Some(path) => super::run_blocking(move || inspect_log(&path).map(Some)).await,
        None => Ok(None),
    }
}
