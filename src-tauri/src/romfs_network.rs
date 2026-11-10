//! Read the board's read-only JSBSim ROMFS through its NSH Telnet service.
//! NuttX FTP exposes the SD card but cannot change into /romfs on this board.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use crate::model_read::{ReadControl, CHANNEL_WAIT};

const PROMPT: &[u8] = b"nsh> ";
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
pub(crate) static NSH_LOCK: Mutex<()> = Mutex::new(());

fn safe_path(path: &str) -> Result<(), String> {
    if path.len() > 240 || path.starts_with('/') || path.contains('\\') ||
        path.split('/').any(|part| part.is_empty() || part == "." || part == ".." ||
            !part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))) {
        return Err("invalid ROMFS path".into());
    }
    Ok(())
}

fn read_until_progress(stream: &mut TcpStream, marker: &[u8], deadline: Instant, control: &ReadControl, mut progress: impl FnMut(&[u8])) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        control.check()?;
        // readline can append a clear-to-end sequence to the prompt in the
        // same TCP packet. Waiting for an exact suffix then times out even
        // though the shell is already ready for the next command.
        let mut end = output.len();
        while output[..end].ends_with(b"\x1b[K") { end -= 3; }
        if output[..end].ends_with(marker) { output.truncate(end); return Ok(output); }
        if Instant::now() >= deadline { return Err("NSH response timed out".into()); }
        match stream.read(&mut buffer) {
            Ok(0) => return Err("NSH connection closed before prompt".into()),
            Ok(length) => {
                progress(&buffer[..length]);
                output.extend_from_slice(&buffer[..length]);
                if output.len() > MAX_RESPONSE { return Err("NSH response exceeds 2 MiB".into()); }
            }
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {},
            Err(error) => return Err(format!("cannot read NSH response: {error}")),
        }
    }
}

fn close_session(stream: &mut TcpStream) -> Result<(), String> {
    stream.write_all(b"exit\n").map_err(|error| format!("cannot exit NSH: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut buffer = [0u8; 1024];
    loop {
        if Instant::now() >= deadline { return Err("NSH exit timed out".into()); }
        match stream.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(_) => {},
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {},
            Err(error) => return Err(format!("cannot finish NSH session: {error}")),
        }
    }
}

fn parse_response(raw: &[u8]) -> Result<String, String> {
    let body = raw.strip_suffix(PROMPT).ok_or("NSH prompt missing")?;
    let body = body.strip_suffix(b"\r").unwrap_or(body);
    let mut body = body;
    // NuttX echoes each typed character as a terminal clear-to-end sequence.
    while let Some(rest) = body.strip_prefix(b"\x1b[K") { body = rest; }
    let bytes: Vec<u8> = body.iter().copied().filter(|byte| *byte != b'\r').collect();
    String::from_utf8(bytes).map_err(|error| format!("ROMFS text is not UTF-8: {error}"))
}

fn run(command: &str) -> Result<String, String> {
    let host = crate::transport::network_host()
        .ok_or("未发现网口仿真机；请检查网线和仿真机网络服务")?;
    run_on_host(host, command)
}

pub(crate) struct NshSession<'a> {
    stream: &'a mut TcpStream,
    control: &'a ReadControl,
}

impl NshSession<'_> {
    pub(crate) fn command(&mut self, command: &str) -> Result<String, String> {
        self.command_progress(command, Duration::from_secs(30), |_| {})
    }

    pub(crate) fn command_progress(&mut self, command: &str, timeout: Duration, progress: impl FnMut(&[u8])) -> Result<String, String> {
        if command.contains(['\n', '\r', '\0']) || command.len() >= 2048 {
            return Err("invalid or oversized NSH command".into());
        }
        self.control.check()?;
        self.stream.write_all(command.as_bytes()).and_then(|_| self.stream.write_all(b"\n"))
            .map_err(|error| format!("cannot send NSH command: {error}"))?;
        let raw = read_until_progress(self.stream, PROMPT, Instant::now() + timeout, self.control, progress)
            .map_err(|error| format!("NSH {}: {error}", command.split_whitespace().next().unwrap_or("command")))?;
        parse_response(&raw)
    }
}

