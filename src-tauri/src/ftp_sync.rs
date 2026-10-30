//! Minimal FTP synchronization for the external NuttX JSBSim instance.
//!
//! NuttX already provides `ftpd_start -4`; using the host `curl` binary keeps
//! the Tauri bundle small and avoids adding a second asynchronous runtime.

use std::io::Write;
use std::process::{Command, Stdio};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use serde::Serialize;

use crate::usb_file;
use crate::transport::{self, TransportMode};

// NuttX ftpd and its small TCP pool are easily exhausted by several curl
// processes connecting at once.  Serialize every FTP transaction in this
// module and leave a short interval for the server to reclaim the socket.
static FTP_LOCK: Mutex<()> = Mutex::new(());

struct UsbProbe {
    usable: bool,
    checked: Option<Instant>,
    file_unhealthy_until: Option<Instant>,
}

static USB_PROBE: OnceLock<Mutex<UsbProbe>> = OnceLock::new();

fn auto_usb_available() -> bool {
    let probe = USB_PROBE.get_or_init(|| Mutex::new(UsbProbe {
        usable: false,
        checked: None,
        file_unhealthy_until: None,
    }));
    let Ok(mut probe) = probe.lock() else {
        return false;
    };
    if probe.file_unhealthy_until.is_some_and(|until| Instant::now() < until) {
        return false;
    }
    if probe.checked.is_some_and(|checked| checked.elapsed() < Duration::from_secs(2)) {
        return probe.usable;
    }

    /* Do not make an Auto-mode UI action wait for a file PING while EP2 is
     * serving telemetry.  USB will be retried from the cached probe shortly;
     * network remains the immediate fallback. */
    probe.usable = usb_file::available_quick();
    probe.checked = Some(Instant::now());
    probe.usable
}

fn usb_file_transport_error(error: &str) -> bool {
    error.contains("timed out") || error.contains("USB bulk read failed") ||
        error.contains("USB bulk write failed") || error.contains("cannot claim USB interface") ||
        error.contains("USB device ") || error.contains("cannot initialize libusb")
}

fn mark_auto_usb_file_unhealthy() {
    if transport::mode() != TransportMode::Auto { return; }
    let probe = USB_PROBE.get_or_init(|| Mutex::new(UsbProbe {
        usable: false, checked: None, file_unhealthy_until: None,
    }));
    if let Ok(mut probe) = probe.lock() {
        probe.usable = false;
        probe.checked = Some(Instant::now());
        probe.file_unhealthy_until = Some(Instant::now() + Duration::from_secs(120));
    }
}

/* In automatic mode, prefer USB only when the complete protocol responds.
 * The explicit modes are shared with simulation telemetry and control. */
fn use_usb() -> bool {
    match transport::mode() {
        TransportMode::Usb => true,
        TransportMode::Network => false,
        TransportMode::Auto => auto_usb_available(),
    }
}

pub fn transport_source() -> &'static str {
    if use_usb() { "usb-bulk" } else { "nuttx-ftp" }
}

#[derive(Serialize)]
pub struct LogFileInfo {
    pub name: String,
    pub size: Option<u64>,
    pub modified: Option<String>,
}

fn endpoint() -> Result<String, String> {
    // The running Tauri dev process can retain an old launcher environment
    // after a Rust hot reload. A board verified by discovery or USB readback
    // must take precedence over that stale FTP URL.
    if let Some(address) = transport::network_host_override() {
        return Ok(format!("ftp://{address}"));
    }
    if let Ok(url) = std::env::var("NUTTX_FTP_URL") {
        return Ok(url.trim_end_matches('/').to_string());
    }
    let address = transport::network_host()
        .ok_or("未发现网口仿真机；请检查网线和仿真机网络服务")?;
    Ok(format!("ftp://{address}"))
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
    let full_date = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| {
            index == 4 || index == 7 || byte.is_ascii_digit()
        });

    /* FAT 8.3 directory entries truncate "YYYY-MM-DD" to "YYYY-MM-".
     * Treat that prefix as a date directory too, otherwise completed MCAP
     * files nested under it are invisible to the log centre. */
    let fat_date_prefix = bytes.len() == 8
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| {
            index == 4 || index == 7 || byte.is_ascii_digit()
        });

    full_date || fat_date_prefix
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

