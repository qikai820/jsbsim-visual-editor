use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Mutex};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Api { pub base_url: String, pub api_key: String, pub model: String }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Config {
    pub enabled: bool, pub llm_protocol: String, pub llm: Api, pub json_mode: bool,
    pub asr_protocol: String, pub asr: Api, pub language: String,
    pub recorder: String, pub input_device: String, pub max_record_seconds: u32,
    pub speak_replies: bool, pub tts: Api, pub tts_voice: String, pub timeout_seconds: u32,
}
impl Default for Config {
    fn default() -> Self { Self {
        enabled: false, llm_protocol: "ollama".into(),
        llm: Api { base_url: "http://127.0.0.1:11434".into(), api_key: String::new(), model: "qwen3:4b".into() }, json_mode: true,
        asr_protocol: "openai".into(), asr: Api { base_url: "http://127.0.0.1:8178/v1".into(), api_key: String::new(), model: "small".into() },
        language: "zh".into(), recorder: "auto".into(), input_device: String::new(), max_record_seconds: 30,
        speak_replies: false, tts: Api { base_url: "http://127.0.0.1:8179/v1".into(), api_key: String::new(), model: "tts-1".into() },
        tts_voice: "default".into(), timeout_seconds: 90,
    } }
}
pub fn validate_api(api: &Api) -> Result<(), String> {
    let url = tauri::Url::parse(&api.base_url).map_err(|_| "服务地址需要完整的 http:// 或 https:// URL")?;
    if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("服务地址仅支持 HTTP/HTTPS，不接受 URL 内的账号、查询参数或片段".into());
    }
    if api.base_url.len() > 2048 || api.api_key.len() > 4096 || api.model.len() > 200 || [&api.base_url, &api.api_key, &api.model].iter().any(|s| s.chars().any(char::is_control)) { return Err("服务配置包含过长字段或控制字符".into()); }
    Ok(())
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if !["ollama", "openai"].contains(&self.llm_protocol.as_str()) || !["openai", "whispercpp"].contains(&self.asr_protocol.as_str()) || !["auto", "pw-record", "arecord"].contains(&self.recorder.as_str()) { return Err("未知语音或大模型协议".into()); }
        validate_api(&self.llm)?; validate_api(&self.asr)?;
        if self.speak_replies { validate_api(&self.tts)?; if self.tts.model.trim().is_empty() || self.tts_voice.trim().is_empty() { return Err("启用播报后需要填写语音合成模型与音色".into()); } }
        if self.llm.model.trim().is_empty() || self.asr.model.trim().is_empty() || self.tts_voice.len() > 100 || self.tts_voice.chars().any(char::is_control) { return Err("请填写模型名称，音色名称不能包含控制字符".into()); }
        if !(5..=60).contains(&self.max_record_seconds) || !(5..=180).contains(&self.timeout_seconds) { return Err("录音上限为 5～60 秒，请求超时为 5～180 秒".into()); }
        if self.input_device.len() > 200 || self.input_device.starts_with('-') || self.input_device.chars().any(char::is_control) || self.language.is_empty() || self.language.len() > 12 || !self.language.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-') { return Err("录音设备或语言配置无效".into()); }
        Ok(())
    }
    pub fn require_enabled(&self) -> Result<(), String> { self.validate()?; if self.enabled { Ok(()) } else { Err("请先在语音配置中启用大模型语音操作并保存".into()) } }
}
static LOCK: Mutex<()> = Mutex::new(());
pub fn load(path: &Path) -> Result<Config, String> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|e| format!("语音配置读取失败：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(e.to_string()),
    }
}
pub fn save(path: &Path, config: &Config) -> Result<(), String> {
    use std::io::Write;
    config.validate()?;
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    fs::create_dir_all(path.parent().ok_or("无效配置路径")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new(); options.write(true).create(true).truncate(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?; }
    file.write_all(&serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}
