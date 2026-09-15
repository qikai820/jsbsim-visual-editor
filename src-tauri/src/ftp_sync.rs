//! Minimal FTP synchronization for the external NuttX JSBSim instance.
//!
//! NuttX already provides `ftpd_start -4`; using the host `curl` binary keeps
//! the Tauri bundle small and avoids adding a second asynchronous runtime.

use std::io::Write;
use std::process::{Command, Stdio};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;
use serde::Serialize;

// NuttX ftpd and its small TCP pool are easily exhausted by several curl
// processes connecting at once.  Serialize every FTP transaction in this
// module and leave a short interval for the server to reclaim the socket.
static FTP_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
pub struct LogFileInfo {
    pub name: String,
    pub size: Option<u64>,
    pub modified: Option<String>,
}

fn endpoint() -> String {
    std::env::var("NUTTX_FTP_URL")
        .unwrap_or_else(|_| "ftp://192.168.101.81".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn credentials() -> String {
    let user = std::env::var("NUTTX_FTP_USER").unwrap_or_else(|_| "root".into());
    let password = std::env::var("NUTTX_FTP_PASSWORD").unwrap_or_else(|_| "abc123".into());
    format!("{}:{}", user, password)
}

fn safe_component(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value.contains("..")
    {
        return Err("invalid remote model name".into());
    }
    Ok(value)
}

fn is_day_directory(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| {
            index == 4 || index == 7 || byte.is_ascii_digit()
        })
}

fn safe_log_path(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.contains("..") || value.contains('\\') || value.starts_with('/') {
        return Err("invalid remote log path".into());
    }
    let parts: Vec<&str> = value.split('/').collect();
    let valid = match parts.as_slice() {
        [file] => safe_component(file).is_ok(),
        [day, file] => is_day_directory(day) && safe_component(file).is_ok(),
        _ => false,
    };
    if !valid { return Err("invalid remote log path".into()); }
    Ok(value)
}

fn curl_output(args: &[&str]) -> Result<Vec<u8>, String> {
    let _guard = FTP_LOCK.lock().map_err(|e| format!("FTP lock poisoned: {e}"))?;
    let output = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "2", "--max-time", "5"])
        .args(args)
        .output()
        .map_err(|e| format!("cannot start curl: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    std::thread::sleep(Duration::from_millis(80));
    Ok(output.stdout)
}

fn commit_uploaded_file(auth: &str, temporary: &str, target: &str, backup: &str) -> Result<(), String> {
    // NuttX ftpd closes the control connection after a failed DELE/RNFR, even
    // when curl was told to ignore the quote failure.  Use a unique backup
    // name so every command in the normal replacement path can succeed.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let unique_backup = format!("{backup}.{stamp}");
    let output = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", "12",
               "--user", auth,
               "-Q", &format!("RNFR {target}"),
               "-Q", &format!("RNTO {unique_backup}"),
               "-Q", &format!("RNFR {temporary}"),
               "-Q", &format!("RNTO {target}"),
               &format!("{}/", endpoint())])
        .output()
        .map_err(|e| format!("cannot start curl: {e}"))?;
    std::thread::sleep(Duration::from_millis(300));
    if output.status.success() {
        return Ok(());
    }

    // A brand-new file has no target to back up.  The failed RNFR makes the
    // NuttX server close that session, so reconnect only after it has released
    // the socket and commit the already complete temporary file directly.
    std::thread::sleep(Duration::from_millis(500));
    let retry = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", "10",
               "--user", auth,
               "-Q", &format!("RNFR {temporary}"),
               "-Q", &format!("RNTO {target}"),
               &format!("{}/", endpoint())])
        .output()
        .map_err(|e| format!("cannot start curl: {e}"))?;
    std::thread::sleep(Duration::from_millis(300));
    if retry.status.success() {
        Ok(())
    } else {
        let first = String::from_utf8_lossy(&output.stderr);
        let second = String::from_utf8_lossy(&retry.stderr);
        Err(format!("{}; retry: {}", first.trim(), second.trim()))
    }
}

