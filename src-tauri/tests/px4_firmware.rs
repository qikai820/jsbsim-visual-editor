#![allow(dead_code)]
async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| e.to_string())?
}
mod scene_telemetry {
    pub fn snapshots() -> Vec<serde_json::Value> {
        vec![]
    }
}
mod romfs_network {
    pub struct Session;
    impl Session {
        pub fn command(&mut self, _: &str) -> Result<String, String> {
            Err("offline".into())
        }
    }
    pub fn with_host_session<T>(
        _: std::net::Ipv4Addr,
        f: impl FnOnce(&mut Session) -> Result<T, String>,
    ) -> Result<T, String> {
        f(&mut Session)
    }
}
mod flight_test {
    pub fn connection_snapshot() -> serde_json::Value {
        serde_json::json!({})
    }
    pub fn running() -> bool {
        false
    }
    pub mod receiver {
        pub fn clear_idle() {}
        pub fn busy() -> bool {
            false
        }
        pub fn gate() -> Result<std::sync::MutexGuard<'static, ()>, String> {
            static GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
            GATE.lock().map_err(|e| e.to_string())
        }
    }
}
mod transport {
    pub fn network_host() -> Option<std::net::Ipv4Addr> {
        None
    }
}
mod sim_files {
    pub fn source() -> &'static str {
        "offline"
    }
    pub fn managed_volume(_: &str) -> Result<(), String> {
        Err("offline test does not access the simulator".into())
    }
    pub fn read_limited(_: &str, _: usize) -> Result<Vec<u8>, String> {
        Err("offline test does not access the simulator".into())
    }
}
#[path = "../src/px4_firmware/mod.rs"]
mod px4_firmware;