pub fn log_info_command(file: &str) -> Result<String, String> {
    safe_log_path(file)?;
    if !file.ends_with(".mcap") || file.len() > 100 ||
        !file.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/')) {
        return Err("invalid MCAP log path".into());
    }
    Ok(format!("jsbsim --mcap-info {file}"))
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
               &format!("{}/", endpoint()?)])
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
               &format!("{}/", endpoint()?)])
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

fn verify_uploaded_file(auth: &str, path: &str, expected: &[u8]) -> Result<(), String> {
    let url = format!("{}{}", endpoint()?, path);
    let output = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", "15",
               "--user", auth, &url])
        .output()
        .map_err(|error| format!("cannot read back uploaded file: {error}"))?;
    if !output.status.success() {
        return Err(format!("cannot read back {path}: {}",
                           String::from_utf8_lossy(&output.stderr).trim()));
    }
    if output.stdout != expected {
        return Err(format!("uploaded file differs on SD card: {path} (expected {} bytes, read {} bytes)",
                           expected.len(), output.stdout.len()));
    }
    Ok(())
}

fn list_directory(path: &str) -> Result<Vec<String>, String> {
    let path = path.trim_matches('/');
    if use_usb() {
        let built_in = usb_file::list(&format!("romfs/jsbsim{}{path}", if path.is_empty() { "" } else { "/" }));
        if let Err(error) = &built_in {
            if transport::mode() == TransportMode::Auto && usb_file_transport_error(error) {
                mark_auto_usb_file_unhealthy();
                return list_network_directory(path)
                    .map_err(|ftp_error| format!("{error}; FTP fallback failed: {ftp_error}"));
            }
        }
        let user = usb_file::list(&format!("jsbsim{}{path}", if path.is_empty() { "" } else { "/" }));
        let mut entries = match (built_in, user) {
            (Ok(mut built_in), Ok(user)) => { built_in.extend(user); built_in },
            (Ok(built_in), Err(_)) => built_in,
            (Err(_), Ok(user)) => user,
            (Err(built_in_error), Err(error)) => {
                if transport::mode() == TransportMode::Auto {
                    if usb_file_transport_error(&built_in_error) || usb_file_transport_error(&error) {
                        mark_auto_usb_file_unhealthy();
                    }
                    return list_network_directory(path)
                        .map_err(|ftp_error| format!("{error}; FTP fallback failed: {ftp_error}"));
                }
                return Err(error);
            },
        }.into_iter()
            .filter(|entry| path != "aircraft" || entry.directory)
            .map(|entry| entry.name)
            .filter(|name| safe_component(name).is_ok())
            .collect::<Vec<_>>();
        entries.sort();
        entries.dedup();
        return Ok(entries);
    }
    list_network_directory(path)
}

fn list_network_directory(path: &str) -> Result<Vec<String>, String> {
    // FTP is rooted at the SD card.  The board may expose its read-only
    // ROMFS through NSH, but some builds do not start telnetd.  When USB is
    // connected, its read-only file service can supply the missing ROMFS
    // entries without changing the selected network simulation transport.
    let built_in = crate::romfs_network::list(path).or_else(|nsh_error| {
        let usb_path = format!("romfs/jsbsim{}{path}", if path.is_empty() { "" } else { "/" });
        usb_file::list(&usb_path)
            .map(|entries| entries.into_iter()
                .filter(|entry| path != "aircraft" || entry.directory)
                .map(|entry| entry.name)
                .filter(|name| safe_component(name).is_ok())
                .collect())
            .map_err(|usb_error| format!("NSH: {nsh_error}; USB ROMFS: {usb_error}"))
    });
    let user = list_ftp_directory(path);
    let mut entries = match (built_in, user) {
        (Ok(mut built_in), Ok(user)) => { built_in.extend(user); built_in },
        (Ok(built_in), Err(_)) => built_in,
        (Err(_), Ok(user)) => user,
        (Err(romfs_error), Err(ftp_error)) => {
            return Err(format!("ROMFS: {romfs_error}; FTP: {ftp_error}"));
        },
    };
    entries.sort();
    entries.dedup();
    Ok(entries)
}

