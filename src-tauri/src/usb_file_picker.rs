use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use tauri::Emitter;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbUploadSelection {
    pub local_path: String,
    pub remote_path: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbFolderUploadSelection {
    pub local_path: String,
    pub remote_path: String,
    pub files: usize,
    pub directories: usize,
    pub bytes: u64,
    pub skipped: usize,
    pub overwritten: usize,
}

#[derive(Clone, Copy)]
enum ConflictPolicy { Overwrite, Skip }

struct PreparedFolder {
    source: PathBuf,
    directory: String,
    destination: String,
    entries: Vec<FolderEntry>,
    existing: HashMap<String, bool>,
    files: usize,
    directories: usize,
    bytes: u64,
    root_exists: bool,
}

struct FolderEntry {
    local_path: PathBuf,
    relative_path: String,
    directory: bool,
    size: u64,
}

fn collect_folder(source: &Path, relative: &str, destination: &str,
                  entries: &mut Vec<FolderEntry>) -> Result<(), String> {
    let mut children = std::fs::read_dir(source)
        .map_err(|error| format!("读取本地文件夹 {} 失败: {error}", source.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("遍历本地文件夹失败: {error}"))?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let local_path = child.path();
        let name = child.file_name().into_string()
            .map_err(|_| format!("文件名不是 UTF-8: {}", local_path.display()))?;
        let relative_path = if relative.is_empty() { name } else { format!("{relative}/{name}") };
        crate::usb_file::managed_volume(&format!("{destination}/{relative_path}"))
            .map_err(|error| format!("{}: {error}", local_path.display()))?;
        let metadata = std::fs::symlink_metadata(&local_path)
            .map_err(|error| format!("读取 {} 失败: {error}", local_path.display()))?;
        let directory = metadata.is_dir();
        if !directory && !metadata.is_file() {
            return Err(format!("文件夹包含链接或特殊文件，无法上传: {}", local_path.display()));
        }
        entries.push(FolderEntry { local_path: local_path.clone(), relative_path: relative_path.clone(),
                                   directory, size: if directory { 0 } else { metadata.len() } });
        if directory { collect_folder(&local_path, &relative_path, destination, entries)?; }
    }
    Ok(())
}

fn prepare_folder(source: PathBuf, directory: String) -> Result<PreparedFolder, String> {
    let metadata = std::fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.is_dir() { return Err("请选择普通文件夹，不能选择链接".into()); }
    let destination = remote_path(&directory, &source)?;
    crate::usb_file::managed_volume(&destination)?;
    let mut entries = Vec::new();
    collect_folder(&source, "", &destination, &mut entries)?;
    let files = entries.iter().filter(|entry| !entry.directory).count();
    let directories = entries.len() - files + 1;
    let bytes = entries.iter().map(|entry| entry.size).sum();
    let identity = crate::usb_file::ping()?;
    if identity != "lmx93-usb-file/4" && identity != "lmx93-usb-file/5" && identity != "lmx93-usb-file/6" {
        return Err("文件夹上传需要 lmx93-usb-file/4 或更新板端固件".into());
    }
    if identity != "lmx93-usb-file/5" && identity != "lmx93-usb-file/6" && (crate::usb_file::has_long_component(&destination) ||
        entries.iter().any(|entry| entry.relative_path.split('/').any(|part| part.len() > 32))) {
        return Err("文件夹包含超过 32 字节的名称，需要升级至 lmx93-usb-file/5 板端固件".into());
    }
    let siblings = crate::usb_file::list(&directory)?;
    let name = source.file_name().and_then(|name| name.to_str()).ok_or("文件夹名无效")?;
    let root = siblings.iter().find(|entry| entry.name == name);
    if root.is_some_and(|entry| !entry.directory) {
        return Err("目标位置已有同名文件，无法合并文件夹".into());
    }
    let root_exists = root.is_some();
    let mut existing = HashMap::new();
    if root_exists {
        let mut unavailable = Vec::<String>::new();
        for entry in &entries {
            let parent_unavailable = unavailable.iter().any(|parent| entry.relative_path.starts_with(&format!("{parent}/")));
            if parent_unavailable { continue; }
            let remote = format!("{destination}/{}", entry.relative_path);
            match crate::usb_file::stat(&remote) {
                Ok(found) => {
                    existing.insert(entry.relative_path.clone(), found.directory);
                    if entry.directory && !found.directory { unavailable.push(entry.relative_path.clone()); }
                }
                Err(error) if error.contains("errno 2") => {
                    if entry.directory { unavailable.push(entry.relative_path.clone()); }
                }
                Err(error) => return Err(format!("检查目标 {remote} 失败: {error}")),
            }
        }
    }
    Ok(PreparedFolder { source, directory, destination, entries, existing,
                        files, directories, bytes, root_exists })
}

#[cfg(target_os = "linux")]
async fn choose_conflict_policy(window: tauri::WebviewWindow) -> Result<Option<ConflictPolicy>, String> {
    use gtk::prelude::*;
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<ConflictPolicy>, String>>();
    let parent_window = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent_window.gtk_window().map_err(|error| error.to_string())?;
                let dialog = gtk::Dialog::with_buttons(
                    Some("目标已有同名文件夹"), Some(&parent), gtk::DialogFlags::MODAL, &[],
                );
                dialog.add_button("覆盖全部同名文件", gtk::ResponseType::Other(1));
                dialog.add_button("跳过全部同名文件", gtk::ResponseType::Other(2));
                dialog.add_button("取消", gtk::ResponseType::Cancel);
                let label = gtk::Label::new(Some("同名文件夹将合并。遇到同名文件时，选择覆盖或跳过；其他文件照常上传。"));
                label.set_line_wrap(true);
                label.set_margin_top(16);
                label.set_margin_bottom(16);
                label.set_margin_start(18);
                label.set_margin_end(18);
                dialog.content_area().add(&label);
                dialog.show_all();
                let selected = match dialog.run_future().await {
                    gtk::ResponseType::Other(1) => Some(ConflictPolicy::Overwrite),
                    gtk::ResponseType::Other(2) => Some(ConflictPolicy::Skip),
                    _ => None,
                };
                dialog.close();
                Ok(selected)
            }.await;
            let _ = sender.send(result);
        });
    }).map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

