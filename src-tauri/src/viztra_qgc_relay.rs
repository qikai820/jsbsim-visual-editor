//! Translate the simulator's Viztra JSON output into the 64-byte target frame
//! accepted by the 3DG QGroundControl UDP receiver.
//!
//! The three-value JSON stream is sent to this desktop on UDP 9873. The
//! aircraft position comes from the simulator's fresh visual telemetry on
//! UDP 5801. QGC listens on UDP 9872.

use serde_json::Value;
use std::f64::consts::PI;
use std::net::{SocketAddr, UdpSocket};
use std::time::Instant;

const LISTEN_PORT: u16 = 9873;
const QGC_DESTINATION: &str = "192.168.3.109:9872";
const EARTH_RADIUS_M: f64 = 6_371_000.0;
const FRAME_SIZE: usize = 64;

#[derive(Clone, Copy)]
struct TargetSample {
    latitude_rad: f64,
    longitude_rad: f64,
    received_at: Instant,
}

fn number(packet: &Value, property: &str) -> Option<f64> {
    let wire_name = property.replace('-', "_");
    packet
        .get(&wire_name)
        .or_else(|| packet.get(property))
        .or_else(|| wire_name.strip_prefix("px4/").and_then(|name| packet.get(name)))
        .or_else(|| property.strip_prefix("px4/").and_then(|name| packet.get(name)))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn target_frame(
    packet: &[u8],
    telemetry: &Value,
    sequence: u8,
    previous: Option<TargetSample>,
    received_at: Instant,
) -> Option<([u8; FRAME_SIZE], TargetSample)> {
    let packet: Value = serde_json::from_slice(packet).ok()?;
    let north = number(&packet, "px4/viztra/relative-n-m")?;
    let east = number(&packet, "px4/viztra/relative-e-m")?;
    let down = number(&packet, "px4/viztra/relative-d-m")?;
    if telemetry.get("state").and_then(Value::as_str) != Some("running") {
        return None;
    }
    let vehicle_lat = number(telemetry, "latitude_deg")?.to_radians();
    let vehicle_lon = number(telemetry, "longitude_deg")?.to_radians();
    let vehicle_alt = number(telemetry, "altitude_m")?;
    if vehicle_lat.abs() > PI / 2.0 || vehicle_lon.abs() > PI
        || vehicle_lat.cos().abs() < 1e-6
        || north.abs() > 200_000.0 || east.abs() > 200_000.0
    {
        return None;
    }

    let latitude_rad = vehicle_lat + north / EARTH_RADIUS_M;
    let longitude_rad = vehicle_lon + east / (EARTH_RADIUS_M * vehicle_lat.cos());
    let latitude_deg = latitude_rad.to_degrees();
    let longitude_deg = longitude_rad.to_degrees();
    let altitude_msl = vehicle_alt - down;
    if !(-90.0..=90.0).contains(&latitude_deg)
        || !(-180.0..=180.0).contains(&longitude_deg)
        || !(0.0..=6553.5).contains(&altitude_msl)
    {
        return None;
    }

    let mut ground_speed = 0.0_f64;
    let mut heading = 0.0_f64;
    if let Some(last) = previous {
        let dt = received_at.duration_since(last.received_at).as_secs_f64();
        if (0.1..=2.0).contains(&dt) {
            let delta_n = (latitude_rad - last.latitude_rad) * EARTH_RADIUS_M;
            let delta_e = (longitude_rad - last.longitude_rad)
                * EARTH_RADIUS_M * vehicle_lat.cos();
            let distance = delta_n.hypot(delta_e);
            ground_speed = distance / dt;
            if distance > 0.1 {
                heading = delta_e.atan2(delta_n).to_degrees().rem_euclid(360.0);
            }
        }
    }
    if !ground_speed.is_finite() || ground_speed > 100.0 {
        return None;
    }

    let mut frame = [0_u8; FRAME_SIZE];
    frame[0..3].copy_from_slice(&[0xeb, 0x90, FRAME_SIZE as u8]);
    frame[3] = sequence;
    frame[4] = 0x30;
    frame[5..9].copy_from_slice(&((longitude_deg * 1e6).round() as i32).to_le_bytes());
    frame[9..13].copy_from_slice(&((latitude_deg * 1e6).round() as i32).to_le_bytes());
    frame[13..15].copy_from_slice(&((altitude_msl * 10.0).round() as u16).to_le_bytes());
    frame[15..17].copy_from_slice(&((ground_speed * 10.0).round() as u16).to_le_bytes());
    frame[17..19].copy_from_slice(&(((heading * 10.0).round() as u16) % 3600).to_le_bytes());
    frame[21..23].copy_from_slice(&1_u16.to_le_bytes());
    frame[62..64].copy_from_slice(&[0x90, 0xeb]);

    Some((frame, TargetSample { latitude_rad, longitude_rad, received_at }))
}

pub fn start<F>(telemetry: F) -> std::io::Result<()>
where
    F: Fn() -> Option<Value> + Send + 'static,
{
    let receive = UdpSocket::bind(("0.0.0.0", LISTEN_PORT))?;
    let send = UdpSocket::bind("0.0.0.0:0")?;
    let destination: SocketAddr = QGC_DESTINATION.parse().expect("constant QGC address");
    std::thread::Builder::new()
        .name("viztra-qgc-relay".into())
        .spawn(move || {
            let mut buf = [0_u8; 2048];
            let mut sequence = 0_u8;
            let mut last: Option<(SocketAddr, TargetSample)> = None;
            let mut received = 0_u32;
            let mut forwarded = 0_u32;
            let mut last_report = Instant::now();
            loop {
                match receive.recv_from(&mut buf) {
                    Ok((length, sender)) => {
                        received += 1;
                        let previous = last.filter(|(address, _)| *address == sender)
                            .map(|(_, sample)| sample);
                        let vehicle = telemetry();
                        if let Some((frame, sample)) = vehicle.as_ref().and_then(|vehicle|
                            target_frame(&buf[..length], vehicle, sequence, previous, Instant::now()))
                        {
                            if send.send_to(&frame, destination).is_ok() {
                                sequence = sequence.wrapping_add(1);
                                last = Some((sender, sample));
                                forwarded += 1;
                            }
                        }
                        if last_report.elapsed() >= std::time::Duration::from_secs(5) {
                            eprintln!("[Viztra QGC relay] 5s packets: received={received}, forwarded={forwarded}, fresh_vehicle={}", vehicle.is_some());
                            received = 0;
                            forwarded = 0;
                            last_report = Instant::now();
                        }
                    }
                    Err(error) => eprintln!("[Viztra QGC relay] UDP receive failed: {error}"),
                }
            }
        })?;
    eprintln!("[Viztra QGC relay] listening on UDP {LISTEN_PORT}, forwarding to {destination}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn converts_vehicle_relative_json_to_qgc_frame() {
        let start = Instant::now();
        let first = br#"{"viztra/relative_n_m":150.0,"viztra/relative_e_m":0.0,
            "viztra/relative_d_m":-997.9}"#;
        let telemetry = serde_json::json!({
            "state": "running", "latitude_deg": 33.915993032882,
            "longitude_deg": 108.97786790927702, "altitude_m": 586.0
        });
        let (frame, sample) = target_frame(first, &telemetry, 7, None, start).unwrap();
        assert_eq!(frame.len(), 64);
        assert_eq!(&frame[..5], &[0xeb, 0x90, 64, 7, 0x30]);
        assert_eq!(&frame[62..], &[0x90, 0xeb]);
        let altitude = u16::from_le_bytes(frame[13..15].try_into().unwrap());
        assert_eq!(altitude, 15839);
        let latitude = i32::from_le_bytes(frame[9..13].try_into().unwrap());
        assert!((latitude - 33_917_342).abs() <= 2);

        let moved = String::from_utf8(first.to_vec()).unwrap().replace("150.0", "160.0");
        let (frame, _) = target_frame(moved.as_bytes(), &telemetry, 8, Some(sample),
            start + Duration::from_secs(1)).unwrap();
        assert_eq!(u16::from_le_bytes(frame[15..17].try_into().unwrap()), 100);
    }

    #[test]
    fn rejects_current_three_field_json_without_fresh_vehicle_position() {
        let packet = br#"{"viztra/relative_n_m":150,
            "viztra/relative_e_m":0,"viztra/relative_d_m":-998}"#;
        assert!(target_frame(packet, &serde_json::json!({"state":"running"}),
            0, None, Instant::now()).is_none());
    }
}
