//! Read only the model directory explicitly selected by the user. A browser
//! FileList cannot discover siblings of a selected aircraft XML.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelImport {
    directory: String,
    main_file: Option<String>,
    files: Vec<ImportXml>,
    assets: Vec<ImportAsset>,
}

#[derive(Serialize)]
pub struct ImportXml {
    name: String,
    xml: String,
}

#[derive(Serialize)]
pub struct ImportAsset {
    name: String,
    size: u64,
}

pub fn scan_model_directory(selected: &Path) -> Result<ModelImport, String> {
    let selected = selected.canonicalize().map_err(|e| e.to_string())?;
    let (directory, main_file) = if selected.is_dir() {
        (selected, None)
    } else {
        if !is_xml(&selected) {
            return Err("请选择主模型 XML 文件。".into());
        }
        let name = selected.file_name().unwrap().to_string_lossy().into_owned();
        (selected.parent().ok_or("模型文件没有父目录")?.to_path_buf(), Some(name))
    };
    let mut files = Vec::new();
    let mut bytes = 0;
    collect_xml(&directory, &directory, &mut files, &mut bytes)?;
    files.sort_by(|a, b| a.name.cmp(&b.name));
    if files.is_empty() {
        return Err("所选目录没有 XML 文件。".into());
    }
    let assets = scan_model_assets(&directory)?.into_iter().map(|(name, path)| {
        path.metadata().map(|metadata| ImportAsset { name, size: metadata.len() })
            .map_err(|e| e.to_string())
    }).collect::<Result<Vec<_>, _>>()?;
    Ok(ModelImport { directory: directory.to_string_lossy().into_owned(), main_file, files, assets })
}

/// Keep asset paths on the native side so binary geometry and textures never
/// pass through XML parsing or browser localStorage.
pub fn scan_model_assets(directory: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let directory = directory.canonicalize().map_err(|e| e.to_string())?;
    if !directory.is_dir() { return Err("模型源目录不存在".into()); }
    let mut assets = Vec::new();
    let mut bytes = 0u64;
    collect_assets(&directory, &directory, &mut assets, &mut bytes)?;
    assets.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(assets)
}

fn collect_assets(root: &Path, directory: &Path, assets: &mut Vec<(String, PathBuf)>, bytes: &mut u64) -> Result<(), String> {
    for entry in std::fs::read_dir(directory).map_err(|e| format!("{}: {e}", directory.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') { continue; }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        if !kind.is_dir() && !is_model_asset(&path) { continue; }
        if !name.split('.').all(|part| !part.is_empty()) ||
            !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')) {
            return Err(format!("模型资源文件名不支持：{name}"));
        }
        if kind.is_dir() {
            collect_assets(root, &path, assets, bytes)?;
        } else if kind.is_file() {
            *bytes += entry.metadata().map_err(|e| e.to_string())?.len();
            if assets.len() >= 2000 || *bytes > 64 * 1024 * 1024 {
                return Err("模型资源过大（最多 2000 个文件 / 64 MB）".into());
            }
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            assets.push((relative, path));
        }
    }
    Ok(())
}

fn is_xml(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xml"))
}

fn is_model_asset(path: &Path) -> bool {
    path.extension().is_some_and(|ext| {
        ["ac", "jpg", "jpeg", "png", "bmp", "obj", "mtl", "dae", "tga", "dds", "svg", "stl", "3ds", "gif", "webp", "csv", "dat"]
            .iter().any(|allowed| ext.eq_ignore_ascii_case(allowed))
    })
}

