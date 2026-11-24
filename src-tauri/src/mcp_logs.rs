//! Small asynchronous-transfer receipt shared by both webviews and MCP.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Transfer {
    pub job_id:u64, pub log_id:u16, pub size:u64, pub time:u32,
    pub session_id:u64, pub system:u8, pub component:u8, pub hardware_uid:String,
    pub started_at_unix_ms:u64, pub updated_at_unix_ms:u64,
    pub elapsed_seconds:f64, pub bytes_per_second:f64, pub remaining_seconds:Option<f64>,
    pub status:String, pub received:u64, pub saved_bytes:u64, pub path:Option<String>, pub error:Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all="camelCase")]
pub struct DownloadRequest {pub id:u16,pub expected_size:u64,pub expected_time:u32}
pub fn validate(args:Value)->Result<DownloadRequest,String>{
    let r:DownloadRequest=serde_json::from_value(args).map_err(|e|e.to_string())?;
    if r.id==65535 || !(16..=512*1024*1024).contains(&r.expected_size){return Err("Invalid log identity or size".into());}
    Ok(r)
}
fn state()->&'static Mutex<Option<Transfer>>{static STATE:OnceLock<Mutex<Option<Transfer>>>=OnceLock::new();STATE.get_or_init(||Mutex::new(None))}
pub fn now()->u64{std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
pub fn status()->Option<Transfer>{state().lock().ok().and_then(|v|v.clone()).map(|mut v|{let end=if v.status=="downloading"{now()}else{v.updated_at_unix_ms};v.elapsed_seconds=end.saturating_sub(v.started_at_unix_ms) as f64/1000.;v.bytes_per_second=if v.elapsed_seconds>0.{v.received as f64/v.elapsed_seconds}else{0.};v.remaining_seconds=if v.status=="downloading"&&v.bytes_per_second>0.{Some((v.size-v.received) as f64/v.bytes_per_second)}else{None};v})}
pub fn active()->bool{status().is_some_and(|v|v.status=="downloading")}
pub fn start(value:Transfer)->Result<(),String>{let mut s=state().lock().map_err(|e|e.to_string())?;if s.as_ref().is_some_and(|v|v.status=="downloading"){return Err("已有 MCP 日志下载正在进行".into());}*s=Some(value);Ok(())}
pub fn progress(id:u64,received:u64){if let Ok(mut s)=state().lock(){if let Some(s)=s.as_mut().filter(|s|s.job_id==id&&s.status=="downloading"){s.received=s.received.max(received.min(s.size));s.updated_at_unix_ms=now();}}}
pub fn saved(id:u64,bytes:u64){progress(id,bytes);if let Ok(mut s)=state().lock(){if let Some(s)=s.as_mut().filter(|s|s.job_id==id&&s.status=="downloading"){s.saved_bytes=s.saved_bytes.max(bytes.min(s.size));}}}
pub fn complete(id:u64,path:String){if let Ok(mut s)=state().lock(){if let Some(s)=s.as_mut().filter(|s|s.job_id==id&&s.status=="downloading"){s.received=s.size;s.saved_bytes=s.size;s.updated_at_unix_ms=now();s.path=Some(path);s.status="completed".into();}}}
pub fn fail(id:u64,error:String,cancelled:bool){if let Ok(mut s)=state().lock(){if let Some(s)=s.as_mut().filter(|s|s.job_id==id&&s.status=="downloading"){s.updated_at_unix_ms=now();s.status=if cancelled{"cancelled"}else{"failed"}.into();s.error=Some(error.chars().take(1024).collect());}}}
#[cfg(test)]mod tests{use super::*;use serde_json::json;
#[test]fn identity_is_bounded(){assert!(validate(json!({"id":0,"expectedSize":24,"expectedTime":0})).is_ok());for a in [json!({"id":65535,"expectedSize":24,"expectedTime":0}),json!({"id":0,"expectedSize":15,"expectedTime":0}),json!({"id":0,"expectedSize":24,"expectedTime":0,"path":"/tmp/x"}),json!({"id":false,"expectedSize":24,"expectedTime":0})]{assert!(validate(a).is_err());}}
}
