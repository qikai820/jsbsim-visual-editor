use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareSelection {
    pub path: String,
    pub name: String,
    pub size: u64,
}

pub fn inspect_firmware(path: &Path) -> Result<FirmwareSelection, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !path.is_file() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("bin")) {
        return Err("请选择 .bin 固件文件".into());
    }
    let size = path.metadata().map_err(|e| e.to_string())?.len();
    let name = path.file_name().ok_or("固件文件名无效")?.to_string_lossy().into_owned();
    Ok(FirmwareSelection { path: path.to_string_lossy().into_owned(), name, size })
}

#[cfg(target_os = "linux")]
pub async fn pick_firmware(window: tauri::WebviewWindow, previous_path: Option<String>) -> Result<Option<FirmwareSelection>, String> {
    use gtk::prelude::*;
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<PathBuf>, String>>();
    let parent = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent.gtk_window().map_err(|e| e.to_string())?;
                let dialog = gtk::FileChooserNative::new(
                    Some("选择固件 .bin 文件"), Some(&parent), gtk::FileChooserAction::Open,
                    Some("选择"), Some("取消"),
                );
                dialog.set_modal(true);
                if let Some(previous) = previous_path.as_deref().map(Path::new) {
                    if previous.is_file() {
                        dialog.set_filename(previous);
                    } else if let Some(folder) = previous.parent().filter(|folder| folder.is_dir()) {
                        dialog.set_current_folder(folder);
                    }
                }
                let filter = gtk::FileFilter::new();
                filter.set_name(Some("固件文件 (*.bin)"));
                for pattern in ["*.bin", "*.BIN", "*.Bin", "*.bIn", "*.biN", "*.BIn", "*.BiN", "*.bIN"] {
                    filter.add_pattern(pattern);
                }
                dialog.add_filter(filter);
                let response = dialog.run_future().await;
                let selected = if response == gtk::ResponseType::Accept { dialog.filename() } else { None };
                dialog.destroy();
                Ok(selected)
            }.await;
            let _ = sender.send(result);
        });
    }).map_err(|e| e.to_string())?;
    let selected = receiver.await.map_err(|e| e.to_string())??;
    match selected {
        Some(path) => super::run_blocking(move || inspect_firmware(&path).map(Some)).await,
        None => Ok(None),
    }
}