fn collect_xml(root: &Path, directory: &Path, files: &mut Vec<ImportXml>, bytes: &mut u64) -> Result<(), String> {
    for entry in std::fs::read_dir(directory).map_err(|e| format!("{}: {e}", directory.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        // Do not follow symlinks outside the chosen model or through cycles.
        if kind.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') {
            collect_xml(root, &path, files, bytes)?;
        } else if kind.is_file() && is_xml(&path) {
            *bytes += entry.metadata().map_err(|e| e.to_string())?.len();
            if files.len() >= 2000 || *bytes > 64 * 1024 * 1024 {
                return Err("所选目录过大（最多 2000 个 XML / 64 MB），请选择单个模型目录。".into());
            }
            let xml = std::fs::read_to_string(&path).map_err(|e| format!("无法读取 {}: {e}", path.display()))?;
            files.push(ImportXml {
                name: path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/"),
                xml,
            });
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub async fn pick_model(window: tauri::WebviewWindow, directory: bool, initial_directory: Option<String>) -> Result<Option<ModelImport>, String> {
    use gtk::prelude::*;
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<PathBuf>, String>>();
    let parent = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent.gtk_window().map_err(|e| e.to_string())?;
                let dialog = gtk::FileChooserNative::new(
                    Some(if directory { "选择模型目录（扫描全部 XML）" } else { "选择主模型 XML（自动关联同目录 XML）" }),
                    Some(&parent),
                    if directory { gtk::FileChooserAction::SelectFolder } else { gtk::FileChooserAction::Open },
                    Some("扫描并确认"), Some("取消"),
                );
                dialog.set_modal(true);
                // A removed or inaccessible previous directory should leave
                // the chooser at its normal default instead of failing open.
                if let Some(folder) = initial_directory.as_deref().map(Path::new).filter(|path| path.is_dir()) {
                    dialog.set_current_folder(folder);
                }
                if !directory {
                    let filter = gtk::FileFilter::new();
                    filter.set_name(Some("XML 模型文件"));
                    // GLib patterns support * and ?, not shell [] ranges.
                    for pattern in ["*.xml", "*.XML", "*.Xml", "*.xMl", "*.xmL", "*.XMl", "*.XmL", "*.xML"] {
                        filter.add_pattern(pattern);
                    }
                    dialog.add_filter(filter);
                }
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
        Some(path) => super::run_blocking(move || scan_model_directory(&path).map(Some)).await,
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selecting_main_scans_siblings_and_nested_xml_only() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("jsbsim-import-test-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::create_dir(dir.join("Models")).unwrap();
        for (name, xml) in [
            ("quadrotor_x.xml", "<fdm_config name=\"dflyer\"/>"),
            ("initfile.xml", "<initialize/>"), ("reset.xml", "<initialize/>"),
            ("Models/custom.XML", "<!-- init --><initialize/>"),
            ("thumbnail.jpg", "not XML"),
        ] { std::fs::write(dir.join(name), xml).unwrap(); }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&dir, dir.join("cycle")).unwrap();
        let result = scan_model_directory(&dir.join("quadrotor_x.xml")).unwrap();
        assert_eq!(result.main_file.as_deref(), Some("quadrotor_x.xml"));
        assert_eq!(result.files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["Models/custom.XML", "initfile.xml", "quadrotor_x.xml", "reset.xml"]);
        assert_eq!(result.assets.iter().map(|asset| asset.name.as_str()).collect::<Vec<_>>(),
            vec!["thumbnail.jpg"]);
        assert!(scan_model_directory(&dir).unwrap().main_file.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn real_model_fixture_when_requested() {
        let Ok(path) = std::env::var("JSBSIM_IMPORT_TEST_MODEL") else { return };
        let result = scan_model_directory(Path::new(&path)).unwrap();
        for required in ["initfile.xml", "reset.xml"] {
            assert!(result.files.iter().any(|file| file.name == required), "missing {required}");
        }
        for required in ["Models/quadrotor_x.ac", "thumbnail.jpg"] {
            assert!(result.assets.iter().any(|asset| asset.name == required), "missing asset {required}");
        }
        println!("Scanned {}: {:?}", result.directory, result.files.iter().map(|f| &f.name).collect::<Vec<_>>());
    }
}