fn list_ftp_directory(path: &str) -> Result<Vec<String>, String> {
    let path = path.trim_matches('/');
    let url = format!("{}/jsbsim{}{path}/", endpoint()?, if path.is_empty() { "" } else { "/" });
    let auth = credentials();
    let bytes = curl_output(&["--user", &auth, "--list-only", &url])?;
    let mut entries: Vec<String> = String::from_utf8_lossy(&bytes)
        .lines()
        .map(|line| line.trim().trim_end_matches('/'))
        .filter(|name| safe_component(name).is_ok())
        .filter(|name| path != "aircraft" || !name.to_ascii_lowercase().ends_with(".xml"))
        .map(str::to_string)
        .collect();
    entries.sort();
    entries.dedup();
    Ok(entries)
}

fn read_usb_library(path: &str, built_in_first: bool) -> Result<String, String> {
    let built_in = format!("romfs/jsbsim/{path}");
    let user = format!("jsbsim/{path}");
    let (first, second) = if built_in_first { (&built_in, &user) } else { (&user, &built_in) };
    match usb_file::read_text(first) {
        Ok(content) => Ok(content),
        Err(first_error) => {
            if transport::mode() == TransportMode::Auto && usb_file_transport_error(&first_error) {
                mark_auto_usb_file_unhealthy();
                return read_ftp_library(path)
                    .map_err(|ftp_error| format!("{first_error}; FTP fallback failed: {ftp_error}"));
            }
            match usb_file::read_text(second) {
            Ok(content) => Ok(content),
            Err(error) if transport::mode() == TransportMode::Auto => {
                if usb_file_transport_error(&first_error) || usb_file_transport_error(&error) {
                    mark_auto_usb_file_unhealthy();
                }
                read_ftp_library(path)
                    .map_err(|ftp_error| format!("{error}; FTP fallback failed: {ftp_error}"))
            }
            Err(error) => Err(error),
            }
        },
    }
}

fn read_ftp_library(path: &str) -> Result<String, String> {
    safe_relative_path(path)?;
    let sd_read = || -> Result<Vec<u8>, String> {
        let url = format!("{}/jsbsim/{}", endpoint()?, path);
        let auth = credentials();
        curl_output(&["--user", &auth, &url])
    };
    match sd_read() {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|error| format!("remote text is not UTF-8: {error}")),
        Err(ftp_error) => crate::romfs_network::read_text(path)
            .or_else(|nsh_error| usb_file::read_text(&format!("romfs/jsbsim/{path}"))
                .map_err(|usb_error| format!("NSH: {nsh_error}; USB ROMFS: {usb_error}")))
            .map_err(|romfs_error| format!("FTP: {ftp_error}; ROMFS: {romfs_error}")),
    }
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
    if use_usb() {
        let usb_entries = usb_file::list(path);
        if let Ok(entries) = usb_entries {
            return Ok(entries.into_iter().map(|entry| entry.name).collect());
        } else { return Err(usb_entries.unwrap_err()); }
    }
    let url = format!("{}/{}/", endpoint()?, path.trim_matches('/'));
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
    if use_usb() {
        let size = usb_file::stat(&format!("LOG/{name}")).ok().map(|entry| entry.size);
        return LogFileInfo { modified: log_name_timestamp(&name), name, size };
    }
    let Ok(ftp_endpoint) = endpoint() else {
        return LogFileInfo { modified: log_name_timestamp(&name), name, size: None };
    };
    let url = format!("{}/LOG/{}", ftp_endpoint, name);
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

