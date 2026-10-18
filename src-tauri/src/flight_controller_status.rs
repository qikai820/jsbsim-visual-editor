use serde_json::Value;
use std::time::Duration;

// Board status arrives at 1 Hz. Keep the most recent report through a small
// transport gap, while marking an old report unknown instead of online.
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);

pub fn snapshot(packet: Option<&Value>, age: Option<Duration>) -> Option<Value> {
    let mut status = packet?.clone();
    let age = age?;
    let stale = age >= STATUS_TIMEOUT;
    if let Some(fields) = status.as_object_mut() {
        fields.insert("status_stale".into(), Value::Bool(stale));
        fields.insert("status_age_ms".into(), Value::from(age.as_millis().min(u64::MAX as u128) as u64));
        if stale {
            fields.insert("heartbeat_alive".into(), Value::Bool(false));
        }
    }
    Some(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_gap_retains_status_then_marks_it_stale() {
        let packet = serde_json::json!({
            "kind":"flight_controller", "usb_connected":true,
            "heartbeat_alive":true, "heartbeat_count":405,
            "armed":false, "custom_mode":131072
        });
        let during_gap = snapshot(Some(&packet), Some(Duration::from_millis(3200))).unwrap();
        assert_eq!(during_gap["heartbeat_alive"], true);
        assert_eq!(during_gap["heartbeat_count"], 405);
        assert_eq!(during_gap["status_stale"], false);
        let stale = snapshot(Some(&packet), Some(Duration::from_secs(5))).unwrap();
        assert_eq!(stale["heartbeat_alive"], false);
        assert_eq!(stale["status_stale"], true);
        assert_eq!(stale["heartbeat_count"], 405);
        assert!(snapshot(None, Some(Duration::ZERO)).is_none());
    }
}
