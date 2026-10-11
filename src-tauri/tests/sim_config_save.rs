#![allow(dead_code)]

#[path = "../src/usb_file.rs"] mod usb_file;
#[path = "../src/transport.rs"] mod transport;
#[path = "../src/ftp_sync.rs"] mod ftp_sync;

#[test]
#[ignore = "requires the real board; creates and removes a unique temporary config"]
fn live_config_save_during_usb_telemetry() {
    use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
    use std::time::{Duration, Instant};

    // A running editor in another process can own the interface briefly.
    // Retry only a failed claim, before any request or write was sent.
    fn with_interface<T>(mut operation: impl FnMut() -> Result<T, String>) -> Result<T, String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match operation() {
                Err(error) if error.starts_with("cannot claim USB interface") &&
                    error.contains("Resource busy") && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                },
                result => return result,
            }
        }
    }

    transport::set_mode("usb").unwrap();
    // The probe is a new model name, so it cannot change the loaded model.
    let name = format!("save_probe_{}.json", std::process::id());
    let path = format!("config/models/{name}");
    let usb_path = format!("jsbsim/{path}");
    assert!(!with_interface(|| usb_file::list("jsbsim/config/models")).unwrap().iter().any(|entry| entry.name == name));

    let stop = Arc::new(AtomicBool::new(false));
    let packets = Arc::new(AtomicUsize::new(0));
    let receiver_stop = Arc::clone(&stop);
    let receiver_packets = Arc::clone(&packets);
    let receiver = std::thread::spawn(move || {
        while !receiver_stop.load(Ordering::Relaxed) {
            match usb_file::sim_read() {
                Ok(Some(_)) => { receiver_packets.fetch_add(1, Ordering::Relaxed); },
                _ => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    });
    let result = (|| -> Result<(), String> {
        for rate in [50, 500, 100] {
            let content = serde_json::json!({"version":1,"mcap":{"enabled":true,"rateHz":rate,"bufferMb":500}}).to_string();
            let start = Instant::now();
            with_interface(|| ftp_sync::upload_config(&path, &content))?;
            let actual = with_interface(|| ftp_sync::download_config(&path))?;
            assert_eq!(serde_json::from_str::<serde_json::Value>(&actual).unwrap(), serde_json::from_str::<serde_json::Value>(&content).unwrap());
            println!("USB config save and readback: rate={rate}, elapsed={:?}", start.elapsed());
            assert!(start.elapsed() < Duration::from_secs(30));
            std::thread::sleep(Duration::from_millis(150));
        }
        Ok(())
    })();
    stop.store(true, Ordering::Relaxed);
    receiver.join().unwrap();
    let cleanup = with_interface(|| usb_file::delete(&usb_path));
    println!("Concurrent USB telemetry packets: {}", packets.load(Ordering::Relaxed));
    result.unwrap();
    cleanup.unwrap();
    assert!(!with_interface(|| usb_file::list("jsbsim/config/models")).unwrap().iter().any(|entry| entry.name == name));
    assert!(packets.load(Ordering::Relaxed) > 0, "no concurrent telemetry received");
}