pub fn log_download_directory(configured_directory: Option<&str>) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "user home directory is not available")?;
    let requested = configured_directory.unwrap_or("~/Downloads/JSBSim-Logs");
    let requested = requested.strip_prefix("~/").map(|tail| format!("{home}/{tail}"))
        .unwrap_or_else(|| requested.to_string());
    let directory = std::path::PathBuf::from(requested);
    if !directory.is_absolute() || !directory.starts_with(&home) {
        return Err("log download directory must be an absolute path inside the current user's home directory".into());
    }
    Ok(directory)
}

fn log_download_paths(file: &str, configured_directory: Option<&str>) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let file = safe_log_path(file)?;
    if !file.to_ascii_lowercase().ends_with(".mcap") { return Err("remote file is not MCAP".into()); }
    let directory = log_download_directory(configured_directory)?;
    let local_name = file.rsplit('/').next().ok_or("invalid remote log path")?;
    let target = directory.join(local_name);
    let partial = directory.join(format!(".{local_name}.part"));
    Ok((target, partial))
}

pub fn log_download_partial_path(file: &str, configured_directory: Option<&str>) -> Result<std::path::PathBuf, String> {
    log_download_paths(file, configured_directory).map(|(_, partial)| partial)
}

pub fn complete_mcap_file(path: &std::path::Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    const MAGIC: [u8; 8] = [0x89, b'M', b'C', b'A', b'P', b'0', b'\r', b'\n'];
    if !std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file() && metadata.len() >= 16) {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else { return false; };
    let mut first = [0u8; 8];
    let mut last = [0u8; 8];
    file.read_exact(&mut first).is_ok() && file.seek(SeekFrom::End(-8)).is_ok()
        && file.read_exact(&mut last).is_ok() && first == MAGIC && last == MAGIC
}

const MCAP_MAGIC: [u8; 8] = [0x89, b'M', b'C', b'A', b'P', b'0', b'\r', b'\n'];

fn check_remote_mcap_header(url: &str, auth: &str) -> Result<(), String> {
    let prefix = curl_output(&["--user", auth, "--range", "0-7", url])
        .map_err(|error| format!("读取仿真机日志文件头失败：{error}"))?;
    if prefix.as_slice() != MCAP_MAGIC {
        return Err("仿真机上的日志文件头无效，无法用 PlotJuggler 打开（可能是存储或传输数据损坏）".into());
    }
    Ok(())
}

fn check_usb_mcap_header(file: &str) -> Result<(), String> {
    let prefix = usb_file::read_prefix(&format!("LOG/{file}"), MCAP_MAGIC.len())
        .map_err(|error| format!("通过 USB 读取仿真机日志文件头失败：{error}"))?;
    if prefix.as_slice() != MCAP_MAGIC {
        return Err("仿真机上的日志文件头无效，无法用 PlotJuggler 打开（可能是存储数据损坏）".into());
    }
    Ok(())
}

