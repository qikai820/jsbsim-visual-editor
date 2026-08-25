//! JSBSim file index: scans JSBSim XML directories and caches file contents.

use std::collections::HashMap;
use std::path::PathBuf;

pub type FileIndex = HashMap<String, String>;

/// Resolve JSBSIM_ROOT: env var first, then fallback paths.
pub fn jsbsim_root() -> PathBuf {
    if let Ok(root) = std::env::var("JSBSIM_ROOT") {
        return PathBuf::from(root);
    }
    // Fallback 1: relative to the current executable (production builds)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("../../jsbsim");
            if candidate.exists() {
                return candidate;
            }
        }
    }
    // Fallback 2: relative to CARGO_MANIFEST_DIR (dev builds: src-tauri/../jsbsim)
    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("jsbsim");
    if manifest_root.exists() {
        return manifest_root;
    }
    // Fallback 3: sibling directory of the project (../jsbsim from project root)
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("jsbsim");
    if project_root.exists() {
        return project_root;
    }
    // Fallback 4: for jsbsim_nuttx structure (src-tauri/../../jsbsim)
    let nuttx_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("jsbsim");
    if nuttx_root.exists() {
        return nuttx_root;
    }
    // Fallback 5: hardcoded path for qikai820's setup
    let hardcoded = PathBuf::from("/home/qikai820/src/jsbsim_nuttx/jsbsim");
    if hardcoded.exists() {
        return hardcoded;
    }
    manifest_root
}

/// Recursively find all XML files under a directory.
fn find_xml_files(dir: &PathBuf, results: &mut Vec<(PathBuf, String)>) {
    if !dir.exists() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                find_xml_files(&path, results);
            } else if path.extension().map(|e| e == "xml").unwrap_or(false) {
                if let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) {
                    results.push((path, name));
                }
            }
        }
    }
}

/// Build the JSBSim file index from known search directories.
pub fn build_file_index() -> FileIndex {
    let jsbsim_root = jsbsim_root();

    let search_dirs = vec![
        jsbsim_root.join("systems"),
        jsbsim_root.join("engine"),
        jsbsim_root.join("aircraft"),
    ];

    let mut index = HashMap::new();
    let mut all_files: Vec<(PathBuf, String)> = Vec::new();

    for dir in &search_dirs {
        find_xml_files(dir, &mut all_files);
    }

    for (path, name) in &all_files {
        if let Ok(content) = std::fs::read_to_string(path) {
            // Index by basename
            index.insert(name.clone(), content.clone());
            // Index by basename without extension
            let no_ext = name.trim_end_matches(".xml").to_string();
            index.insert(no_ext, content.clone());
            // Index by relative path
            if let Ok(rel) = path.strip_prefix(&jsbsim_root) {
                let rel_str = rel.to_string_lossy().to_string();
                index.insert(rel_str.clone(), content.clone());
                let rel_no_ext = rel_str.trim_end_matches(".xml").to_string();
                index.insert(rel_no_ext, content);
            }
        }
    }

    println!(
        "[JSBSim] Indexed {} XML files from {} directories (root: {})",
        all_files.len(),
        search_dirs.len(),
        jsbsim_root.display()
    );

    index
}
