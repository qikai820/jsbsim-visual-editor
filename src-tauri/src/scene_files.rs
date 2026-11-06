//! Linux WebKit does not implement HTML directory upload. Use the native
//! folder chooser and return a bounded, self-contained set of relative files.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::path::Path;

const MAX_BYTES: u64 = 100 * 1024 * 1024;
const MAX_FILES: usize = 2000;

#[derive(Debug, Serialize)]
pub struct SceneSourceFile { pub path: String, pub data: String }

pub fn read_directory(root: &Path) -> Result<Vec<SceneSourceFile>, String> {
    fn collect(root: &Path, directory: &Path, depth: usize, bytes: &mut u64,
               files: &mut Vec<SceneSourceFile>) -> Result<(), String> {
        if depth > 24 { return Err("场景资源目录层级过深".into()); }
        let mut entries = std::fs::read_dir(directory).map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if metadata.is_dir() { collect(root, &path, depth + 1, bytes, files)?; continue; }
            if !metadata.is_file() { return Err(format!("场景目录包含链接或特殊文件：{}", path.display())); }
            *bytes = bytes.checked_add(metadata.len()).ok_or("场景目录过大")?;
            if *bytes > MAX_BYTES { return Err("一次导入请控制在 100 MB 以内".into()); }
            if files.len() >= MAX_FILES { return Err("场景目录文件超过 2000 个".into()); }
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?.to_str()
                .ok_or("场景资源文件名必须为 UTF-8")?.replace('\\', "/");
            let data = std::fs::read(&path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
            if data.len() as u64 != metadata.len() { return Err("场景资源在读取时发生变化，请重试".into()); }
            let mime = match path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
                "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp",
                "gltf" => "model/gltf+json", "glb" => "model/gltf-binary", _ => "application/octet-stream",
            };
            files.push(SceneSourceFile { path: relative, data: format!("data:{mime};base64,{}", STANDARD.encode(data)) });
        }
        Ok(())
    }
    let metadata = std::fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if !metadata.is_dir() { return Err("请选择普通目录".into()); }
    let mut files = Vec::new(); let mut bytes = 0;
    collect(root, root, 0, &mut bytes, &mut files)?;
    Ok(files)
}

#[cfg(target_os = "linux")]
pub async fn pick_directory(window: tauri::WebviewWindow) -> Result<Option<Vec<SceneSourceFile>>, String> {
    use gtk::prelude::*;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let parent = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent.gtk_window().map_err(|e| e.to_string())?;
                let dialog = gtk::FileChooserNative::new(Some("导入场景目录"), Some(&parent),
                    gtk::FileChooserAction::SelectFolder, Some("导入目录"), Some("取消"));
                dialog.set_modal(true);
                let response = dialog.run_future().await;
                let path = if response == gtk::ResponseType::Accept { dialog.filename() } else { None };
                dialog.destroy();
                Ok::<_, String>(path)
            }.await;
            let _ = sender.send(result);
        });
    }).map_err(|e| e.to_string())?;
    match receiver.await.map_err(|e| e.to_string())?? {
        Some(path) => crate::run_blocking(move || read_directory(&path).map(Some)).await,
        None => Ok(None),
    }
}

#[cfg(not(target_os = "linux"))]
pub async fn pick_directory(_window: tauri::WebviewWindow) -> Result<Option<Vec<SceneSourceFile>>, String> {
    Err("此平台请使用文件选择器导入场景".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("scene-files-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap(); root
    }
    #[test]
    fn preserves_nested_paths_and_exact_binary_content() {
        let root = fixture(); std::fs::create_dir(root.join("textures")).unwrap();
        std::fs::write(root.join("model.gltf"), b"{\"asset\":{\"version\":\"2.0\"}}").unwrap();
        std::fs::write(root.join("textures/tile.png"), [0, 128, 255, 10]).unwrap();
        let files = read_directory(&root).unwrap(); assert_eq!(files.len(), 2);
        let image = files.iter().find(|f| f.path == "textures/tile.png").unwrap();
        assert_eq!(STANDARD.decode(image.data.split_once(',').unwrap().1).unwrap(), [0, 128, 255, 10]);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_oversized_sources_before_reading() {
        let root = fixture(); std::fs::File::create(root.join("large.bin")).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert!(read_directory(&root).unwrap_err().contains("100 MB")); std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_links_outside_selected_directory() {
        let root = fixture(); std::os::unix::fs::symlink("/etc/hostname", root.join("linked.bin")).unwrap();
        assert!(read_directory(&root).unwrap_err().contains("链接")); std::fs::remove_dir_all(root).unwrap();
    }
}
