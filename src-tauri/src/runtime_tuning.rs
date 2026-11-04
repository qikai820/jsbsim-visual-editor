//! State-preserving tuning protocol. ACKs come from the FDM thread, never from send success.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[derive(Clone, Deserialize, Serialize)]
pub struct Edit { pub key: String, pub value: f64 }
#[derive(Clone)]
struct Snapshot { frame: Value, seen: Instant }
fn snapshots() -> &'static Mutex<HashMap<u8, Snapshot>> {
    static STATE: OnceLock<Mutex<HashMap<u8, Snapshot>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn ingest(frame: &Value) {
    if frame["monitor"]["tuning"]["version"].as_u64() != Some(1) { return; }
    let id = frame["instance_id"].as_str().and_then(|s| s.parse::<u8>().ok())
        .or_else(|| frame["instance_id"].as_u64().and_then(|n| u8::try_from(n).ok())).unwrap_or(1);
    if !(1..=32).contains(&id) { return; }
    let compact = json!({"model":frame["model"],"state":frame["state"],"timestamp":frame["timestamp"],"tuning":frame["monitor"]["tuning"]});
    if let Ok(mut state) = snapshots().lock() { state.insert(id, Snapshot { frame: compact, seen: Instant::now() }); }
}
pub fn snapshot(id: u8) -> Option<Value> {
    let state = snapshots().lock().ok()?;
    let entry = state.get(&id)?;
    let mut frame = entry.frame.clone();
    frame["age_ms"] = json!(entry.seen.elapsed().as_millis().min(u128::from(u32::MAX)));
    Some(frame)
}
pub fn packet(instance: u8, request: u32, session: &str, edits: &[Edit]) -> Result<Vec<u8>, String> {
    if !(1..=32).contains(&instance) || request == 0 || edits.is_empty() || edits.len() > 12 { return Err("实时调参一次需包含 1～12 个参数".into()); }
    if session.len() != 16 { return Err("实时调参会话无效".into()); }
    let generation = u64::from_str_radix(session, 16).ok().filter(|n| *n != 0).ok_or("实时调参会话无效")?;
    let mut out = b"VPAR".to_vec(); out.extend([instance, edits.len() as u8, 0, 0]);
    out.extend(request.to_le_bytes()); out.extend(generation.to_le_bytes());
    let mut keys = std::collections::HashSet::new();
    for edit in edits {
        let key = &edit.key;
        if key.is_empty() || key.len() > 100 || key.contains("..") || key.bytes().any(|b| !(33..=126).contains(&b) || b == b'"' || b == b'\\')
            || !edit.value.is_finite() || !keys.insert(key) { return Err("实时调参路径、数值无效或重复".into()); }
        out.push(key.len() as u8); out.extend(key.as_bytes()); out.extend(edit.value.to_le_bytes());
    }
    if out.len() > 1200 { return Err("实时调参报文过长".into()); }
    Ok(out)
}
pub fn apply(instance: u8, session: &str, model: &str, edits: &[Edit], send: impl Fn(&[u8]) -> Result<(), String>) -> Result<Value, String> {
    let before = snapshot(instance).ok_or("运行端尚未提供实时调参能力，请更新运行端并启动模型")?;
    if before["age_ms"].as_u64().unwrap_or(u64::MAX) > 3000 || !matches!(before["state"].as_str(), Some("running" | "paused")) {
        return Err("模型未运行或通信已断开；修改保留在编辑器，未实时应用".into());
    }
    if before["tuning"]["session"].as_str() != Some(session) || before["model"].as_str() != Some(model) {
        return Err("模型或运行会话已改变，请重新提交参数".into());
    }
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let request = (SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u32)
        .wrapping_add(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)).max(1);
    let bytes = packet(instance, request, session, edits)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut next_send = Instant::now();
    while Instant::now() < deadline {
        if Instant::now() >= next_send { send(&bytes)?; next_send = Instant::now() + Duration::from_millis(350); }
        if let Some(frame) = snapshot(instance) {
            if frame["tuning"]["session"].as_str() != Some(session) { return Err("运行会话已改变，未继续应用参数".into()); }
            if frame["tuning"]["request"].as_u64() == Some(u64::from(request)) {
                if frame["tuning"]["status"] != "applied" {
                    return Err(format!("运行端拒绝参数：{}", frame["tuning"]["status"].as_str().unwrap_or("unknown")));
                }
                let values = frame["tuning"]["values"].as_array().ok_or("运行端未返回参数实际值")?;
                if values.len() != edits.len() || values.iter().zip(edits).any(|(actual, edit)| actual.as_f64().is_none_or(|v| (v-edit.value).abs() > 1e-8 * edit.value.abs().max(1.0))) {
                    return Err("运行端已处理，但实际值与提交值不一致，请检查参数范围".into());
                }
                return Ok(frame);
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("实时应用确认超时；当前值未确认，修改仍保留，保存后可重新加载模型".into())
}