#[cfg(target_os = "linux")]
async fn choose_source(window: tauri::WebviewWindow, previous_path: Option<String>,
                       action: gtk::FileChooserAction, title: &'static str)
    -> Result<Option<PathBuf>, String> {
    use gtk::prelude::*;

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<PathBuf>, String>>();
    let parent_window = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent_window.gtk_window().map_err(|error| error.to_string())?;
                let dialog = gtk::FileChooserNative::new(
                    Some(title), Some(&parent), action, Some("上传"), Some("取消"),
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
    receiver.await.map_err(|error| error.to_string())?
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
    let selected = choose_source(window, previous_path, gtk::FileChooserAction::Open,
                                 "选择上传到仿真机的文件").await?;
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

#[cfg(target_os = "linux")]
pub async fn pick_and_upload_folder(window: tauri::WebviewWindow, directory: String,
                                    previous_path: Option<String>)
    -> Result<Option<UsbFolderUploadSelection>, String> {
    let selected = choose_source(window.clone(), previous_path, gtk::FileChooserAction::SelectFolder,
                                 "选择上传到仿真机的文件夹").await?;
    let Some(source) = selected else { return Ok(None); };
    let prepared = super::run_blocking(move || prepare_folder(source, directory)).await?;
    let policy = if prepared.root_exists {
        let Some(policy) = choose_conflict_policy(window.clone()).await? else { return Ok(None); };
        policy
    } else { ConflictPolicy::Overwrite };
    super::run_blocking(move || upload_folder(prepared, policy, window).map(Some)).await
}

#[cfg(target_os = "linux")]
fn upload_folder(prepared: PreparedFolder, policy: ConflictPolicy,
                 window: tauri::WebviewWindow) -> Result<UsbFolderUploadSelection, String> {
    let PreparedFolder { source, directory, destination, entries, existing,
                         files, directories, bytes, root_exists } = prepared;
    if root_exists && matches!(policy, ConflictPolicy::Overwrite) {
        if let Some(entry) = entries.iter().find(|entry| existing.get(&entry.relative_path)
            .is_some_and(|directory| *directory != entry.directory)) {
            return Err(format!("同名项目类型不同，不能直接覆盖: {}", entry.relative_path));
        }
    }
    let staging = if root_exists { None } else {
        let siblings = crate::usb_file::list(&directory)?;
        let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?.subsec_nanos();
        let path = (0..16).map(|attempt| format!("{directory}/.usbup{:08x}", seed.wrapping_add(attempt)))
            .find(|candidate| !siblings.iter().any(|entry| candidate.rsplit('/').next() == Some(entry.name.as_str())))
            .ok_or("无法分配临时上传目录")?;
        for entry in &entries {
            crate::usb_file::managed_volume(&format!("{path}/{}", entry.relative_path))
                .map_err(|error| format!("临时上传目录无法容纳 {}: {error}", entry.relative_path))?;
        }
        crate::usb_file::mkdir(&path)?;
        Some(path)
    };
    let base = staging.as_deref().unwrap_or(&destination);
    let mut skipped = 0;
    let mut overwritten = 0;
    let mut completed_files = 0;
    let mut skipped_directories = Vec::<String>::new();
    let result = (|| {
        for entry in &entries {
            if skipped_directories.iter().any(|parent| entry.relative_path.starts_with(&format!("{parent}/"))) {
                if !entry.directory { skipped += 1; completed_files += 1; }
                continue;
            }
            let remote = format!("{base}/{}", entry.relative_path);
            let found = if root_exists {
                match crate::usb_file::stat(&remote) {
                    Ok(found) => Some(found),
                    Err(error) if error.contains("errno 2") => None,
                    Err(error) => return Err(format!("检查 {remote} 失败: {error}")),
                }
            } else { None };
            if let Some(found) = &found {
                if found.directory != entry.directory {
                    if matches!(policy, ConflictPolicy::Overwrite) {
                        return Err(format!("同名项目类型不同，不能直接覆盖: {}", entry.relative_path));
                    }
                    if entry.directory { skipped_directories.push(entry.relative_path.clone()); }
                    else { skipped += 1; completed_files += 1; }
                    continue;
                }
                if !entry.directory && matches!(policy, ConflictPolicy::Skip) {
                    skipped += 1;
                    completed_files += 1;
                    continue;
                }
            }
            if entry.directory {
                if found.is_none() { crate::usb_file::mkdir(&remote)?; }
            } else {
                let actual_size = std::fs::metadata(&entry.local_path)
                    .map_err(|error| error.to_string())?.len();
                if actual_size != entry.size {
                    return Err(format!("本地文件在上传前发生变化: {}", entry.local_path.display()));
                }
                let _ = window.emit("usb-folder-upload-progress", serde_json::json!({
                    "path": entry.relative_path, "completedFiles": completed_files, "totalFiles": files,
                }));
                crate::usb_file::upload_from(&remote, &entry.local_path)
                    .map_err(|error| format!("上传 {} 失败: {error}", entry.relative_path))?;
                if found.is_some() { overwritten += 1; }
                completed_files += 1;
            }
        }
        if let Some(staging) = &staging {
            crate::usb_file::transfer(staging, &destination, true)?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        if let Some(staging) = &staging {
            return match crate::usb_file::remove_tree(staging, true) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!("{error}；临时目录 {staging} 清理失败: {cleanup}")),
            };
        }
        return Err(format!("{error}；目标 {destination} 可能已有部分新内容"));
    }
    Ok(UsbFolderUploadSelection {
        local_path: source.to_string_lossy().into_owned(), remote_path: destination,
        files, directories, bytes, skipped, overwritten,
    })
}

#[cfg(not(target_os = "linux"))]
pub async fn pick_and_upload(
    _window: tauri::WebviewWindow,
    _directory: String,
    _previous_path: Option<String>,
) -> Result<Option<UsbUploadSelection>, String> {
    Err("此平台请使用文件选择框上传".into())
}

#[cfg(not(target_os = "linux"))]
pub async fn pick_and_upload_folder(_window: tauri::WebviewWindow, _directory: String,
                                    _previous_path: Option<String>)
    -> Result<Option<UsbFolderUploadSelection>, String> {
    Err("此平台请使用文件夹选择框上传".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_preflight_includes_empty_directories_and_rejects_unsafe_entries() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("usb-folder-preflight-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(root.join("sub/empty")).unwrap();
        std::fs::write(root.join("sub/model.xml"), b"<model/>").unwrap();
        let mut entries = Vec::new();
        collect_folder(&root, "", "sd/models", &mut entries).unwrap();
        assert!(entries.iter().any(|entry| entry.directory && entry.relative_path == "sub/empty"));
        assert!(entries.iter().any(|entry| !entry.directory && entry.relative_path == "sub/model.xml"));

        std::fs::write(root.join("a".repeat(33)), b"invalid").unwrap();
        assert!(collect_folder(&root, "", "sd/models", &mut Vec::new()).is_err());
        std::fs::remove_file(root.join("a".repeat(33))).unwrap();
        #[cfg(unix)] {
            std::os::unix::fs::symlink(root.join("sub/model.xml"), root.join("link.xml")).unwrap();
            assert!(collect_folder(&root, "", "sd/models", &mut Vec::new()).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
