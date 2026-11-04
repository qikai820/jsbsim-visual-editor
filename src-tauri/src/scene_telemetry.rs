//! Small, coherent visual snapshots, independent of the rotating property tree.
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const FIELDS: &[&str] = &[
    "instance_id", "model", "state", "tree_generation", "timestamp", "t",
    "capture_monotonic_us", "latitude_deg", "longitude_deg", "altitude_m",
    "roll_deg", "pitch_deg", "yaw_deg", "groundspeed_mps", "vertical_speed_mps",
    "airspeed_mps", "pos", "att", "vel", "latitude_kind",
];

#[derive(Default)]
pub struct SceneTelemetry { entries: HashMap<u8, Entry> }
struct Entry {
    frame: Value,
    received: Instant,
    properties: HashMap<String, PropertySample>,
    retired: VecDeque<(Value, Value)>,
    sequence: u64,
    monitor_sequence: Option<u64>,
    epoch: u64,
    restart_candidate: Option<RestartCandidate>,
}
struct RestartCandidate { identity: (Value, Value), capture: f64, time: f64, received: Instant }
struct PropertySample { value: Value, seen: Instant, sample_time: f64, source: &'static str }

fn numeric(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(f64::is_finite)
}
fn complete_pose(frame: &Value) -> bool {
    let flat = ["latitude_deg", "longitude_deg", "altitude_m", "roll_deg", "pitch_deg", "yaw_deg"]
        .iter().all(|key| numeric(frame.get(*key)));
    let compact = ["pos", "att"].iter().all(|key| frame.get(*key).and_then(Value::as_array)
        .is_some_and(|values| values.len() == 3 && values.iter().all(|v| numeric(Some(v)))));
    (flat || compact) && numeric(frame.get("timestamp").or_else(|| frame.get("t")))
}
fn visual_property(path: &str, id: u8) -> Option<String> {
    let normalized = path.replace("[0]", "");
    let mut path = normalized.trim_start_matches('/');
    if let Some((first, remainder)) = path.split_once('/') {
        if let Ok(owner) = first.parse::<u8>() {
            if owner != id { return None; }
            path = remainder;
        }
    }
    path = path.strip_prefix("jsbsim/").unwrap_or(path);
    let path = format!("/{path}");
    let selected =
    ["/position/h-agl-ft", "/position/terrain-elevation-asl-ft", "/fcs/voliro_t/pitch-rad"]
        .contains(&path.as_str())
        || (0..5).any(|i| {
            let index = if i == 0 { String::new() } else { format!("[{i}]") };
            path == format!("/fcs/esc-out{index}") || path == format!("/fcs/voliro_t/thrust-lbf{index}")
        });
    selected.then_some(path)
}
fn identity(frame: &Value) -> (Value, Value) {
    (frame["model"].clone(), frame["tree_generation"].clone())
}
fn frame_time(frame: &Value) -> Option<f64> {
    frame.get("timestamp").or_else(|| frame.get("t")).and_then(Value::as_f64).filter(|v| v.is_finite())
}
fn insert_sample(entry: &mut Entry, path: String, value: &Value, time: f64, source: &'static str, now: Instant) {
    if !numeric(Some(value)) { return; }
    if entry.properties.get(&path).is_some_and(|old| old.sample_time > time
        || (old.sample_time == time && old.source == "monitor" && source == "tree")) { return; }
    entry.properties.insert(path, PropertySample { value: value.clone(), seen: now, sample_time: time, source });
}
fn ingest_monitor(entry: &mut Entry, packet: &Value, id: u8, now: Instant) {
    let monitor = &packet["monitor"];
    if monitor["version"].as_u64() != Some(1) { return; }
    let Some(sequence) = monitor["sequence"].as_u64() else { return; };
    if entry.monitor_sequence.is_some_and(|old| sequence <= old) { return; }
    let Some(samples) = monitor["samples"].as_object() else { return; };
    entry.monitor_sequence = Some(sequence);
    for (key, tuple) in samples {
        let Some(path) = visual_property(key, id) else { continue; };
        let Some(values) = tuple.as_array().filter(|v| v.len() >= 3) else { continue; };
        let Some(time) = values[1].as_f64().filter(|v| v.is_finite()) else { continue; };
        insert_sample(entry, path, &values[0], time, "monitor", now);
    }
}

impl SceneTelemetry {
    pub fn ingest(&mut self, packet: &Value) {
        let id = match packet.get("instance_id") {
            None => 1,
            Some(value) => match value.as_str().and_then(|v| v.parse::<u8>().ok())
                .or_else(|| value.as_u64().and_then(|v| u8::try_from(v).ok())) {
                Some(id) => id,
                None => return,
            },
        };
        if !(1..=32).contains(&id) || packet["model"].as_str().is_none() { return; }
        let now = Instant::now();
        if !complete_pose(packet) {
            // Lifecycle-only frames may stop the display, but cannot freshen a pose.
            if let Some(entry) = self.entries.get_mut(&id) {
                if identity(&entry.frame) == identity(packet) {
                    ingest_monitor(entry, packet, id, now);
                    if matches!(packet["state"].as_str(), Some("stopped" | "fault")) {
                        entry.frame["state"] = packet["state"].clone();
                    }
                }
            }
            return;
        }
        // A board reboot reuses model/tree_generation while CLOCK_MONOTONIC
        // starts over. After a real gap, require two advancing packets from the
        // lower clock before starting another epoch; single delayed packets and
        // repeated snapshots must still be rejected.
        let mut restarted = false;
        if let Some(entry) = self.entries.get_mut(&id) {
            if let (Some(old), Some(new), Some(time)) = (entry.frame["capture_monotonic_us"].as_f64(),
                packet["capture_monotonic_us"].as_f64(), frame_time(packet)) {
                if new < old && now.duration_since(entry.received) >= Duration::from_secs(2) {
                    restarted = entry.restart_candidate.as_ref().is_some_and(|candidate|
                        candidate.identity == identity(packet) && new > candidate.capture && time >= candidate.time
                            && now.duration_since(candidate.received) <= Duration::from_secs(1));
                    if !restarted {
                        entry.restart_candidate = Some(RestartCandidate { identity: identity(packet), capture: new, time, received: now });
                        return;
                    }
                } else { entry.restart_candidate = None; }
            }
        }
        let changed = self.entries.get(&id).is_some_and(|entry| identity(&entry.frame) != identity(packet));
        let rewound = self.entries.get(&id).is_some_and(|entry| matches!((frame_time(&entry.frame), frame_time(packet)),
            (Some(old), Some(new)) if new < old - 1.0));
        if let Some(entry) = self.entries.get(&id) {
            if !restarted && entry.retired.contains(&identity(packet)) { return; }
            if !changed && !restarted {
                let old = entry.frame["capture_monotonic_us"].as_f64();
                let new = packet["capture_monotonic_us"].as_f64();
                if matches!((old, new), (Some(a), Some(b)) if b <= a) { return; }
                if old.is_none() && packet["timestamp"].as_f64().or_else(|| packet["t"].as_f64())
                    < entry.frame["timestamp"].as_f64().or_else(|| entry.frame["t"].as_f64()) { return; }
            }
        }
        let entry = self.entries.entry(id).or_insert_with(|| Entry {
            frame: json!({}), received: now, properties: HashMap::new(), retired: VecDeque::new(), sequence: 0, monitor_sequence: None,
            epoch: 0, restart_candidate: None,
        });
        if restarted {
            entry.epoch = entry.epoch.saturating_add(1);
            entry.retired.clear();
            entry.restart_candidate = None;
        } else if changed {
            entry.retired.push_back(identity(&entry.frame));
            if entry.retired.len() > 8 { entry.retired.pop_front(); }
        }
        if changed || rewound || restarted { entry.properties.clear(); entry.monitor_sequence = None; }
        let mut fields = Map::new();
        for key in FIELDS {
            if let Some(value) = packet.get(*key) { fields.insert((*key).into(), value.clone()); }
        }
        fields.insert("instance_id".into(), json!(format!("{id:02}")));
        entry.frame = Value::Object(fields);
        entry.sequence = entry.sequence.wrapping_add(1);
        entry.received = now;
        if let Some(properties) = packet["properties"].as_object() {
            for (path, value) in properties {
                if let Some(path) = visual_property(path, id) {
                    insert_sample(entry, path, value, frame_time(packet).unwrap_or(0.0), "tree", now);
                }
            }
        }
        ingest_monitor(entry, packet, id, now);
    }
    pub fn snapshots(&self) -> Vec<Value> {
        let mut result: Vec<_> = self.entries.iter().map(|(id, entry)| {
            let mut frame = entry.frame.clone();
            frame["age_ms"] = json!(entry.received.elapsed().as_millis().min(u128::from(u32::MAX)));
            frame["scene_sequence"] = json!(entry.sequence);
            frame["scene_epoch"] = json!(entry.epoch);
            let mut properties = Map::new();
            let mut ages = Map::new();
            let mut sources = Map::new();
            for (path, sample) in &entry.properties {
                properties.insert(path.clone(), sample.value.clone());
                ages.insert(path.clone(), json!(sample.seen.elapsed().as_millis().min(u128::from(u32::MAX))));
                sources.insert(path.clone(), json!(sample.source));
            }
            frame["properties"] = Value::Object(properties);
            frame["scene_property_age_ms"] = Value::Object(ages);
            frame["scene_property_sources"] = Value::Object(sources);
            (*id, frame)
        }).collect();
        result.sort_by_key(|(id, _)| *id);
        result.into_iter().map(|(_, frame)| frame).collect()
    }
}
fn global() -> &'static Mutex<SceneTelemetry> {
    static CACHE: OnceLock<Mutex<SceneTelemetry>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SceneTelemetry::default()))
}
pub fn ingest(packet: &Value) { if let Ok(mut cache) = global().lock() { cache.ingest(packet); } }
pub fn snapshots() -> Vec<Value> { global().lock().map(|cache| cache.snapshots()).unwrap_or_default() }

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(t: f64, generation: u32) -> Value {
        json!({"instance_id":"01", "model":"voliro_t", "state":"running", "timestamp":t,
            "capture_monotonic_us":t*1e6, "tree_generation":generation, "latitude_deg":34.0,
            "longitude_deg":109.0, "altitude_m":600.0, "roll_deg":1.0, "pitch_deg":2.0, "yaw_deg":90.0})
    }
    #[test]
    fn snapshots_keep_coherent_pose_and_only_selected_properties() {
        let mut cache = SceneTelemetry::default();
        let mut packet = frame(1.0, 1);
        packet["properties"] = json!({"/01/jsbsim/fcs[0]/esc-out[0]":0.5,
            "/01/jsbsim/fcs[0]/esc-out[1]":0.6, "/01/jsbsim/unused":99});
        cache.ingest(&packet);
        cache.ingest(&json!({"instance_id":"01","model":"voliro_t","state":"running","timestamp":2.0,"latitude_deg":99.0}));
        let frames = cache.snapshots();
        assert_eq!(frames[0]["timestamp"], 1.0);
        assert_eq!(frames[0]["properties"].as_object().unwrap().len(), 2);
        assert!(frames[0]["scene_property_age_ms"].is_object());
    }
    #[test]
    fn generations_and_instances_are_isolated() {
        let mut cache = SceneTelemetry::default();
        cache.ingest(&frame(1.0, 1));
        let mut other = frame(5.0, 1); other["instance_id"] = json!("02"); cache.ingest(&other);
        cache.ingest(&frame(0.0, 2)); cache.ingest(&frame(2.0, 1));
        let frames = cache.snapshots();
        assert_eq!(frames.len(), 2); assert_eq!(frames[0]["timestamp"], 0.0);
        assert_eq!(frames[1]["timestamp"], 5.0);
    }
    #[test]
    fn auxiliary_and_delayed_packets_cannot_refresh_pose() {
        let mut cache = SceneTelemetry::default(); cache.ingest(&frame(2.0, 1));
        let received = cache.entries[&1].received;
        cache.ingest(&frame(1.0, 1)); cache.ingest(&frame(2.0, 1));
        cache.ingest(&json!({"kind":"signal_samples", "instance_id":"01"}));
        assert_eq!(cache.entries[&1].received, received);
        assert_eq!(cache.snapshots()[0]["timestamp"], 2.0);
    }
    #[test]
    fn real_tree_paths_and_fast_monitor_share_one_property_without_delaying_pose() {
        let mut cache = SceneTelemetry::default();
        let mut pose = frame(1.0, 1);
        pose["properties"] = json!({"/01/jsbsim/fcs[0]/voliro_t[0]/pitch-rad[0]":0.1});
        cache.ingest(&pose);
        let received = cache.entries[&1].received;
        let sample = json!({"kind":"signal_samples","instance_id":"01","model":"voliro_t",
            "tree_generation":1,"timestamp":2.0,"state":"running","monitor":{"version":1,"sequence":1,
                "samples":{"fcs/voliro_t/pitch-rad":[0.8,2.0,false],"fcs/esc-out[0]":[0.4,2.0,false]}}});
        cache.ingest(&sample);
        let snapshot = &cache.snapshots()[0];
        assert_eq!(snapshot["properties"]["/fcs/voliro_t/pitch-rad"],0.8);
        assert_eq!(snapshot["scene_property_sources"]["/fcs/voliro_t/pitch-rad"],"monitor");
        assert_eq!(snapshot["properties"].as_object().unwrap().len(),2);
        assert_eq!(cache.entries[&1].received,received,"monitor-only packets cannot freshen body pose");
        let mut older_tree = frame(1.5,1);
        older_tree["properties"] = pose["properties"].clone();cache.ingest(&older_tree);
        assert_eq!(cache.snapshots()[0]["properties"]["/fcs/voliro_t/pitch-rad"],0.8,
            "a delayed tree slice cannot overwrite newer actual servo sampling");
        let seen = cache.entries[&1].properties["/fcs/voliro_t/pitch-rad"].seen;
        cache.ingest(&sample);
        assert_eq!(cache.entries[&1].properties["/fcs/voliro_t/pitch-rad"].seen,seen);
    }
    #[test]
    fn slow_properties_keep_value_and_age_while_generations_still_clear_them() {
        let mut cache = SceneTelemetry::default();let mut pose=frame(1.0,1);
        pose["properties"]=json!({"/01/jsbsim/fcs[0]/esc-out[0]":0.0,
            "/02/jsbsim/fcs[0]/esc-out[1]":0.99});cache.ingest(&pose);
        cache.entries.get_mut(&1).unwrap().properties.get_mut("/fcs/esc-out").unwrap().seen -= std::time::Duration::from_secs(3);
        let frames=cache.snapshots();
        assert_eq!(frames[0]["properties"]["/fcs/esc-out"],0.0);
        assert!(frames[0]["scene_property_age_ms"]["/fcs/esc-out"].as_u64().unwrap()>=3000);
        assert_eq!(frames[0]["properties"].as_object().unwrap().len(),1);
        cache.ingest(&frame(0.0,2));assert_eq!(cache.snapshots()[0]["properties"],json!({}));
    }
    #[test]
    fn reboot_reusing_generation_recovers_after_two_advancing_clock_samples() {
        let mut cache = SceneTelemetry::default();
        let mut old = frame(600.0, 1); old["capture_monotonic_us"] = json!(1400_000_000u64);
        old["properties"] = json!({"/fcs/esc-out":0.9}); cache.ingest(&old);
        cache.entries.get_mut(&1).unwrap().received -= Duration::from_secs(3);
        let mut boot = frame(0.1, 1); boot["capture_monotonic_us"] = json!(500_000_000u64);
        cache.ingest(&boot);
        assert_eq!(cache.snapshots()[0]["timestamp"],600.0,"one delayed packet is insufficient");
        cache.ingest(&boot);
        assert_eq!(cache.snapshots()[0]["timestamp"],600.0,"duplicates do not confirm a restart");
        boot["timestamp"] = json!(0.14); boot["capture_monotonic_us"] = json!(500_040_000u64);
        boot["monitor"] = json!({"version":1,"sequence":1,"samples":{"fcs/esc-out":[0.3,0.14,false]}});
        cache.ingest(&boot);
        let snapshot = &cache.snapshots()[0];
        assert_eq!(snapshot["timestamp"],0.14); assert_eq!(snapshot["scene_epoch"],1);
        assert_eq!(snapshot["properties"]["/fcs/esc-out"],0.3);
        assert!(snapshot["age_ms"].as_u64().unwrap()<100);
    }
    #[test]
    fn reboot_can_reuse_a_retired_tree_generation_without_affecting_other_instances() {
        let mut cache = SceneTelemetry::default(); cache.ingest(&frame(10.0,1));cache.ingest(&frame(20.0,2));
        let mut other=frame(40.0,1);other["instance_id"]=json!("02");cache.ingest(&other);
        cache.entries.get_mut(&1).unwrap().received-=Duration::from_secs(3);
        cache.ingest(&frame(0.1,1));cache.ingest(&frame(0.14,1));
        let snapshots=cache.snapshots();
        assert_eq!(snapshots[0]["scene_epoch"],1);assert_eq!(snapshots[0]["timestamp"],0.14);
        assert_eq!(snapshots[1]["scene_epoch"],0);assert_eq!(snapshots[1]["timestamp"],40.0);
    }
}