fn list_directory(path: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/jsbsim/{}/", endpoint(), path);
    let auth = credentials();
    let bytes = curl_output(&["--user", &auth, "--list-only", &url])?;
    let mut entries: Vec<String> = String::from_utf8_lossy(&bytes)
        .lines()
        .map(|line| line.trim().trim_end_matches('/'))
        .filter(|name| safe_component(name).is_ok())
        .map(str::to_string)
        .collect();
    entries.sort();
    entries.dedup();
    Ok(entries)
}

fn dsdl_root() -> String {
    std::env::var("NUTTX_DSDL_ROOT")
        .unwrap_or_else(|_| "/mnt/sdcard/dsdl/px4".into())
        .trim_start_matches("/mnt/sdcard/")
        .trim_matches('/')
        .to_string()
}

fn safe_relative_path(path: &str) -> Result<&str, String> {
    if path.is_empty() || path.contains("..") || path.contains('\\') || path.starts_with('/') {
        return Err("invalid remote DSDL path".into());
    }
    Ok(path)
}

fn list_ftp_relative(path: &str) -> Result<Vec<String>, String> {
    safe_relative_path(path)?;
    let url = format!("{}/{}/", endpoint(), path.trim_matches('/'));
    let auth = credentials();
    let bytes = curl_output(&["--user", &auth, "--list-only", &url])?;
    Ok(String::from_utf8_lossy(&bytes).lines().map(str::trim)
        .filter(|name| !name.is_empty() && safe_component(name.trim_end_matches('/')).is_ok())
        .map(|name| name.trim_end_matches('/').to_string()).collect())
}

fn log_name_timestamp(name: &str) -> Option<String> {
    let name = name.rsplit('/').next()?;
    let stem = name.strip_suffix(".mcap")?;
    let seconds = stem.rsplit('_').next()?.parse::<u64>().ok()?;
    // The file name is generated from NuttX epoch seconds. Prefix it so the
    // UI can turn it into a local date without pulling a date crate into the
    // Tauri backend.
    Some(format!("epoch:{seconds}"))
}

fn log_info(name: String) -> LogFileInfo {
    let url = format!("{}/LOG/{}", endpoint(), name);
    let auth = credentials();
    let output = Command::new("curl")
        .args(["--silent", "--show-error", "--noproxy", "*", "--disable-epsv",
               "--connect-timeout", "2", "--max-time", "4", "--user", &auth, "--head", &url])
        .output();
    let mut size = None;
    let mut modified = None;
    if let Ok(output) = output {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let (key, value) = match line.split_once(':') { Some(value) => value, None => continue };
                if key.eq_ignore_ascii_case("content-length") { size = value.trim().parse().ok(); }
                if key.eq_ignore_ascii_case("last-modified") { modified = Some(value.trim().to_string()); }
            }
        }
    }
    LogFileInfo { modified: modified.or_else(|| log_name_timestamp(&name)), name, size }
}

pub fn list_logs() -> Result<Vec<LogFileInfo>, String> {
    let entries = list_ftp_relative("LOG")?;
    let mut files = Vec::new();
    for entry in entries {
        if entry.to_ascii_lowercase().ends_with(".mcap") {
            files.push(entry);
        } else if is_day_directory(&entry) {
            if let Ok(day_files) = list_ftp_relative(&format!("LOG/{entry}")) {
                files.extend(day_files.into_iter()
                    .filter(|name| name.to_ascii_lowercase().ends_with(".mcap"))
                    .map(|name| format!("{entry}/{name}")));
            }
        }
    }
    files.sort();
    files.reverse();
    Ok(files.into_iter().map(log_info).collect())
}

