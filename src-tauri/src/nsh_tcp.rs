use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

pub fn execute_at(host: Ipv4Addr, command: &str) -> Result<String, String> {
    let log_info = command.starts_with("jsbsim --mcap-info ");
    let network_command = matches!(command.split_whitespace().next(), Some("ifconfig" | "ifup" | "ifdown"));
    let timeout = if command.starts_with("ifup ") || command.starts_with("ifdown ") { 15 }
                  else if log_info { 6 } else { 2 };
    let _guard = crate::model_read::ReadControl::default().lock(
        &crate::romfs_network::NSH_LOCK, crate::model_read::CHANNEL_WAIT, "NSH")?;
    let port = std::env::var("NSH_TELNET_PORT")
        .ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(23);
    let address: SocketAddr = format!("{}:{}", host, port).parse()
        .map_err(|_| format!("invalid NSH target {}:{}", host, port))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| format!("cannot connect to NuttX NSH: {}", error))?;
    stream.set_read_timeout(Some(Duration::from_millis(250))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    stream.write_all(command.as_bytes()).and_then(|_| stream.write_all(b"\n"))
        .map_err(|error| format!("cannot send NSH command: {}", error))?;
    let mut output = Vec::new();
    let mut buffer = [0u8; 1024];
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let mut interrupted = false;
    loop {
        if Instant::now() >= deadline || output.len() >= 16384 {
            // Network ioctls may negotiate a PHY or invalidate this TCP
            // connection. Do not interrupt them; the caller reconnects and
            // verifies the resulting configuration at the requested IP.
            if network_command {
                return Err(format!("NSH network command did not complete at {host}; readback is required"));
            }
            /* Commands such as `top` continuously refresh the terminal.
             * This console executes one command per connection, so stop the
             * remote foreground command rather than leaving the UI waiting
             * forever for a prompt that will never arrive. */
            let _ = stream.write_all(&[0x03]);
            interrupted = true;
            break;
        }
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => {
                output.extend_from_slice(&buffer[..length]);
                // The first prompt precedes the command. The second marks
                // completion, including commands with no printed output.
                if network_command && output.windows(b"nsh> ".len())
                    .filter(|part| *part == b"nsh> ").count() >= 2 { break; }
                if log_info && output.iter().rposition(|byte| *byte == b'\n').is_some_and(|end| {
                    output[..end].windows(b"MCAP_INFO:".len()).any(|part| part == b"MCAP_INFO:") ||
                    output[..end].windows(b"MCAP_INFO_ERROR:".len()).any(|part| part == b"MCAP_INFO_ERROR:") ||
                    output[..end].windows(b"Unknown option: --mcap-info".len()).any(|part| part == b"Unknown option: --mcap-info")
                }) { break; }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock ||
                          error.kind() == std::io::ErrorKind::TimedOut => {
                if !log_info && !network_command { break; }
            },
            Err(error) => return Err(format!("cannot read NSH output: {}", error)),
        }
    }

    /* Do not close an idle Telnet socket underneath nsh_session: it would
     * make the board print `readline failed` and reset the TCP state.  End
     * the shell session cleanly after this one-shot command instead. */
    if command != "exit" {
        let _ = stream.write_all(b"exit\n");
        let cleanup_deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < cleanup_deadline {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => output.extend_from_slice(&buffer[..length]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock ||
                              error.kind() == std::io::ErrorKind::TimedOut => break,
                Err(_) => break,
            }
        }
    }
    let mut text = String::from_utf8_lossy(&output).replace('\r', "");
    if interrupted {
        text.push_str(&format!("\n[continuous output stopped after {} seconds; Ctrl+C sent]\n",
                               if log_info { 6 } else { 2 }));
    }
    Ok(text)
}
