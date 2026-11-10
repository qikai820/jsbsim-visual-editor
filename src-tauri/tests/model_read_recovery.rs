#![allow(dead_code)]
#[path = "../src/model_read.rs"] mod model_read;
#[path = "../src/ftp_sync.rs"] mod ftp_sync;
#[path = "../src/romfs_network.rs"] mod romfs_network;
#[path = "../src/transport.rs"] mod transport;
#[path = "../src/network_discovery.rs"] mod network_discovery;
#[path = "../src/usb_file.rs"] mod usb_file;
#[path = "../src/remote_model.rs"] mod remote_model;
#[path = "../src/disabled_xml.rs"] mod disabled_xml;
#[path = "../src/xml_diagnostics.rs"] mod xml_diagnostics;

// A real TCP fixture exercises cancellation through FTP fallback, NSH lock
// acquisition, a stalled NSH reply, clean exit, and the next model's references.
// It never connects to or writes files on a physical simulator.
#[test]
fn cancelled_network_model_read_releases_channel_and_retry_loads_all_files() {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, mpsc};
    use std::time::{Duration, Instant};

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    std::env::set_var("NSH_TELNET_PORT", listener.local_addr().unwrap().port().to_string());
    std::env::set_var("SIM_UDP_HOST", "127.0.0.1");
    std::env::set_var("NUTTX_FTP_URL", "ftp://127.0.0.1:0");
    transport::set_mode("network").unwrap();
    let requests = Arc::new(model_read::ReadRequests::default());

    // Cancellation must finish even while another session still owns NSH.
    let held = romfs_network::NSH_LOCK.lock().unwrap();
    let control = requests.begin("waiting").unwrap();
    let waiting = std::thread::spawn(move || ftp_sync::download_path_with_control("aircraft/voliro_t/voliro_t.xml", &control));
    std::thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    requests.cancel("waiting").unwrap();
    assert!(waiting.join().unwrap().unwrap_err().contains("已取消"));
    assert!(started.elapsed() < Duration::from_secs(2));
    requests.finish("waiting");
    drop(held);

    let (command_seen, command_ready) = mpsc::channel();
    let board = std::thread::spawn(move || {
        for content in [None, Some("<fdm_config><system file=\"Controls\"/></fdm_config>"), Some("<system/>")] {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            stream.write_all(b"NuttShell (NSH)\n\rnsh> \x1b[K").unwrap();
            let mut command = String::new();
            reader.read_line(&mut command).unwrap();
            assert!(command.starts_with("cat /romfs/jsbsim/aircraft/voliro_t/"), "{command}");
            if let Some(content) = content {
                write!(stream, "\x1b[K{content}\n\rnsh> \x1b[K").unwrap();
            } else {
                // Deliberately omit the reply until the caller cancels.
                command_seen.send(()).unwrap();
            }
            command.clear();
            reader.read_line(&mut command).unwrap();
            assert_eq!(command, "exit\n", "cancellation must close NSH cleanly");
        }
    });
    let control = requests.begin("reading").unwrap();
    let reading = std::thread::spawn(move || remote_model::load("voliro_t", |path| ftp_sync::download_path_with_control(path, &control)));
    command_ready.recv_timeout(Duration::from_secs(3)).unwrap();
    let started = Instant::now();
    requests.cancel("reading").unwrap();
    assert!(reading.join().unwrap().err().unwrap().contains("已取消"));
    assert!(started.elapsed() < Duration::from_secs(2));
    requests.finish("reading");

    let control = requests.begin("retry").unwrap();
    let (xml, refs) = remote_model::load("voliro_t", |path| ftp_sync::download_path_with_control(path, &control)).unwrap();
    assert!(xml.contains("<fdm_config>"));
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].path, "aircraft/voliro_t/Controls.xml");
    requests.finish("retry");
    board.join().unwrap();
    for key in ["NSH_TELNET_PORT", "SIM_UDP_HOST", "NUTTX_FTP_URL"] { std::env::remove_var(key); }
}
