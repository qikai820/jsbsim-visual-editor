//! Minimal FTP synchronization for the external NuttX JSBSim instance.
//!
//! NuttX already provides `ftpd_start -4`; using the host `curl` binary keeps
//! the Tauri bundle small and avoids adding a second asynchronous runtime.

use std::io::Write;
use std::process::{Command, Stdio};

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

fn curl_output(args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", "15"])
        .args(args)
        .output()
        .map_err(|e| format!("cannot start curl: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
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

    // Keep the previous model on the SD card.  The old target may not exist
    // on first upload, so this FTP rename is intentionally best-effort.
    let _ = Command::new("curl")
        .args(["--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", "8",
               "--user", &auth,
               "-Q", &format!("DELE {}", backup),
               &format!("{}/", endpoint())])
        .output();

    let backup_result = Command::new("curl")
        .args(["--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", "8",
               "--user", &auth,
               "-Q", &format!("RNFR {}", target),
               "-Q", &format!("RNTO {}", backup),
               &format!("{}/", endpoint())])
        .output();
    if let Ok(result) = backup_result {
        if !result.status.success() {
            // A missing original is normal for a new model.  Do not hide
            // errors when the target exists but cannot be renamed.
            let error = String::from_utf8_lossy(&result.stderr);
            if !error.to_ascii_lowercase().contains("550") {
                let _ = Command::new("curl")
                    .args(["--silent", "--show-error", "--noproxy", "*",
                           "--disable-epsv", "--connect-timeout", "3", "--max-time", "8",
                           "--user", &auth, "-Q", &format!("DELE {}", temporary),
                           &format!("{}/", endpoint())])
                    .output();
                return Err(format!("cannot backup remote model: {}", error.trim()));
            }
        }
    }

    // Commit the complete temporary file atomically from the FTP namespace.
    let commit = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", "--noproxy", "*",
               "--disable-epsv", "--connect-timeout", "3", "--max-time", "8",
               "--user", &auth,
               "-Q", &format!("RNFR {}", temporary),
               "-Q", &format!("RNTO {}", target),
               &format!("{}/", endpoint())])
        .output()
        .map_err(|e| e.to_string())?;
    if !commit.status.success() {
        return Err(format!("cannot commit remote model: {}",
                           String::from_utf8_lossy(&commit.stderr).trim()));
    }
    Ok(())
}