pub(crate) fn with_session<T>(operation: impl FnOnce(&mut NshSession<'_>) -> Result<T, String>) -> Result<T, String> {
    let host = crate::transport::network_host()
        .ok_or("未发现网口仿真机；请检查网线和仿真机网络服务")?;
    with_host_session(host, operation)
}

fn run_on_host(host: Ipv4Addr, command: &str) -> Result<String, String> {
    with_host_session(host, |session| session.command(command))
}

pub(crate) fn with_host_session<T>(host: Ipv4Addr, operation: impl FnOnce(&mut NshSession<'_>) -> Result<T, String>) -> Result<T, String> {
    with_host_session_control(host, &ReadControl::default(), operation)
}

fn with_host_session_control<T>(host: Ipv4Addr, control: &ReadControl, operation: impl FnOnce(&mut NshSession<'_>) -> Result<T, String>) -> Result<T, String> {
    let _guard = control.lock(&NSH_LOCK, CHANNEL_WAIT, "NSH")?;
    control.check()?;
    let port = std::env::var("NSH_TELNET_PORT")
        .ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(23);
    let address = SocketAddr::from((host, port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| format!("cannot connect to board ROMFS via NSH: {error}"))?;
    stream.set_read_timeout(Some(Duration::from_millis(250))).map_err(|error| error.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|error| error.to_string())?;
    stream.set_nodelay(true).map_err(|error| error.to_string())?;
    let result = (|| {
        read_until_progress(&mut stream, PROMPT, Instant::now() + Duration::from_secs(3), control, |_| {})
            .map_err(|error| format!("NSH handshake: {error}"))?;
        operation(&mut NshSession { stream: &mut stream, control })
    })();
    // Abruptly closing a Telnet session can stop this board's telnetd task.
    // Always send exit and wait for EOF, even when the command has failed.
    let cleanup = close_session(&mut stream);
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    }
}

/// Probe a candidate directly: resolving the target here would recurse into
/// discovery. FTP is rooted at the SD card, which may have no user library.
pub fn verify_library(host: Ipv4Addr) -> bool {
    let Ok(output) = run_on_host(host, "ls /romfs/jsbsim") else { return false; };
    let entries: Vec<_> = output.lines().map(str::trim).collect();
    entries.contains(&"/romfs/jsbsim:") &&
        entries.contains(&"aircraft/") && entries.contains(&"engine/")
}

pub fn list(path: &str) -> Result<Vec<String>, String> {
    if !path.is_empty() { safe_path(path)?; }
    let directory = if path.is_empty() { "/romfs/jsbsim".to_string() }
                    else { format!("/romfs/jsbsim/{path}") };
    let output = run(&format!("ls {directory}"))?;
    let header = format!("{directory}:\n");
    let body = output.strip_prefix(&header)
        .ok_or_else(|| format!("cannot list board ROMFS {directory}: {}", output.trim()))?;
    let mut entries: Vec<String> = body.lines()
        .map(str::trim)
        .filter(|line| path != "aircraft" || line.ends_with('/'))
        .map(|line| line.trim_end_matches('/'))
        .filter(|name| safe_path(name).is_ok())
        .map(str::to_string)
        .collect();
    entries.sort();
    entries.dedup();
    Ok(entries)
}

pub fn read_text(path: &str) -> Result<String, String> {
    read_text_with_control(path, &ReadControl::default())
}

pub fn read_text_with_control(path: &str, control: &ReadControl) -> Result<String, String> {
    safe_path(path)?;
    control.check()?;
    let host = crate::transport::network_host()
        .ok_or("未发现网口仿真机；请检查网线和仿真机网络服务")?;
    let output = with_host_session_control(host, control, |session| session.command(&format!("cat /romfs/jsbsim/{path}")))?;
    if output.is_empty() || output.starts_with("cat: ") || output.starts_with("nsh: ") {
        return Err(format!("cannot read board ROMFS {path}: {}", output.trim()));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_nsh_terminal_echo_without_losing_xml_newline() {
        assert_eq!(parse_response(b"\x1b[K\x1b[K<xml>\n\rnsh> ").unwrap(), "<xml>\n");
    }

    #[test]
    fn rejects_shell_metacharacters_and_parent_paths() {
        for path in ["../x", "aircraft/a;reboot", "aircraft//a", "/romfs/jsbsim"] {
            assert!(safe_path(path).is_err());
        }
    }
}
