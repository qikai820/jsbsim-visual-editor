use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::time::Instant;

/// Retain every observation packet until the UI drains it. A latest-frame
/// snapshot can miss a property-tree slice when other packets arrive first.
#[derive(Default)]
pub struct ObservationQueue {
    frames: HashMap<u8, VecDeque<(Value, Instant)>>,
}

impl ObservationQueue {
    pub fn push(&mut self, frame: &Value) {
        let dedicated = frame["monitor"]["version"].as_u64() == Some(1);
        let properties = frame["properties"].is_object()
            && frame["model"].is_string() && frame["state"].is_string();
        if !dedicated && !properties { return; }
        if frame["timestamp"].as_f64().filter(|value| value.is_finite()).is_none() { return; }
        let id = match frame.get("instance_id") {
            None => 1,
            Some(Value::String(text)) => match text.parse::<u8>() { Ok(id) => id, Err(_) => return },
            Some(Value::Number(number)) => match number.as_u64().and_then(|id| u8::try_from(id).ok()) { Some(id) => id, None => return },
            _ => return,
        };
        if !(1..=32).contains(&id) { return; }
        let mut compact = serde_json::Map::new();
        for key in ["model", "tree_generation", "timestamp", "state", "display_rate_hz", "monitor"] {
            if let Some(value) = frame.get(key) { compact.insert(key.into(), value.clone()); }
        }
        compact.insert("instance_id".into(), json!(format!("{id:02}")));
        if !dedicated {
            for key in ["properties", "tree_total", "tree_offset", "capture_monotonic_us"] {
                if let Some(value) = frame.get(key) { compact.insert(key.into(), value.clone()); }
            }
        }
        let queue = self.frames.entry(id).or_default();
        if queue.len() >= 256 { queue.pop_front(); }
        queue.push_back((Value::Object(compact), Instant::now()));
    }

    pub fn drain(&mut self, id: u8) -> Vec<Value> {
        let Some(queue) = self.frames.get_mut(&id) else { return Vec::new() };
        queue.drain(..).map(|(mut frame, seen)| {
            frame["age_ms"] = json!(seen.elapsed().as_millis().min(u128::from(u32::MAX)));
            frame
        }).collect()
    }
}

pub fn packets(instance: u8, revision: u32, keys: &[String]) -> Result<Vec<Vec<u8>>, String> {
    if !(1..=32).contains(&instance) || revision == 0 || keys.len() > 32 {
        return Err("监视实例、订阅版本无效或超过 32 个信号".into());
    }
    let mut result = Vec::new();
    for index in 0..keys.len().max(1) {
        let key = keys.get(index).map(String::as_str).unwrap_or("");
        if (!keys.is_empty() && key.is_empty()) || key.len() > 128 || key.contains("..") || key.bytes().any(|c| (c < 32 || c == 127) || c == b'"' || c == b'\\') {
            return Err("监视属性路径无效或过长".into());
        }
        let mut packet = b"VMON".to_vec();
        packet.extend_from_slice(&[instance, keys.len() as u8, index as u8, 0]);
        packet.extend_from_slice(&revision.to_le_bytes());
        packet.extend_from_slice(key.as_bytes());
        result.push(packet);
    }
    Ok(result)
}