pub fn download_log(file: &str, configured_directory: Option<&str>, expected_size: Option<u64>, for_viewing: bool) -> Result<String, String> {
    let file = safe_log_path(file)?;
    let (target, partial) = log_download_paths(file, configured_directory)?;
    let size_matches = |path: &std::path::Path| std::fs::symlink_metadata(path).is_ok_and(|metadata|
        metadata.file_type().is_file() && expected_size.is_none_or(|size| metadata.len() == size));
    let usable = |path: &std::path::Path| size_matches(path) && (!for_viewing || complete_mcap_file(path));
    // Finalized MCAP names are unique. Reopening a previously downloaded log
    // must not start another multi-minute transfer from the board.
    if usable(&target) {
        return Ok(target.to_string_lossy().into_owned());
    }
    std::fs::create_dir_all(target.parent().ok_or("download directory is invalid")?)
        .map_err(|e| format!("cannot create download directory: {e}"))?;
    let valid_partial = || usable(&partial);
    let ftp_transfer = || -> Result<(), String> {
        let url = format!("{}/LOG/{}", endpoint()?, file); let auth = credentials();
        match if for_viewing { check_remote_mcap_header(&url, &auth) } else { Ok(()) } {
            Err(error) => Err(error),
            Ok(()) => {
                let mut result = Err("FTP 日志下载未开始".to_string());
                for attempt in 1..=2 {
                    let output = Command::new("curl").args(["--fail", "--silent", "--show-error", "--noproxy", "*", "--disable-epsv", "--connect-timeout", "3", "--speed-limit", "1024", "--speed-time", "30", "--user", &auth, "--output"])
                        .arg(&partial).arg(&url).output().map_err(|e| format!("cannot start curl: {e}"))?;
                    result = if output.status.success() && valid_partial() { Ok(()) }
                        else if output.status.success() { Err(format!("FTP 第 {attempt} 次下载不完整{}", if for_viewing { "或 MCAP 文件头/文件尾无效" } else { "" })) }
                        else { Err(format!("FTP 第 {attempt} 次下载失败：{}", String::from_utf8_lossy(&output.stderr).trim())) };
                    if result.is_ok() { break; }
                    if attempt == 1 { std::thread::sleep(Duration::from_millis(300)); }
                }
                result
            }
        }
    };
    let using_usb = use_usb();
    let mut transfer = if using_usb {
        (if for_viewing { check_usb_mcap_header(file) } else { Ok(()) }).and_then(|()|
            usb_file::download_to(&format!("LOG/{file}"), &partial).map(|_| ()))
    } else { ftp_transfer() };
    if transport::mode() == TransportMode::Auto && using_usb && (transfer.is_err() || !valid_partial()) {
        let first_error = transfer.err().unwrap_or_else(|| "USB 收到的日志不完整".into());
        transfer = ftp_transfer().map_err(|error| format!("USB 通道失败：{first_error}；{error}"));
    }
    if transport::mode() == TransportMode::Auto && !using_usb && (transfer.is_err() || !valid_partial()) {
        let first_error = transfer.err().unwrap_or_else(|| "FTP 收到的日志不完整".into());
        transfer = (if for_viewing { check_usb_mcap_header(file) } else { Ok(()) }).and_then(|()|
            usb_file::download_to(&format!("LOG/{file}"), &partial).map(|_| ()))
            .map_err(|error| format!("{first_error}；USB 备用通道失败：{error}"));
    }
    if let Err(error) = transfer {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    let size = std::fs::metadata(&partial).map(|value| value.len()).unwrap_or(0);
    if !valid_partial() {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("日志下载不完整：已收到 {size} 字节，预期 {} 字节", expected_size.map_or("未知".into(), |value| value.to_string())));
    }
    std::fs::rename(&partial, &target).map_err(|e| format!("cannot finalize downloaded log: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

pub fn delete_log(file: &str) -> Result<(), String> {
    let file = safe_log_path(file)?;
    if !file.to_ascii_lowercase().ends_with(".mcap") { return Err("remote file is not MCAP".into()); }
    if use_usb() {
        return usb_file::delete(&format!("LOG/{file}"));
    }
    /* curl sends --quote commands before navigating to the URL path.  The
     * old `DELE <file>` therefore ran in the FTP home directory rather than
     * LOG/, which NuttX reports as command-handler error -2 (ENOENT). */
    let url = format!("{}/", endpoint()?);
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
    if use_usb() {
        return usb_file::read_text(&format!("{}/{}", dsdl_root(), file));
    }
    let url = format!("{}/{}/{}", endpoint()?, dsdl_root(), file);
    let auth = credentials();
    String::from_utf8(curl_output(&["--user", &auth, &url])?)
        .map_err(|e| format!("DSDL is not UTF-8: {e}"))
}

pub fn download_path(path: &str) -> Result<String, String> {
    let path = safe_relative_path(path)?.trim_matches('/');
    if path.is_empty() || !path.to_ascii_lowercase().ends_with(".xml") {
        return Err("invalid remote XML path".into());
    }
    if use_usb() {
        return read_usb_library(path, false);
    }
    read_ftp_library(path)
}

pub fn download_simulator_version() -> Result<String, String> {
    if use_usb() {
        return read_usb_library("VERSION.json", true);
    }
    read_ftp_library("VERSION.json")
}

// NuttX ftpd can stall when an XML or JSON file arrives in a large TCP burst.
// Feed curl small chunks at the pace verified on the board; the caller still
// uploads to a temporary pathname and verifies it before committing.
fn upload_ftp_temporary(auth: &str, temp_url: &str, content: &[u8]) -> Result<(), String> {
    const CHUNK_BYTES: usize = 256;
    const CHUNK_DELAY: Duration = Duration::from_millis(60);
    let chunks = content.len().div_ceil(CHUNK_BYTES) as u64;
    let max_seconds = (chunks * 60 / 1000 + 30).to_string();
    let mut child = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", &max_seconds,
               "--user", auth, "--ftp-create-dirs", "--upload-file", "-", temp_url])
        .stdin(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|e| format!("cannot start curl: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("curl stdin unavailable")?;
    let mut write_error = None;
    for (index, chunk) in content.chunks(CHUNK_BYTES).enumerate() {
        if let Err(error) = stdin.write_all(chunk) {
            write_error = Some(error);
            break;
        }
        if index + 1 < chunks as usize {
            std::thread::sleep(CHUNK_DELAY);
        }
    }
    drop(stdin);
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if let Some(error) = write_error {
        return Err(format!("FTP upload stream failed: {error}; {}",
                           String::from_utf8_lossy(&output.stderr).trim()));
    }
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

/// Atomically replace a file below the NuttX JSBSim root.  The caller passes
/// a relative path such as `systems/foo.xml`; traversal and absolute paths are
/// rejected before curl is invoked.
pub fn upload_file(path: &str, content: &str) -> Result<(), String> {
    let path = safe_relative_path(path)?.trim_matches('/');
    if path.is_empty() || !path.to_ascii_lowercase().ends_with(".xml") {
        return Err("invalid remote XML path".into());
    }
    if use_usb() {
        return usb_file::write_all(&format!("jsbsim/{path}"), content.as_bytes());
    }
    let _guard = FTP_LOCK.lock().map_err(|e| format!("FTP lock poisoned: {e}"))?;
    let remote = format!("/jsbsim/{}", path);
    let temporary = format!("{}.upload", remote);
    let backup = format!("{}.bak", remote);
    let auth = credentials();
    let temp_url = format!("{}{}", endpoint()?, temporary);
    upload_ftp_temporary(&auth, &temp_url, content.as_bytes())?;

    verify_uploaded_file(&auth, &temporary, content.as_bytes())?;
    commit_uploaded_file(&auth, &temporary, &remote, &backup)
        .map_err(|e| format!("cannot commit {path}: {e}"))?;
    verify_uploaded_file(&auth, &remote, content.as_bytes())
}

pub fn upload_model_asset(model: &str, name: &str, content: &[u8]) -> Result<(), String> {
    let model = safe_component(model)?;
    if name.is_empty() || name.split('/').any(|part| {
        part.is_empty() || safe_component(part).is_err() ||
        !part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    }) || name.to_ascii_lowercase().ends_with(".xml") {
        return Err(format!("invalid model asset path: {name}"));
    }
    let path = format!("jsbsim/aircraft/{model}/{name}");
    if use_usb() {
        usb_file::write_all(&path, content)?;
        if usb_file::read_all(&path)? != content {
            return Err(format!("model asset readback mismatch: {path}"));
        }
        return Ok(());
    }
    let _guard = FTP_LOCK.lock().map_err(|e| format!("FTP lock poisoned: {e}"))?;
    let remote = format!("/{path}");
    let temporary = format!("{remote}.upload");
    let backup = format!("{remote}.bak");
    let auth = credentials();
    let temp_url = format!("{}{}", endpoint()?, temporary);
    upload_ftp_temporary(&auth, &temp_url, content)?;

    verify_uploaded_file(&auth, &temporary, content)?;
    commit_uploaded_file(&auth, &temporary, &remote, &backup)?;
    verify_uploaded_file(&auth, &remote, content)
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
    if use_usb() {
        return read_usb_library(path, false);
    }
    let url = format!("{}/jsbsim/{}", endpoint()?, path);
    let auth = credentials();
    String::from_utf8(curl_output(&["--user", &auth, &url])?)
        .map_err(|e| format!("remote config is not UTF-8: {e}"))
}

pub fn upload_config(path: &str, content: &str) -> Result<(), String> {
    let path = safe_config_path(path)?;
    serde_json::from_str::<serde_json::Value>(content)
        .map_err(|e| format!("invalid config JSON: {e}"))?;
    if use_usb() {
        return usb_file::write_all(&format!("jsbsim/{path}"), content.as_bytes());
    }
    let _guard = FTP_LOCK.lock().map_err(|e| format!("FTP lock poisoned: {e}"))?;
    let remote = format!("/jsbsim/{path}");
    let temporary = format!("{remote}.upload");
    let backup = format!("{remote}.bak");
    let auth = credentials();
    let temp_url = format!("{}{}", endpoint()?, temporary);
    upload_ftp_temporary(&auth, &temp_url, content.as_bytes())?;

    verify_uploaded_file(&auth, &temporary, content.as_bytes())?;
    commit_uploaded_file(&auth, &temporary, &remote, &backup)?;
    verify_uploaded_file(&auth, &remote, content.as_bytes())
}

pub fn list_models() -> Result<Vec<String>, String> {
    list_directory("aircraft")
}

/// A parent listing is the only safe way to distinguish a new XML path from
/// a failed read. NuttX can return ENOTDIR for a missing model directory.
pub fn list_xml_parent(parent: &str) -> Result<Option<Vec<String>>, String> {
    let parts: Vec<&str> = parent.split('/').collect();
    if parts.is_empty() || parts.len() > 6 || parts.iter().any(|part| safe_component(part).is_err()) ||
        (parts.len() > 1 && parts[0] != "aircraft" && parts != ["config", "models"]) ||
        (parts.len() == 1 && !matches!(parts[0], "aircraft" | "systems" | "engine" | "scripts")) {
        return Err("unsupported XML parent directory".into());
    }
    for depth in 1..parts.len() {
        let ancestor = parts[..depth].join("/");
        let entries = match list_directory(&ancestor) {
            Ok(entries) => entries,
            Err(error) if parts == ["config", "models"] => {
                let root = list_directory("")?;
                if !root.iter().any(|entry| entry.eq_ignore_ascii_case("config")) {
                    return Ok(None);
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        if !entries.iter().any(|entry| entry.eq_ignore_ascii_case(parts[depth])) {
            return Ok(None);
        }
    }
    list_directory(parent).map(Some)
}

pub fn list_scripts() -> Result<Vec<String>, String> {
    // A board may have aircraft models without a scripts directory. Treat
    // that optional directory as empty, while preserving genuine FTP errors.
    if !list_directory("")?.iter().any(|name| name.eq_ignore_ascii_case("scripts")) {
        return Ok(Vec::new());
    }
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
    let user_engine_names = if use_usb() { Vec::new() } else { list_ftp_directory("engine").unwrap_or_default() };
    for name in list_engines()? {
        let xml = if use_usb() {
            read_usb_library(&format!("engine/{name}"), true)?.to_ascii_lowercase()
        } else if user_engine_names.contains(&name) {
            read_ftp_library(&format!("engine/{name}"))?.to_ascii_lowercase()
        } else {
            crate::romfs_network::read_text(&format!("engine/{name}"))?.to_ascii_lowercase()
        };
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
    if use_usb() {
        return read_usb_library(&format!("aircraft/{model}/{model}.xml"), true);
    }
    read_ftp_library(&format!("aircraft/{model}/{model}.xml"))
}

pub fn download_script(file: &str) -> Result<String, String> {
    let file = safe_component(file)?;
    if !file.to_ascii_lowercase().ends_with(".xml") {
        return Err("invalid remote script name".into());
    }

    if use_usb() {
        // Edits are written to SD. Prefer that copy when a built-in script
        // has the same name, including the read after an upload.
        return read_usb_library(&format!("scripts/{file}"), false);
    }

    read_ftp_library(&format!("scripts/{file}"))
}

pub fn upload_model(model: &str, xml: &str) -> Result<(), String> {
    let model = safe_component(model)?;
    if use_usb() {
        return usb_file::write_all(
            &format!("jsbsim/aircraft/{model}/{model}.xml"), xml.as_bytes());
    }
    let _guard = FTP_LOCK.lock().map_err(|e| format!("FTP lock poisoned: {e}"))?;
    let remote_dir = format!("/jsbsim/aircraft/{}", model);
    let target = format!("{}/{}.xml", remote_dir, model);
    let backup = format!("{}.bak", target);
    let temporary = format!("{}.upload", target);
    let temp_url = format!("{}{}", endpoint()?, temporary);
    let auth = credentials();

    // Upload outside the live pathname first.  A failed transfer therefore
    // cannot truncate the model currently used by NuttX.
    upload_ftp_temporary(&auth, &temp_url, xml.as_bytes())?;

    verify_uploaded_file(&auth, &temporary, xml.as_bytes())?;
    commit_uploaded_file(&auth, &temporary, &target, &backup)
        .map_err(|e| format!("cannot commit remote model: {e}"))?;
    verify_uploaded_file(&auth, &target, xml.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::{complete_mcap_file, is_day_directory, log_info_command};

    #[test]
    fn log_info_only_accepts_shell_safe_log_paths() {
        assert_eq!(log_info_command("2026-09-27/jsbsim_quadrot_1790467200.mcap").unwrap(),
                   "jsbsim --mcap-info 2026-09-27/jsbsim_quadrot_1790467200.mcap");
        for path in ["../private.mcap", "2026-09-27/a;reboot.mcap", "x/../../y.mcap",
                     "2026-09-27/a file.mcap", "2026-09-27/a.active"] {
            assert!(log_info_command(path).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn recognizes_complete_and_fat_truncated_log_dates() {
        assert!(is_day_directory("2026-09-18"));
        assert!(is_day_directory("2026-09-"));
        assert!(!is_day_directory("2026-9-18"));
        assert!(!is_day_directory("logs"));
    }

    #[test]
    fn never_reopens_an_incomplete_or_redirected_cached_log() {
        let path = std::env::temp_dir().join(format!("jsbsim-mcap-cache-{}", std::process::id()));
        let magic = [0x89, b'M', b'C', b'A', b'P', b'0', b'\r', b'\n'];
        std::fs::write(&path, magic).unwrap();
        assert!(!complete_mcap_file(&path));
        std::fs::write(&path, [magic, magic].concat()).unwrap();
        assert!(complete_mcap_file(&path));
        std::fs::remove_file(&path).unwrap();
        #[cfg(unix)] {
            std::os::unix::fs::symlink("/dev/null", &path).unwrap();
            assert!(!complete_mcap_file(&path));
            std::fs::remove_file(&path).unwrap();
        }
    }
}
