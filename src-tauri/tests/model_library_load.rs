#![allow(dead_code)]

#[path = "../src/ftp_sync.rs"] mod ftp_sync;
#[path = "../src/romfs_network.rs"] mod romfs_network;
#[path = "../src/transport.rs"] mod transport;
#[path = "../src/network_discovery.rs"] mod network_discovery;
#[path = "../src/usb_file.rs"] mod usb_file;
#[path = "../src/remote_model.rs"] mod remote_model;
#[path = "../src/disabled_xml.rs"] mod disabled_xml;
#[path = "../src/xml_diagnostics.rs"] mod xml_diagnostics;

#[test]
fn config_load_uses_romfs_when_ftp_is_unavailable() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    std::env::set_var("NSH_TELNET_PORT", listener.local_addr().unwrap().port().to_string());
    std::env::set_var("SIM_UDP_HOST", "127.0.0.1");
    // A reserved, non-listening TCP port makes curl fail without contacting hardware.
    std::env::set_var("NUTTX_FTP_URL", "ftp://127.0.0.1:0");
    transport::set_mode("network").unwrap();
    let config = r#"{"version":1,"environment":{"windNorthFps":12}}"#;
    let board = std::thread::spawn(move || {
        for (path, content) in [
            ("config/models/voliro_t.json", config),
            ("config/global.json", r#"{"version":1}"#),
            ("config/models/missing.json", "nsh: cat: open failed: 2"),
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            stream.write_all(b"NuttShell (NSH)\n\rnsh> \x1b[K").unwrap();
            let mut command = String::new();
            reader.read_line(&mut command).unwrap();
            assert_eq!(command, format!("cat /romfs/jsbsim/{path}\n"));
            write!(stream, "\x1b[K{content}\n\rnsh> \x1b[K").unwrap();
            command.clear();
            reader.read_line(&mut command).unwrap();
            assert_eq!(command, "exit\n");
        }
    });
    assert_eq!(ftp_sync::download_config("config/models/voliro_t.json").unwrap().trim(), config);
    assert_eq!(ftp_sync::download_config("config/global.json").unwrap().trim(), r#"{"version":1}"#);
    let error = ftp_sync::download_config("config/models/missing.json").unwrap_err();
    assert!(error.contains("FTP:") && error.contains("open failed: 2"), "{error}");
    assert!(ftp_sync::download_config("config/models/../private.json").is_err());
    board.join().unwrap();
    for key in ["NSH_TELNET_PORT", "SIM_UDP_HOST", "NUTTX_FTP_URL"] { std::env::remove_var(key); }
}

#[test]
#[ignore = "read-only: requires SIM_UDP_HOST pointing at a board with voliro_t"]
fn live_voliro_model_and_sidecars() {
    transport::set_mode("network").unwrap();
    let (xml, refs) = remote_model::load("voliro_t", ftp_sync::download_path).unwrap();
    assert!(xml.contains("<fdm_config"));
    assert!(!refs.is_empty());
    println!("voliro_t: {} main XML bytes, {} resolved reference files", xml.len(), refs.len());
    for path in ["config/models/voliro_t.serial.xml", "config/models/voliro_t.pwm.xml"] {
        let content = ftp_sync::download_path(path).unwrap();
        assert!(content.contains("<?xml") || content.trim_start().starts_with('<'));
        println!("{path}: {} bytes", content.len());
    }
    let content = ftp_sync::download_config("config/models/voliro_t.json").unwrap();
    let config: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert!(config.is_object());
    println!("voliro_t.json: {} bytes, valid JSON", content.len());
}
