use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSessionInfo {
    pub id: String,
    pub remote_path: String,
    pub local_path: String,
    pub application: String,
    pub modified: bool,
    pub local_error: Option<String>,
}

#[derive(Clone)]
struct EditorSession {
    info: EditorSessionInfo,
    baseline: (u64, u32),
    observed: Option<(u64, Option<SystemTime>)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSaveResult {
    pub changed: bool,
    pub size: u64,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, EditorSession>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static Mutex<HashMap<String, EditorSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn local_fingerprint(path: &Path) -> Result<(u64, u32), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("本地编辑副本无法读取: {error}"))?;
    let mut data = [0u8; 16 * 1024];
    let mut size = 0u64;
    let mut checksum = u32::MAX;
    loop {
        let count = file.read(&mut data).map_err(|error| error.to_string())?;
        if count == 0 { break; }
        checksum = crate::usb_file::crc32_fold(checksum, &data[..count]);
        size += count as u64;
    }
    Ok((size, !checksum))
}

pub fn sessions() -> Result<Vec<EditorSessionInfo>, String> {
    let mut entries = registry().lock().map_err(|_| "编辑会话锁已损坏")?;
    let mut result = Vec::with_capacity(entries.len());
    for session in entries.values_mut() {
        let path = Path::new(&session.info.local_path);
        match std::fs::metadata(path) {
            Ok(metadata) => {
                let stamp = (metadata.len(), metadata.modified().ok());
                if session.observed != Some(stamp) || session.info.local_error.is_some() {
                    match local_fingerprint(path) {
                        Ok(fingerprint) => {
                            session.info.modified = fingerprint != session.baseline;
                            session.info.local_error = None;
                            let current_stamp = std::fs::metadata(path).ok()
                                .map(|current| (current.len(), current.modified().ok()));
                            session.observed = current_stamp.filter(|current| *current == stamp);
                        }
                        Err(error) => {
                            session.info.modified = false;
                            session.info.local_error = Some(error);
                            session.observed = None;
                        }
                    }
                }
            }
            Err(error) => {
                session.info.modified = false;
                session.info.local_error = Some(format!("本地编辑副本无法读取: {error}"));
                session.observed = None;
            }
        }
        result.push(session.info.clone());
    }
    result.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(result)
}

pub fn save(id: &str) -> Result<EditorSaveResult, String> {
    let session = registry().lock().map_err(|_| "编辑会话锁已损坏")?
        .get(id).cloned().ok_or("编辑会话已结束")?;
    let local = local_fingerprint(Path::new(&session.info.local_path))?;
    if local == session.baseline {
        if let Some(current) = registry().lock().map_err(|_| "编辑会话锁已损坏")?.get_mut(id) {
            current.info.modified = false;
            current.info.local_error = None;
            current.observed = None;
        }
        return Ok(EditorSaveResult { changed: false, size: local.0 });
    }
    let remote = crate::usb_file::fingerprint(&session.info.remote_path)?;
    if remote != session.baseline {
        return Err("设备上的文件已发生变化；本地副本仍保留，请先处理冲突".into());
    }

    // Editors can keep writing while the USB upload is running. Upload an
    // immutable snapshot and leave the local copy available for another save.
    let snapshot_dir = std::env::temp_dir().join(format!("jsbsim-usb-edit-{}-{}",
        std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir(&snapshot_dir).map_err(|error| format!("创建编辑快照失败: {error}"))?;
    let snapshot = snapshot_dir.join("edited.file");
    let result: Result<(u64, u32), String> = (|| {
        std::fs::copy(&session.info.local_path, &snapshot)
            .map_err(|error| format!("复制编辑副本失败: {error}"))?;
        let copied = local_fingerprint(&snapshot)?;
        if copied != local || local_fingerprint(Path::new(&session.info.local_path))? != local {
            return Err("本地文件在保存期间发生变化，请再试一次".into());
        }
        crate::usb_file::upload_from(&session.info.remote_path, &snapshot)?;
        Ok(copied)
    })();
    let _ = std::fs::remove_dir_all(&snapshot_dir);
    let copied = result?;
    if let Some(current) = registry().lock().map_err(|_| "编辑会话锁已损坏")?.get_mut(id) {
        current.baseline = copied;
        current.info.modified = false;
        current.info.local_error = None;
        current.observed = None;
    }
    Ok(EditorSaveResult { changed: true, size: copied.0 })
}

pub fn finish(id: &str) -> Result<(), String> {
    registry().lock().map_err(|_| "编辑会话锁已损坏")?.remove(id);
    Ok(())
}

#[cfg(target_os = "linux")]
async fn choose_and_launch(window: tauri::WebviewWindow, local_path: PathBuf)
    -> Result<Option<String>, String> {
    use gtk::gio::prelude::*;
    use gtk::prelude::*;

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<String>, String>>();
    let parent = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent.gtk_window().map_err(|error| error.to_string())?;
                let file = gtk::gio::File::for_path(&local_path);
                let dialog = gtk::AppChooserDialog::new(Some(&parent), gtk::DialogFlags::MODAL, &file);
                dialog.set_title("选择电脑编辑器");
                if let Ok(chooser) = dialog.widget().downcast::<gtk::AppChooserWidget>() {
                    chooser.set_show_other(true);
                }
                let response = dialog.run_future().await;
                let chosen = if response == gtk::ResponseType::Ok || response == gtk::ResponseType::Accept {
                    dialog.app_info()
                } else {
                    None
                };
                dialog.close();
                match chosen {
                    Some(application) => {
                        let name = application.name().to_string();
                        application.launch(&[file], None::<&gtk::gio::AppLaunchContext>)
                            .map_err(|error| format!("启动编辑器失败: {error}"))?;
                        Ok(Some(name))
                    }
                    None => Ok(None),
                }
            }.await;
            let _ = sender.send(result);
        });
    }).map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

#[cfg(target_os = "linux")]
pub async fn open(window: tauri::WebviewWindow, path: String, directory: String)
    -> Result<Option<EditorSessionInfo>, String> {
    let (local_path, size, checksum) = super::run_blocking({
        let path = path.clone();
        move || {
            crate::usb_file::validate_editable_file(&path)?;
            super::download_usb_file(&path, &directory)
        }
    }).await?;
    let application = choose_and_launch(window, local_path.clone()).await;
    let application = match application {
        Ok(Some(application)) => application,
        Ok(None) => {
            let _ = std::fs::remove_file(&local_path);
            return Ok(None);
        }
        Err(error) => {
            let _ = std::fs::remove_file(&local_path);
            return Err(error);
        }
    };
    let info = EditorSessionInfo {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string(),
        remote_path: path,
        local_path: local_path.to_string_lossy().into_owned(),
        application,
        modified: false,
        local_error: None,
    };
    registry().lock().map_err(|_| "编辑会话锁已损坏")?.insert(info.id.clone(), EditorSession {
        info: info.clone(), baseline: (size, checksum), observed: None,
    });
    Ok(Some(info))
}

#[cfg(not(target_os = "linux"))]
pub async fn open(_window: tauri::WebviewWindow, _path: String, _directory: String)
    -> Result<Option<EditorSessionInfo>, String> {
    Err("当前平台暂不支持选择电脑编辑器".into())
}
