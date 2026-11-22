#![allow(dead_code)]
#[path = "../src/sim_backend.rs"] mod sim_backend;
#[path = "../src/transport.rs"] mod transport;
mod network_discovery {
    pub fn discover(_: Option<std::net::Ipv4Addr>) -> Option<std::net::Ipv4Addr> { panic!("local target must not discover a board") }
}

#[test]
fn local_target_stays_pinned_until_application_exit() {
    use std::net::Ipv4Addr;
    assert!(!sim_backend::active());
    assert!(sim_backend::accepts_telemetry("192.168.3.100:5802".parse().unwrap()));
    transport::set_network_host_override(Ipv4Addr::new(192,168,3,100));
    sim_backend::initialize(true);
    transport::set_mode("usb").unwrap();
    assert_eq!(transport::mode(), transport::TransportMode::Network);
    assert!(!transport::allows_usb());
    assert_eq!(transport::network_host(), Some(Ipv4Addr::LOCALHOST));
    assert!(sim_backend::accepts_telemetry("127.0.0.1:15802".parse().unwrap()));
    assert!(!sim_backend::accepts_telemetry("127.0.0.1:5802".parse().unwrap()));
    assert!(!sim_backend::accepts_telemetry("192.168.3.100:15802".parse().unwrap()));
    sim_backend::initialize(false);
    assert!(sim_backend::active(), "saving preferences cannot change a live session");
}
