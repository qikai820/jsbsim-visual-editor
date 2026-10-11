//! Backward-compatible LOAD correlation and board diagnostic decoding.
use serde_json::Value;
use std::sync::atomic::{AtomicU32, Ordering};

pub fn request_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_micros() as u32).unwrap_or(1).max(1);
    let _ = NEXT.compare_exchange(0, seed, Ordering::Relaxed, Ordering::Relaxed);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

pub fn packet(command: u8, payload: &str, id: u32) -> std::io::Result<Vec<u8>> {
    if payload.is_empty() || payload.as_bytes().contains(&0) || payload.len() + 12 > 160 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "模型/脚本名称过长或包含无效字符"));
    }
    let mut bytes = b"VCMD".to_vec();
    bytes.push(command);
    bytes.extend_from_slice(payload.as_bytes());
    bytes.extend_from_slice(b"\0XD");
    bytes.extend_from_slice(&id.to_le_bytes());
    Ok(bytes)
}

pub fn outcome(value: &Value, request: u32, model: &str) -> Option<Result<(), String>> {
    if value.get("request_id").and_then(Value::as_u64) != Some(request as u64)
        || (!model.is_empty() && value.get("model").and_then(Value::as_str) != Some(model)) { return None; }
    match value.get("load_state").and_then(Value::as_str) {
        Some("ready") => Some(Ok(())),
        Some("failed") => {
            let model = value.get("model").and_then(Value::as_str).unwrap_or(model);
            let message = value.get("message").and_then(Value::as_str).filter(|s| !s.is_empty())
                .unwrap_or("模型加载失败，仿真机未返回具体原因。");
            let mut error = format!("仿真机 XML 加载失败：{model}\n\n{message}");
            if value.get("truncated").and_then(Value::as_bool) == Some(true) {
                error.push_str("\n\n诊断较长，完整内容请查看串口或启动日志。");
            }
            if let Some(log) = value.get("log").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                error.push_str(&format!("\n启动日志：{log}"));
            }
            Some(Err(error))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn legacy_payload_and_request_suffix() {
        let bytes = packet(8, "test.xml|ball", 0x12345678).unwrap();
        assert_eq!(&bytes[..5], b"VCMD\x08");
        assert_eq!(bytes[5..].split(|b| *b == 0).next().unwrap(), b"test.xml|ball");
        assert!(bytes.ends_with(b"\0XD\x78\x56\x34\x12"));
        assert!(packet(5, &"a".repeat(149), 1).is_err());
    }
    #[test]
    fn stale_wrong_model_and_loading_do_not_complete_request() {
        let mut value = json!({"request_id":42,"model":"ball","load_state":"failed",
            "message":"engine.xml:7:3:\n7 | <value>bad</value>\n    ^\ninvalid number",
            "log":"/mnt/sdcard/LOG/start.log","truncated":true});
        assert!(outcome(&value, 41, "ball").is_none());
        assert!(outcome(&value, 42, "other").is_none());
        let error = outcome(&value, 42, "ball").unwrap().unwrap_err();
        assert!(error.contains("engine.xml:7:3:"));
        assert!(error.contains("/mnt/sdcard/LOG/start.log"));
        assert!(error.contains("完整内容"));
        value["load_state"] = json!("loading");
        assert!(outcome(&value, 42, "ball").is_none());
        value["load_state"] = json!("ready");
        assert!(outcome(&value, 42, "ball").unwrap().is_ok());
    }
}