pub fn download_log(file: &str, configured_directory: Option<&str>) -> Result<String, String> {
    let file = safe_log_path(file)?;
    if !file.to_ascii_lowercase().ends_with(".mcap") { return Err("remote file is not MCAP".into()); }
    let home = std::env::var("HOME").map_err(|_| "HOME is not available")?;
    let requested = configured_directory.unwrap_or("~/Downloads/JSBSim-Logs");
    let requested = requested.strip_prefix("~/").map(|tail| format!("{home}/{tail}"))
        .unwrap_or_else(|| requested.to_string());
    let directory = std::path::PathBuf::from(requested);
    if !directory.is_absolute() || !directory.starts_with(&home) {
        return Err("log download directory must be an absolute path inside the current user's home directory".into());
    }
    std::fs::create_dir_all(&directory).map_err(|e| format!("cannot create download directory: {e}"))?;
    let local_name = file.rsplit('/').next().ok_or("invalid remote log path")?;
    let target = directory.join(local_name);
    let partial = directory.join(format!(".{local_name}.part"));
    let url = format!("{}/LOG/{}", endpoint(), file); let auth = credentials();
    let status = Command::new("curl").args(["--fail", "--silent", "--show-error", "--noproxy", "*", "--disable-epsv", "--connect-timeout", "3", "--user", &auth, "--output"])
        .arg(&partial).arg(&url).status().map_err(|e| format!("cannot start curl: {e}"))?;
    if !status.success() { let _ = std::fs::remove_file(&partial); return Err("FTP log download failed".into()); }
    let bytes = std::fs::read(&partial).map_err(|e| format!("cannot inspect downloaded log: {e}"))?;
    const MCAP_MAGIC: [u8; 8] = [0x89, b'M', b'C', b'A', b'P', b'0', b'\r', b'\n'];
    if bytes.len() < MCAP_MAGIC.len() || bytes[..MCAP_MAGIC.len()] != MCAP_MAGIC {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("downloaded log is empty or incomplete ({} bytes); wait for the simulation to finish and refresh", bytes.len()));
    }
    std::fs::rename(&partial, &target).map_err(|e| format!("cannot finalize downloaded log: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

pub fn delete_log(file: &str) -> Result<(), String> {
    let file = safe_log_path(file)?;
    if !file.to_ascii_lowercase().ends_with(".mcap") { return Err("remote file is not MCAP".into()); }
    /* curl sends --quote commands before navigating to the URL path.  The
     * old `DELE <file>` therefore ran in the FTP home directory rather than
     * LOG/, which NuttX reports as command-handler error -2 (ENOENT). */
    let url = format!("{}/", endpoint());
    let auth = credentials();
    let command = format!("DELE /LOG/{file}");
    let output = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", "8",
               "--user", &auth, "-Q", &command, &url])
        .output().map_err(|e| format!("cannot start curl: {e}"))?;
    if output.status.success() { Ok(()) }
    else {
        Err(format!("FTP log delete failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()))
    }
}

pub fn list_dsdl_files() -> Result<Vec<String>, String> {
    let root = dsdl_root();
    let mut queue = VecDeque::from([(root.clone(), 0usize)]);
    let mut files = Vec::new();
    while let Some((dir, depth)) = queue.pop_front() {
        if depth > 14 || files.len() > 5000 { continue; }
        let entries = match list_ftp_relative(&dir) {
            Ok(entries) => entries,
            Err(error) if dir == root => {
                return Err(format!("cannot read /mnt/sdcard/{root}: {error}"));
            }
            Err(_) => continue,
        };
        for entry in entries {
            let path = format!("{}/{}", dir, entry);
            let lower = entry.to_ascii_lowercase();
            if lower.ends_with(".dsdl") || lower.ends_with(".uavcan") {
                files.push(path.strip_prefix(&format!("{}/", root)).unwrap_or(&path).to_string());
            } else if !entry.contains('.') {
                queue.push_back((path, depth + 1));
            }
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

pub fn download_dsdl(file: &str) -> Result<String, String> {
    let file = safe_relative_path(file)?;
    let lower = file.to_ascii_lowercase();
    if !lower.ends_with(".dsdl") && !lower.ends_with(".uavcan") {
        return Err("remote file is not DSDL".into());
    }
    let url = format!("{}/{}/{}", endpoint(), dsdl_root(), file);
    let auth = credentials();
    String::from_utf8(curl_output(&["--user", &auth, &url])?)
        .map_err(|e| format!("DSDL is not UTF-8: {e}"))
}

pub fn download_path(path: &str) -> Result<String, String> {
    let path = safe_relative_path(path)?.trim_matches('/');
    if path.is_empty() || !path.to_ascii_lowercase().ends_with(".xml") {
        return Err("invalid remote XML path".into());
    }
    let url = format!("{}/jsbsim/{}", endpoint(), path);
    let auth = credentials();
    String::from_utf8(curl_output(&["--user", &auth, &url])?)
        .map_err(|e| format!("remote XML is not UTF-8: {e}"))
}

pub fn download_simulator_version() -> Result<String, String> {
    let url = format!("{}/jsbsim/VERSION.json", endpoint());
    let auth = credentials();
    String::from_utf8(curl_output(&["--user", &auth, &url])?)
        .map_err(|e| format!("simulator version is not UTF-8: {e}"))
}

/// Atomically replace a file below the NuttX JSBSim root.  The caller passes
/// a relative path such as `systems/foo.xml`; traversal and absolute paths are
/// rejected before curl is invoked.
pub fn upload_file(path: &str, content: &str) -> Result<(), String> {
    let _guard = FTP_LOCK.lock().map_err(|e| format!("FTP lock poisoned: {e}"))?;
    let path = safe_relative_path(path)?.trim_matches('/');
    if path.is_empty() || !path.to_ascii_lowercase().ends_with(".xml") {
        return Err("invalid remote XML path".into());
    }
    let remote = format!("/jsbsim/{}", path);
    let temporary = format!("{}.upload", remote);
    let backup = format!("{}.bak", remote);
    let auth = credentials();
    let temp_url = format!("{}{}", endpoint(), temporary);
    let mut child = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*", "--disable-epsv", "--connect-timeout", "3", "--max-time", "15", "--user", &auth, "--ftp-create-dirs", "--upload-file", "-", &temp_url])
        .stdin(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|e| format!("cannot start curl: {e}"))?;
    child.stdin.take().ok_or("curl stdin unavailable")?.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    let result = child.wait_with_output().map_err(|e| e.to_string())?;
    if !result.status.success() { return Err(String::from_utf8_lossy(&result.stderr).trim().to_string()); }

    commit_uploaded_file(&auth, &temporary, &remote, &backup)
        .map_err(|e| format!("cannot commit {path}: {e}"))
}

fn safe_config_path(path: &str) -> Result<&str, String> {
    let path = safe_relative_path(path)?.trim_matches('/');
    let valid = path == "config/global.json" ||
        (path.starts_with("config/models/") && path.ends_with(".json") &&
         safe_component(path.trim_start_matches("config/models/").trim_end_matches(".json")).is_ok());
    if valid { Ok(path) } else { Err("invalid simulation config path".into()) }
}

pub fn download_config(path: &str) -> Result<String, String> {
    let path = safe_config_path(path)?;
    let url = format!("{}/jsbsim/{}", endpoint(), path);
    let auth = credentials();
    String::from_utf8(curl_output(&["--user", &auth, &url])?)
        .map_err(|e| format!("remote config is not UTF-8: {e}"))
}

pub fn upload_config(path: &str, content: &str) -> Result<(), String> {
    let _guard = FTP_LOCK.lock().map_err(|e| format!("FTP lock poisoned: {e}"))?;
    let path = safe_config_path(path)?;
    serde_json::from_str::<serde_json::Value>(content)
        .map_err(|e| format!("invalid config JSON: {e}"))?;
    let remote = format!("/jsbsim/{path}");
    let temporary = format!("{remote}.upload");
    let backup = format!("{remote}.bak");
    let auth = credentials();
    let temp_url = format!("{}{}", endpoint(), temporary);
    let mut child = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*", "--disable-epsv",
               "--connect-timeout", "3", "--max-time", "15", "--user", &auth,
               "--ftp-create-dirs", "--upload-file", "-", &temp_url])
        .stdin(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|e| format!("cannot start curl: {e}"))?;
    child.stdin.take().ok_or("curl stdin unavailable")?.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    commit_uploaded_file(&auth, &temporary, &remote, &backup)
}

pub fn list_models() -> Result<Vec<String>, String> {
    list_directory("aircraft")
}

pub fn list_scripts() -> Result<Vec<String>, String> {
    Ok(list_directory("scripts")?.into_iter()
        .filter(|name| name.ends_with(".xml"))
        .collect())
}

pub fn list_systems() -> Result<Vec<String>, String> {
    Ok(list_directory("systems")?.into_iter()
        .filter(|name| name.to_ascii_lowercase().ends_with(".xml"))
        .collect())
}

pub fn list_engines() -> Result<Vec<String>, String> {
    Ok(list_directory("engine")?.into_iter()
        .filter(|name| name.to_ascii_lowercase().ends_with(".xml"))
        .collect())
}

pub fn list_engine_catalog() -> Result<(Vec<String>, Vec<String>), String> {
    let mut engines = Vec::new();
    let mut propellers = Vec::new();
    for name in list_engines()? {
        let url = format!("{}/jsbsim/engine/{}", endpoint(), name);
        let auth = credentials();
        let xml = String::from_utf8_lossy(&curl_output(&["--user", &auth, &url])?).to_ascii_lowercase();
        if xml.contains("<propeller") {
            propellers.push(name);
        } else if xml.contains("<piston_engine") || xml.contains("<turbine_engine")
            || xml.contains("<turboprop_engine") || xml.contains("<rocket_engine")
            || xml.contains("<electric_engine") {
            engines.push(name);
        }
    }
    Ok((engines, propellers))
}

pub fn download_model(model: &str) -> Result<String, String> {
    let model = safe_component(model)?;
    let url = format!("{}/jsbsim/aircraft/{}/{}.xml", endpoint(), model, model);
    let auth = credentials();
    let bytes = curl_output(&["--user", &auth, &url])?;
    String::from_utf8(bytes).map_err(|e| format!("model XML is not UTF-8: {e}"))
}

pub fn download_script(file: &str) -> Result<String, String> {
    let file = safe_component(file)?;
    if !file.to_ascii_lowercase().ends_with(".xml") {
        return Err("invalid remote script name".into());
    }

    let url = format!("{}/jsbsim/scripts/{}", endpoint(), file);
    let auth = credentials();
    let bytes = curl_output(&["--user", &auth, &url])?;
    String::from_utf8(bytes).map_err(|e| format!("script XML is not UTF-8: {e}"))
}

pub fn upload_model(model: &str, xml: &str) -> Result<(), String> {
    let _guard = FTP_LOCK.lock().map_err(|e| format!("FTP lock poisoned: {e}"))?;
    let model = safe_component(model)?;
    let remote_dir = format!("/jsbsim/aircraft/{}", model);
    let target = format!("{}/{}.xml", remote_dir, model);
    let backup = format!("{}.bak", target);
    let temporary = format!("{}.upload", target);
    let temp_url = format!("{}{}", endpoint(), temporary);
    let auth = credentials();

    // Upload outside the live pathname first.  A failed transfer therefore
    // cannot truncate the model currently used by NuttX.
    let mut child = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", "15"])
        .args(["--user", &auth, "--ftp-create-dirs", "--upload-file", "-", &temp_url])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start curl: {e}"))?;
    child.stdin.take().ok_or("curl stdin unavailable")?
        .write_all(xml.as_bytes()).map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    commit_uploaded_file(&auth, &temporary, &target, &backup)
        .map_err(|e| format!("cannot commit remote model: {e}"))
}
