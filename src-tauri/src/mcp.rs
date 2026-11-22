//! Local authenticated bridge to the running desktop. MCP itself uses stdio
//! (tools/upper-mcp/server.py); this private TCP protocol never owns a HIL port.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

const MAX_REQUEST: usize = 8 * 1024 * 1024;
const BUILTIN: &str =
    include_str!("../../examples/flight-tests/morphquad-attitude/10_four_mode_complete.xml");
static NEXT: AtomicU64 = AtomicU64::new(1);
static SERVICE: OnceLock<Service> = OnceLock::new();
struct Service {
    endpoint: PathBuf,
    token: String,
    pending: Mutex<BTreeMap<u64, Pending>>,
    audit: Mutex<Vec<Value>>,
}
struct Pending {
    request: Value,
    expires: Instant,
    claimed: bool,
    reply: oneshot::Sender<Result<Value, String>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    token: String,
    name: String,
    #[serde(default = "empty")]
    arguments: Value,
}
fn empty() -> Value {
    json!({})
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    enabled: bool,
    endpoint_file: Option<String>,
    audit: Vec<Value>,
}

#[tauri::command]
pub fn mcp_bridge_status() -> BridgeStatus {
    BridgeStatus {
        enabled: SERVICE.get().is_some(),
        endpoint_file: SERVICE
            .get()
            .map(|s| s.endpoint.to_string_lossy().into_owned()),
        audit: SERVICE
            .get()
            .and_then(|s| s.audit.lock().ok().map(|a| a.clone()))
            .unwrap_or_default(),
    }
}
// Claim before execution: an undelivered or expired UI event cannot start a
// test later after the caller has already received a timeout.
#[tauri::command]
pub fn mcp_claim_request(id: u64) -> Result<Value, String> {
    let s = SERVICE.get().ok_or("MCP bridge not running")?;
    let mut pending = s.pending.lock().map_err(|e| e.to_string())?;
    let p = pending.get_mut(&id).ok_or("MCP request expired")?;
    if p.claimed || Instant::now() >= p.expires {
        return Err("MCP request expired or already claimed".into());
    }
    p.claimed = true;
    Ok(p.request.clone())
}
#[tauri::command]
pub fn mcp_complete_request(
    id: u64,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let s = SERVICE.get().ok_or("MCP bridge not running")?;
    let mut pending = s.pending.lock().map_err(|e| e.to_string())?;
    if !pending.get(&id).is_some_and(|p| p.claimed) {
        return Err("MCP request not claimed".into());
    }
    if let Some(p) = pending.remove(&id) {
        let _ = p.reply.send(match error {
            Some(e) => Err(e),
            None => Ok(result.unwrap_or(Value::Null)),
        });
    }
    Ok(())
}
fn audit(name: &str, ok: bool) {
    if let Some(s) = SERVICE.get() {
        if let Ok(mut a) = s.audit.lock() {
            a.push(json!({"tool":name,"ok":ok,"unixMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()}));
            if a.len() > 32 {
                a.remove(0);
            }
        }
    }
}
async fn ui_request(app: &tauri::AppHandle, name: &str, arguments: Value) -> Result<Value, String> {
    let s = SERVICE.get().ok_or("MCP bridge not running")?;
    let (tx, mut rx) = oneshot::channel();
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    {
        let mut pending = s.pending.lock().map_err(|e| e.to_string())?;
        if !pending.is_empty() {
            return Err("另一个 MCP 控制请求正在处理；状态查询仍可用".into());
        }
        pending.insert(
            id,
            Pending {
                request: json!({"name":name,"arguments":arguments}),
                expires: Instant::now() + Duration::from_secs(5),
                claimed: false,
                reply: tx,
            },
        );
    }
    if let Err(e) = app.emit("upper-mcp-request", json!({"id":id})) {
        s.pending.lock().map_err(|e| e.to_string())?.remove(&id);
        return Err(e.to_string());
    }
    // Stop may wait for landing. It uses the same runner and exit policy as UI.
    let early = tokio::time::timeout(Duration::from_secs(5), &mut rx).await;
    let result = match early {
        Ok(value) => Ok(value),
        Err(_) => {
            let claimed = s
                .pending
                .lock()
                .map_err(|e| e.to_string())?
                .get(&id)
                .is_some_and(|p| p.claimed);
            if !claimed {
                s.pending.lock().map_err(|e| e.to_string())?.remove(&id);
                return Err("上位机界面未接收请求；未执行控制操作，请打开工具箱后重试".into());
            }
            tokio::time::timeout(Duration::from_secs(145), rx).await
        }
    };
    s.pending.lock().map_err(|e| e.to_string())?.remove(&id);
    match result {
        Ok(Ok(r)) => r,
        _ => Err("上位机未及时完成请求，请先查询当前状态；不要盲目重试控制操作".into()),
    }
}
fn arguments(value: &Value, allowed: &[&str]) -> Result<(), String> {
    let a = value.as_object().ok_or("arguments must be an object")?;
    if a.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("Unknown tool argument".into());
    }
    Ok(())
}
async fn dispatch(app: tauri::AppHandle, name: &str, args: Value) -> Result<Value, String> {
    match name {
        "upper_get_status" => {
            arguments(&args, &[])?;
            Ok(
                json!({"connection":crate::flight_test::connection_snapshot(),"test":crate::flight_test::status(),
                "scene":crate::scene_telemetry::snapshots(),"bridge":mcp_bridge_status()}),
            )
        }
        "upper_list_scripts" => {
            arguments(&args, &[])?;
            Ok(
                json!({"scripts":[{"id":"morphquad_complete","name":"MorphQuad 完整测试","source":"current desktop build"}]}),
            )
        }
        "upper_get_script" => {
            arguments(&args, &["script"])?;
            if args["script"] != "morphquad_complete" {
                return Err("Unknown script".into());
            }
            Ok(json!({"script":"morphquad_complete","source":BUILTIN}))
        }
        "upper_validate_script" => {
            arguments(&args, &["source", "script"])?;
            let source = script_source(&args)?;
            crate::flight_test::flight_test_validate(source).await
        }
        "upper_start_test" => {
            arguments(&args, &["source", "script", "dryRun"])?;
            let source = script_source(&args)?;
            let dry = args["dryRun"]
                .as_bool()
                .ok_or("dryRun must be explicitly true or false")?;
            ui_request(&app, name, json!({"source":source,"dryRun":dry})).await
        }
        "upper_stop_test" => {
            arguments(&args, &["id"])?;
            let id = args["id"]
                .as_u64()
                .filter(|v| *v > 0)
                .ok_or("A current positive test id is required")?;
            ui_request(&app, name, json!({"id":id})).await
        }
        "upper_get_report" => {
            arguments(&args, &["offset", "limit"])?;
            let offset = args
                .get("offset")
                .map(|v| v.as_u64().ok_or("Invalid offset"))
                .transpose()?
                .unwrap_or(0);
            let limit = args
                .get("limit")
                .map(|v| v.as_u64().ok_or("Invalid limit"))
                .transpose()?
                .unwrap_or(0);
            if limit > 1000 {
                return Err("limit must be at most 1000".into());
            }
            crate::run_blocking(move || {
                let mut report = crate::flight_test::flight_test_report()?;
                let trace = report["trace"].as_array().cloned().unwrap_or_default();
                report["traceTotal"] = json!(trace.len());
                report["traceOffset"] = json!(offset);
                report["trace"] = json!(trace
                    .into_iter()
                    .skip(offset as usize)
                    .take(limit as usize)
                    .collect::<Vec<_>>());
                report.as_object_mut().unwrap().remove("sourceXml");
                Ok(report)
            })
            .await
        }
        "upper_save_report" => {
            arguments(&args, &[])?;
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("test-reports");
            crate::run_blocking(move || {
                let report = crate::flight_test::flight_test_report()?;
                if report["result"]["id"].as_u64().unwrap_or(0) == 0 {
                    return Err("还没有测试记录".into());
                }
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let path = dir.join(format!(
                    "test-{}-{}.json",
                    report["result"]["startedAtUnixMs"], report["result"]["id"]
                ));
                let temp =
                    path.with_extension(format!("{}.tmp", NEXT.fetch_add(1, Ordering::Relaxed)));
                std::fs::write(
                    &temp,
                    serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
                Ok(json!({"path":path,"result":report["result"]}))
            })
            .await
        }
        _ => Err("Unknown tool".into()),
    }
}
fn script_source(args: &Value) -> Result<String, String> {
    match (args.get("source"), args.get("script")) {
        (Some(Value::String(s)), None) if !s.is_empty() => Ok(s.clone()),
        (None, Some(Value::String(s))) if s == "morphquad_complete" => Ok(BUILTIN.into()),
        _ => Err("Provide exactly one nonempty source or script=morphquad_complete".into()),
    }
}
async fn connection(stream: tokio::net::TcpStream, app: tauri::AppHandle) {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    // Bound input before allocation: read_until alone would permit unlimited lines.
    use tokio::io::AsyncReadExt;
    let read = tokio::time::timeout(
        Duration::from_secs(5),
        (&mut reader)
            .take(MAX_REQUEST as u64 + 1)
            .read_until(b'\n', &mut bytes),
    )
    .await;
    let reply = match read {
        Ok(Ok(_)) if bytes.len() <= MAX_REQUEST && bytes.ends_with(b"\n") => {
            match serde_json::from_slice::<Request>(&bytes) {
                Ok(request) if SERVICE.get().is_some_and(|s| s.token == request.token) => {
                    let result = dispatch(app, &request.name, request.arguments).await;
                    audit(&request.name, result.is_ok());
                    match result {
                        Ok(value) => json!({"ok":true,"result":value}),
                        Err(error) => json!({"ok":false,"error":error}),
                    }
                }
                _ => json!({"ok":false,"error":"Unauthorized or malformed bridge request"}),
            }
        }
        _ => json!({"ok":false,"error":"Bridge request too large, incomplete or timed out"}),
    };
    if let Ok(mut data) = serde_json::to_vec(&reply) {
        data.push(b'\n');
        let _ = writer.write_all(&data).await;
    }
}
pub fn start(app: tauri::AppHandle) -> Result<(), String> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let endpoint = dir.join("mcp-endpoint.json");
    let metadata = json!({"host":"127.0.0.1","port":listener.local_addr().map_err(|e|e.to_string())?.port(),"token":token,"pid":std::process::id(),"version":1});
    let temporary = dir.join(format!("mcp-endpoint-{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
    file.write_all(
        serde_json::to_string(&metadata)
            .map_err(|e| e.to_string())?
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &endpoint).map_err(|e| e.to_string())?;
    SERVICE
        .set(Service {
            endpoint,
            token,
            pending: Mutex::new(BTreeMap::new()),
            audit: Mutex::new(Vec::new()),
        })
        .map_err(|_| "MCP already started")?;
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            return;
        };
        let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        while let Ok((stream, peer)) = listener.accept().await {
            if !peer.ip().is_loopback() {
                continue;
            }
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                connection(stream, app).await;
                drop(permit);
            });
        }
    });
    Ok(())
}
pub fn shutdown() {
    if let Some(s) = SERVICE.get() {
        if let Ok(source) = std::fs::read(&s.endpoint) {
            if serde_json::from_slice::<Value>(&source)
                .ok()
                .is_some_and(|v| v["token"] == s.token)
            {
                let _ = std::fs::remove_file(&s.endpoint);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_is_explicit_and_allowlisted() {
        assert!(script_source(&json!({})).is_err());
        assert!(script_source(&json!({"script":"morphquad_complete","source":"x"})).is_err());
        assert!(script_source(&json!({"script":"../../etc/passwd"})).is_err());
        assert!(crate::flight_test::xml::parse(
            &script_source(&json!({"script":"morphquad_complete"})).unwrap()
        )
        .is_ok());
    }
    #[test]
    fn unknown_arguments_and_oversized_page_rejected() {
        assert!(arguments(&json!({"port":14553}), &[]).is_err());
        assert!(arguments(&Value::Null, &[]).is_err());
    }
}
