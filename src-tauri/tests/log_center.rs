#![cfg(unix)]
#![allow(dead_code)]

#[allow(dead_code)] #[path = "../src/model_read.rs"] mod model_read;
#[path = "../src/ftp_sync.rs"] mod ftp_sync;
#[path = "../src/romfs_network.rs"] mod romfs_network;
#[path = "../src/transport.rs"] mod transport;
#[path = "../src/network_discovery.rs"] mod network_discovery;
#[path = "../src/usb_file.rs"] mod usb_file;

// One test owns the process environment. All commands and files belong to
// this fixture; no request can reach a physical simulator.
#[test]
fn log_access_handles_sd_ssd_service_restart_and_missing_mount() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    let directory = std::env::current_dir().unwrap().join(format!(".log-center-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let keys = ["PATH", "SIM_UDP_HOST", "NUTTX_FTP_URL", "NSH_TELNET_PORT", "LOG_TEST_LAYOUT", "LOG_TEST_DIR"];
    struct Cleanup { path: std::path::PathBuf, vars: Vec<(&'static str, Option<std::ffi::OsString>)> }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for (key, value) in &self.vars {
                if let Some(value) = value { std::env::set_var(key, value); }
                else { std::env::remove_var(key); }
            }
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
    let _cleanup = Cleanup { path: directory.clone(), vars: keys.iter().map(|&key| (key, std::env::var_os(key))).collect() };
    let curl = directory.join("curl");
    std::fs::write(&curl, r#"#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ['LOG_TEST_DIR'])
with (root / 'requests').open('a') as f: f.write(json.dumps(args) + '\n')
layout = os.environ['LOG_TEST_LAYOUT']
if layout.startswith('restart') and not (root / 'started').exists():
    code = 28 if layout == 'restart-timeout' else 7
    print(f'curl: ({code}) Failed to connect', file=sys.stderr); sys.exit(code)
prefix = 'LOG' if layout == 'sd' else 'jsbsim/LOG'
url = args[-1]
magic = b'\x89MCAP0\r\n'
if '-Q' in args:
    assert args[args.index('-Q') + 1].startswith('DELE /' + prefix + '/')
elif '--output' in args:
    assert '/' + prefix + '/' in url
    pathlib.Path(args[args.index('--output') + 1]).write_bytes(magic * 2)
elif '--range' in args:
    assert '/' + prefix + '/' in url
    sys.stdout.buffer.write(magic)
elif '--head' in args:
    assert '/' + prefix + '/' in url
    print('Content-Length: 16')
elif url == 'ftp://127.0.0.1/':
    print('LOG\njsbsim' if layout == 'sd' else 'jsbsim')
elif url == 'ftp://127.0.0.1/' + prefix + '/':
    print('2026-11-07')
elif url == 'ftp://127.0.0.1/' + prefix + '/2026-11-07/':
    print('test_1794010000.mcap')
else:
    raise AssertionError(url)
"#).unwrap();
    std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("PATH", format!("{}:{}", directory.display(), std::env::var("PATH").unwrap()));
    std::env::set_var("SIM_UDP_HOST", "127.0.0.1");
    std::env::set_var("NUTTX_FTP_URL", "ftp://127.0.0.1");
    std::env::set_var("LOG_TEST_DIR", &directory);
    transport::set_mode("network").unwrap();

    for layout in ["sd", "ssd", "restart", "restart-timeout", "unmounted"] {
        std::env::set_var("LOG_TEST_LAYOUT", layout);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        std::env::set_var("NSH_TELNET_PORT", listener.local_addr().unwrap().port().to_string());
        let sessions = match layout { "sd" => 0, "unmounted" => 1, "restart" | "restart-timeout" => 4, _ => 3 };
        let marker = directory.join("started");
        let _ = std::fs::remove_file(&marker);
        let board = std::thread::spawn(move || {
            for _ in 0..sessions {
                let deadline = Instant::now() + Duration::from_secs(8);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                            std::thread::sleep(Duration::from_millis(10)),
                        error => panic!("missing NSH session: {error:?}"),
                    }
                };
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                stream.write_all(b"NuttShell\n\rnsh> ").unwrap();
                loop {
                    let mut command = String::new();
                    reader.read_line(&mut command).unwrap();
                    let output = match command.trim() {
                        "uname -a" => "NuttX orangepi-5-plus",
                        "mount" if layout == "unmounted" => "/romfs type romfs",
                        "mount" => "/mnt/home type ext4",
                        "ftpd_start -4" if layout.starts_with("restart") => {
                            std::fs::write(&marker, "started").unwrap(); "FTP daemon started"
                        }
                        "exit" => break,
                        other => panic!("unexpected NSH command: {other}"),
                    };
                    write!(stream, "{output}\n\rnsh> ").unwrap();
                }
            }
        });
        let listing = ftp_sync::list_logs();
        if layout == "unmounted" {
            assert!(listing.err().unwrap().contains("SSD 数据分区未挂载"));
        } else {
            let listing = listing.unwrap();
            assert_eq!(listing.root, if layout == "sd" { "LOG" } else { "jsbsim/LOG" });
            assert_eq!(listing.files.len(), 1);
            let file = &listing.files[0];
            assert_eq!(file.name, "2026-11-07/test_1794010000.mcap");
            assert_eq!(file.size, Some(16));
            // Each scenario gets its own cache so a previous download cannot
            // bypass the URL/header checks in the transfer code.
            let downloads = directory.join(layout);
            let downloaded = ftp_sync::download_log(&file.name, downloads.to_str(), Some(16), true).unwrap();
            assert!(ftp_sync::complete_mcap_file(std::path::Path::new(&downloaded)));
            ftp_sync::delete_log(&file.name).unwrap();
        }
        board.join().unwrap();
    }
}
