// Use the production UDP receiver and waiter. Only unrelated hardware/logging
// services are disabled; all LOAD packets and diagnostic JSON use real sockets.
#[path = "../src/sim_client.rs"] mod sim_client;
#[path = "../src/load_diagnostics.rs"] mod load_diagnostics;
mod transport {
    #[derive(PartialEq)] pub enum TransportMode { Network, Usb }
    impl TransportMode { pub fn as_str(&self) -> &'static str { "network" } }
    pub fn mode() -> TransportMode { TransportMode::Network }
    pub fn allows_network() -> bool { true }
    pub fn allows_usb() -> bool { false }
}
mod usb_file {
    pub fn sim_write_control(_: &[u8]) -> Result<(), String> { Err("disabled".into()) }
    pub fn sim_read() -> Result<Option<Vec<u8>>, String> { Ok(None) }
}
mod telemetry_recorder {
    pub struct Recorder;
    impl Recorder { pub fn record(&self, _: &str, _: &serde_json::Value) {} }
    pub fn global() -> Recorder { Recorder }
}
mod plotjuggler { pub fn submit(_: &[u8]) {} }

#[test]
fn correlated_xml_load_over_real_udp() {
    use serde_json::json;
    use std::{net::UdpSocket, time::Duration};
    let board = UdpSocket::bind("127.0.0.1:0").unwrap();
    board.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    std::env::set_var("SIM_UDP_HOST", "127.0.0.1");
    std::env::set_var("SIM_UDP_CTRL_PORT", board.local_addr().unwrap().port().to_string());
    let client = sim_client::SimClient::new(0);
    let id = client.send_load("ball").unwrap();
    let mut buffer = [0; 256];
    let peer = loop {
        let (size, peer) = board.recv_from(&mut buffer).unwrap();
        if buffer[..size].starts_with(b"VCMD\x05") {
            assert!(buffer[..size].ends_with(&id.to_le_bytes()));
            break peer;
        }
    };
    // The fixture is emitted by the actual NuttX diagnostic packet builder.
    let mut failure: serde_json::Value = if let Ok(fixture) = std::env::var("JSBSIM_XML_DIAGNOSTIC_FIXTURE") {
        serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap()
    } else {
        json!({"kind":"xml_diagnostic","model":"ball","load_state":"failed",
            "message":"ball.xml:27:9:\ninvalid number","log":"","truncated":false})
    };
    failure["request_id"] = json!(id);
    board.send_to(failure.to_string().as_bytes(), peer).unwrap();
    let error = client.wait_for_running_model("ball", id, Duration::from_secs(2)).unwrap_err();
    assert!(error.contains("ball.xml:27:9:"), "{error}");
    assert!(client.latest_sim_status().is_none(), "diagnostic replaced lifecycle telemetry");
    let next = client.send_load_script("test.xml", "ball").unwrap();
    assert_ne!(next, id);
    // Retransmitted failure from the previous attempt must be ignored.
    board.send_to(failure.to_string().as_bytes(), peer).unwrap();
    assert!(!client.wait_for_running_model("ball", next, Duration::from_millis(150)).unwrap());
    board.send_to(json!({"kind":"xml_diagnostic","request_id":next,"model":"ball","load_state":"ready"}).to_string().as_bytes(), peer).unwrap();
    assert!(client.wait_for_running_model("ball", next, Duration::from_secs(2)).unwrap());
    let restart = client.send_restart().unwrap();
    failure["request_id"] = json!(restart);
    board.send_to(failure.to_string().as_bytes(), peer).unwrap();
    assert!(client.wait_for_running_model("", restart, Duration::from_secs(2)).unwrap_err().contains("ball.xml:27:9:"));
    // Compatibility fallback remains usable after reconnecting older firmware.
    let legacy = client.send_load("ball").unwrap();
    board.send_to(json!({"kind":"heartbeat","state":"stopped"}).to_string().as_bytes(), peer).unwrap();
    board.send_to(json!({"state":"running","model":"ball"}).to_string().as_bytes(), peer).unwrap();
    assert!(client.wait_for_running_model("ball", legacy, Duration::from_secs(2)).unwrap());
}
