use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbUploadSelection {
    pub local_path: String,
    pub remote_path: String,
    pub size: u64,
}

fn remote_path(directory: &str, source: &Path) -> Result<String, String> {
    if !matches!(directory, "sd" | "data") &&
       !directory.starts_with("sd/") && !directory.starts_with("data/") {
        return Err("只能上传到 SD 或 data".into());
    }
    if directory.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err("目标目录无效".into());
    }
    let name = source.file_name().and_then(|name| name.to_str()).ok_or("文件名无效")?;
    if name.is_empty() || name.contains('\\') || name.contains('/') {
        return Err("文件名无效".into());
    }
    Ok(format!("{directory}/{name}"))
}

#[cfg(target_os = "linux")]
pub async fn pick_and_upload(
    window: tauri::WebviewWindow,
    directory: String,
    previous_path: Option<String>,
) -> Result<Option<UsbUploadSelection>, String> {
    use gtk::prelude::*;

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<PathBuf>, String>>();
    let parent = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent.gtk_window().map_err(|error| error.to_string())?;
                let dialog = gtk::FileChooserNative::new(
                    Some("选择上传到仿真机的文件"), Some(&parent), gtk::FileChooserAction::Open,
                    Some("上传"), Some("取消"),
                );
                dialog.set_modal(true);
                if let Some(previous) = previous_path.as_deref().map(Path::new) {
                    let folder = if previous.is_dir() { Some(previous) } else { previous.parent() };
                    if let Some(folder) = folder.filter(|folder| folder.is_dir()) {
                        dialog.set_current_folder(folder);
                    }
                }
                let response = dialog.run_future().await;
                let selected = if response == gtk::ResponseType::Accept { dialog.filename() } else { None };
                dialog.destroy();
                Ok(selected)
            }.await;
            let _ = sender.send(result);
        });
    }).map_err(|error| error.to_string())?;

    let selected = receiver.await.map_err(|error| error.to_string())??;
    match selected {
        Some(source) => super::run_blocking(move || {
            let remote_path = remote_path(&directory, &source)?;
            let size = crate::usb_file::upload_from(&remote_path, &source)?;
            Ok(Some(UsbUploadSelection {
                local_path: source.to_string_lossy().into_owned(),
                remote_path,
                size,
            }))
        }).await,
        None => Ok(None),
    }
}

#[cfg(not(target_os = "linux"))]
pub async fn pick_and_upload(
    _window: tauri::WebviewWindow,
    _directory: String,
    _previous_path: Option<String>,
) -> Result<Option<UsbUploadSelection>, String> {
    Err("此平台请使用文件选择框上传".into())
}
