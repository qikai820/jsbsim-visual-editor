#![allow(dead_code)]
#[path = "../src/model_read.rs"] mod model_read;

// Exercise the production parser without USB hardware or unrelated XML
// tests that depend on aircraft fixtures outside this repository.
mod usb_file {
    pub fn nsh_execute(_: &str) -> Result<String, String> {
        Err("USB unavailable in parser tests".into())
    }
}

mod transport {
    use std::net::Ipv4Addr;
    #[derive(Clone, Copy, PartialEq)]
    pub enum TransportMode { Auto, Usb, Network }
    pub fn mode() -> TransportMode { TransportMode::Auto }
    pub fn network_host() -> Option<Ipv4Addr> { std::env::var("SIM_NETWORK_TEST_HOST").ok()?.parse().ok() }
    pub fn network_host_override() -> Option<Ipv4Addr> { network_host() }
}

mod romfs_network {
    pub static NSH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
}

#[path = "../src/nsh_tcp.rs"]
mod nsh_tcp;

fn nsh_execute_tcp_at(host: std::net::Ipv4Addr, command: &str) -> Result<String, String> {
    nsh_tcp::execute_at(host, command)
}

#[path = "../src/sim_network.rs"]
mod sim_network;

#[test]
#[ignore = "requires SIM_NETWORK_TEST_HOST; reapplies the existing address, mask and gateway without changing them"]
fn live_auto_network_save_unchanged() {
    let host = std::env::var("SIM_NETWORK_TEST_HOST").expect("set SIM_NETWORK_TEST_HOST");
    let before = sim_network::read().unwrap().into_iter().find(|item| item.address == host)
        .expect("no interface matches the live connection address");
    let actual = sim_network::set(&before.name, &before.address, &before.netmask, &before.gateway).unwrap();
    assert_eq!(actual.transport, "network", "USB is unavailable in this test; auto mode must use Ethernet");
    assert_eq!(actual.interface, before);
    assert_eq!(actual.control_host, None);
    println!("Verified unchanged live network configuration: {}", serde_json::to_string(&actual).unwrap());
}

#[test]
#[ignore = "requires a dual-Ethernet NuttX board at SIM_NETWORK_TEST_HOST; read-only"]
fn live_telnet_interface_list() {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    let host = std::env::var("SIM_NETWORK_TEST_HOST").expect("set SIM_NETWORK_TEST_HOST");
    let address = format!("{host}:23").parse().unwrap();
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).unwrap();
    stream.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
    // Match the desktop's one-shot Telnet path, including its NSH prompt and
    // ANSI readline output, rather than normalizing it in the test client.
    stream.write_all(b"ifconfig\n").unwrap();
    let mut output = Vec::new();
    let mut buffer = [0; 4096];
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && output.len() < 16384 {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => output.extend_from_slice(&buffer[..length]),
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
            Err(error) => panic!("Telnet read failed: {error}"),
        }
    }
    stream.write_all(b"exit\n").unwrap();
    while matches!(stream.read(&mut buffer), Ok(length) if length > 0) {}

    let interfaces = sim_network::parse_ifconfig(&String::from_utf8_lossy(&output));
    println!("{}", serde_json::to_string(&interfaces).unwrap());
    assert!(interfaces.iter().any(|item| item.name == "eth0"));
    assert!(interfaces.iter().any(|item| item.name == "eth1"));
}
