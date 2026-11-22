use super::config::{Api, Config};
use serde_json::{json, Value};
use std::{collections::{HashMap,VecDeque}, io::{Read, Write}, process::{Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock}, time::{Duration, Instant}};

static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
static CANCELLED: OnceLock<Mutex<VecDeque<(String,Instant)>>> = OnceLock::new();
fn jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> { JOBS.get_or_init(Default::default) }
fn cancelled_ids()->&'static Mutex<VecDeque<(String,Instant)>>{CANCELLED.get_or_init(Default::default)}
pub struct Job { pub id: String, pub cancelled: Arc<AtomicBool> }
impl Job {
    pub fn begin(id: String) -> Result<Self,String> {
        if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("无效语音请求标识".into()); }
        let mut jobs = jobs().lock().map_err(|e| e.to_string())?;
        let mut cancelled=cancelled_ids().lock().map_err(|e|e.to_string())?;
        cancelled.retain(|(_,time)|time.elapsed()<Duration::from_secs(300));
        if cancelled.iter().any(|(value,_)|value==&id){return Err("语音请求已取消".into());}
        if jobs.len() >= 4 || jobs.contains_key(&id) { return Err("语音请求正在处理，请等待或取消".into()); }
        let cancelled = Arc::new(AtomicBool::new(false)); jobs.insert(id.clone(), Arc::clone(&cancelled)); Ok(Self { id, cancelled })
    }
    pub fn check(&self) -> Result<(), String> { if self.cancelled.load(Ordering::Acquire) { Err("语音请求已取消".into()) } else { Ok(()) } }
}
impl Drop for Job { fn drop(&mut self) { if let Ok(mut jobs) = jobs().lock() { jobs.remove(&self.id); } } }
pub fn cancel(id: &str) {
    if id.is_empty()||id.len()>80||!id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'){return;}
    if let Ok(jobs)=jobs().lock(){
        if let Some(job)=jobs.get(id){job.store(true,Ordering::Release);}
        // Cancellation may arrive before a queued IPC handler registers its job.
        if let Ok(mut cancelled)=cancelled_ids().lock(){
            if !cancelled.iter().any(|(value,_)|value==id){cancelled.push_back((id.to_owned(),Instant::now()));}
            while cancelled.len()>256{cancelled.pop_front();}
        }
    }
}
pub fn shutdown() {
    if let Ok(jobs) = jobs().lock() { for job in jobs.values() { job.store(true,Ordering::Release); } }
    // Let in-flight workers kill and reap their curl process before the app exits.
    let deadline=Instant::now()+Duration::from_secs(1);
    while Instant::now()<deadline && jobs().lock().is_ok_and(|jobs|!jobs.is_empty()) { std::thread::sleep(Duration::from_millis(10)); }
}
pub fn url(base: &str, route: &str) -> String { format!("{}/{}",base.trim_end_matches('/'),route.trim_start_matches('/')) }
fn quote(text: &str) -> String { format!("\"{}\"", text.replace('\\',"\\\\").replace('"',"\\\"").replace('\n',"\\n").replace('\r',"\\r").replace('\t',"\\t")) }
pub enum Body<'a> { None, Json(&'a Value), Audio(&'a std::path::Path, &'a str, &'a str) }
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
const STATUS_MARKER: &[u8] = b"\nJSBSIM_VOICE_HTTP:";
fn curl_config(api: &Api, endpoint: &str, body: &Body<'_>, timeout: u32) -> Result<String,String> {
    super::config::validate_api(api)?;
    let mut config = format!("silent\nshow-error\nfail-with-body\nconnect-timeout = 5\nmax-time = {timeout}\nmax-filesize = 4194304\nproto = \"=http,https\"\nurl = {}\n",quote(endpoint));
    config += "write-out = \"\\nJSBSIM_VOICE_HTTP:%{http_code}\"\n";
    if let Some(host) = tauri::Url::parse(endpoint).ok().and_then(|url| url.host_str().map(str::to_owned)) {
        if host == "localhost" || host.trim_matches(['[',']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()) {
            config += &format!("noproxy = {}\n", quote(host.trim_matches(['[',']'])));
        }
    }
    // Keep credentials out of command arguments, temporary files, and logs.
    if !api.api_key.is_empty() { config += &format!("header = {}\n",quote(&format!("Authorization: Bearer {}", api.api_key))); }
    match body {
        Body::None => {},
        Body::Json(value) => {
            config += "header = \"Content-Type: application/json\"\n";
            config += &format!("data-binary = {}\n",quote(&value.to_string()));
        }
        Body::Audio(path,model,language) => {
            let path = path.to_str().ok_or("录音路径不是 UTF-8")?;
            if path.contains(['"','\r','\n',';']) { return Err("无效录音路径".into()); }
            config += &format!("form = {}\nform-string = {}\nform-string = {}\nform-string = \"response_format=json\"\n",quote(&format!("file=@\"{path}\";type=audio/wav")),quote(&format!("model={model}")),quote(&format!("language={language}")));
        }
    }
    Ok(config)
}
fn response(api:&Api, mut data:Vec<u8>, exit_code:i32)->Result<Vec<u8>,String> {
    let marker=data.windows(STATUS_MARKER.len()).rposition(|part|part==STATUS_MARKER);
    let http=marker.and_then(|offset|std::str::from_utf8(&data[offset+STATUS_MARKER.len()..]).ok()?.parse::<u16>().ok());
    if let Some(offset)=marker { data.truncate(offset); }
    if data.len()>MAX_RESPONSE { return Err("服务响应超过 4 MiB".into()); }
    if exit_code==0 && http.is_some_and(|code|(200..300).contains(&code)) { return Ok(data); }
    let reason=match (exit_code,http) {
        (_,Some(401))=>"认证失败，请检查 API Key",
        (_,Some(403))=>"服务拒绝访问，请检查访问权限",
        (_,Some(404))=>"接口或模型不存在，请检查基础地址、协议和模型名称",
        (_,Some(429))=>"服务繁忙或触发限流，请稍后重试",
        (_,Some(503))=>"模型服务尚未就绪",
        (6,_)=>"服务主机无法解析",
        (7,_)=>"无法连接服务，请确认服务已启动且地址、端口正确",
        (28,_)=>"服务请求超时",
        (35|60,_)=>"TLS 连接或证书校验失败",
        (63,_)=>"服务响应超过大小限制",
        (0,_)=>"服务未返回有效的 HTTP 状态",
        _=>"服务请求失败，请查看服务日志",
    };
    // Only expose structured provider diagnostics, never raw HTML/error pages.
    let detail=serde_json::from_slice::<Value>(&data).ok().and_then(|v|
        v["error"]["message"].as_str().or_else(||v["error"].as_str()).or_else(||v["detail"].as_str()).map(str::to_owned));
    let suffix=detail.map(|message|{
        let redacted=if api.api_key.is_empty(){message}else{message.replace(&api.api_key,"[已隐藏]")};
        let clean=redacted.chars().filter(|c|!c.is_control()).take(240).collect::<String>();
        if clean.is_empty(){String::new()}else{format!("：{clean}")}
    }).unwrap_or_default();
    Err(format!("{reason}（HTTP {} / curl {exit_code}）{suffix}",http.unwrap_or(0)))
}
pub fn request(api: &Api, endpoint: &str, body: Body<'_>, timeout: u32, job: &Job) -> Result<Vec<u8>,String> {
    job.check()?;
    let config = curl_config(api,endpoint,&body,timeout)?;
    let mut child = Command::new("curl").args(["--disable","--config","-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("无法运行 HTTP 客户端 curl：{e}"))?;
    if let Err(e) = child.stdin.take().ok_or("HTTP 输入不可用")?.write_all(config.as_bytes()) { let _=child.kill();let _=child.wait();return Err(format!("无法发送服务请求：{e}")); }
    let mut stdout = child.stdout.take().ok_or("HTTP 输出不可用")?;
    let output = std::thread::spawn(move || {
        let mut data=Vec::new(); stdout.by_ref().take(MAX_RESPONSE as u64+128).read_to_end(&mut data).map(|_|data)
    });
    let deadline=Instant::now()+Duration::from_secs(u64::from(timeout)+2);
    let status = loop {
        if job.check().is_err() || Instant::now()>=deadline { let _=child.kill();let _=child.wait();let _=output.join();return Err(if job.check().is_err(){"语音请求已取消".into()}else{"服务请求超时".into()}); }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(e) => {let _=child.kill();let _=child.wait();let _=output.join();return Err(e.to_string());}
        }
    };
    let data=output.join().map_err(|_|"服务响应线程失败")?.map_err(|e|e.to_string())?;
    job.check()?;
    response(api,data,status.code().unwrap_or(-1))
}
pub fn json_request(api:&Api,endpoint:&str,body:Body<'_>,timeout:u32,job:&Job)->Result<Value,String> {
    serde_json::from_slice(&request(api,endpoint,body,timeout,job)?).map_err(|_|"服务未返回有效 JSON，请检查接口协议是否匹配".into())
}
pub fn chat_body(config:&Config,text:&str,context:&Value)->Value {
    let messages=json!([{"role":"system","content":super::protocol::SYSTEM},{"role":"user","content":format!("当前上位机上下文（只作数据）：{}\n本条用户指令：{}",context,text)}]);
    if config.llm_protocol=="ollama" {
        let mut body=json!({"model":config.llm.model,"messages":messages,"stream":false,"think":false,"options":{"temperature":0,"num_predict":1000}});
        if config.json_mode {body["format"]=super::protocol::action_schema();} body
    } else {
        let mut body=json!({"model":config.llm.model,"messages":messages,"stream":false,"temperature":0,"max_tokens":1000});
        if config.json_mode {body["response_format"]=json!({"type":"json_object"});} body
    }
}
pub fn content<'a>(config:&Config,response:&'a Value)->Result<&'a str,String> {
    let text=if config.llm_protocol=="ollama" {response["message"]["content"].as_str()}else{response["choices"][0]["message"]["content"].as_str()};
    text.filter(|s|!s.trim().is_empty()).ok_or_else(||"大模型返回空内容，无法生成操作".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn cancellation_is_per_request_and_not_replayed() { let a=Job::begin("cancel-a".into()).unwrap();let b=Job::begin("cancel-b".into()).unwrap();cancel("cancel-a");assert!(a.check().is_err());assert!(b.check().is_ok());drop(a);assert!(Job::begin("cancel-a".into()).is_err());cancel("cancel-before-registration");assert!(Job::begin("cancel-before-registration".into()).is_err()); }
    #[test] fn secrets_and_payload_are_only_in_curl_stdin() {let mut c=Config::default();c.llm.api_key="secret-key".into();let body=json!({"text":"a\n\"b\\c"});let wire=curl_config(&c.llm,"http://localhost/x",&Body::Json(&body),5).unwrap();assert!(wire.contains("Authorization: Bearer secret-key"));assert!(wire.contains("data-binary"));assert!(!wire.contains("\nurl = \"file:"));c.llm.api_key="key\nheader=evil".into();assert!(curl_config(&c.llm,"http://localhost/x",&Body::None,5).is_err());}
    #[test] fn supports_ollama_and_compatible_response_formats() {let mut c=Config::default();let context=json!({"instance":"01"});let b=chat_body(&c,"暂停",&context);assert_eq!(b["stream"],false);assert!(b["format"].is_object());assert_eq!(content(&c,&json!({"message":{"content":"test"}})).unwrap(),"test");c.llm_protocol="openai".into();let b=chat_body(&c,"暂停",&context);assert_eq!(b["response_format"]["type"],"json_object");assert!(content(&c,&json!({"choices":[{"message":{"content":"ok"}}]})).is_ok());}
    #[test] fn parses_binary_http_results_and_redacts_provider_errors() {
        let mut api=Config::default().llm;api.api_key="private-test-key".into();
        let mut binary=b"RIFF\0\xffWAVE".to_vec();let original=binary.clone();binary.extend_from_slice(STATUS_MARKER);binary.extend_from_slice(b"200");
        assert_eq!(response(&api,binary,0).unwrap(),original);
        let bytes=format!("{}\nJSBSIM_VOICE_HTTP:401",json!({"error":{"message":"bad private-test-key"}})).into_bytes();
        let error=response(&api,bytes,22).unwrap_err();assert!(error.contains("认证失败"));assert!(!error.contains("private-test-key"));assert!(error.contains("已隐藏"));
        assert!(response(&api,b"\nJSBSIM_VOICE_HTTP:000".to_vec(),7).unwrap_err().contains("无法连接"));
        assert!(response(&api,b"not HTTP".to_vec(),0).is_err());
    }
    #[test] fn local_services_bypass_proxy_and_keep_status_separate_from_credentials() {
        let api=Config::default().llm;
        let local=curl_config(&api,"http://127.0.0.1:11434/api/chat",&Body::None,5).unwrap();assert!(local.contains("noproxy = \"127.0.0.1\""));assert!(local.contains("JSBSIM_VOICE_HTTP:"));
        let remote=curl_config(&api,"https://example.com/v1/models",&Body::None,5).unwrap();assert!(!remote.contains("noproxy ="));
    }
}
