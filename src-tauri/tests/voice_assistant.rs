#![allow(dead_code)]
async fn run_blocking<T,F>(operation:F)->Result<T,String>
where T:Send+'static,F:FnOnce()->Result<T,String>+Send+'static {
    tauri::async_runtime::spawn_blocking(operation).await.map_err(|e|e.to_string())?
}
#[path="../src/voice/mod.rs"] mod voice;
use voice::{config,protocol};
use serde_json::json;

#[test]
fn accepts_only_supported_actions_and_explicit_test_mode(){
    for content in [
        r#"{"reply":"待确认","actions":[{"type":"start_script","script":"F450_PX4_lan.xml","model":"F450_PX4"}]}"#,
        r#"```json
{"reply":"暂停","actions":[{"type":"pause"}]}
```"#,
        r#"{"reply":"预演","actions":[{"type":"start_test","dryRun":true}]}"#,
    ]{assert!(protocol::parse_decision(content).is_ok(),"{content}");}
    for action in [
        json!({"type":"shell","command":"rm -rf /"}),json!({"type":"pause","command":"extra"}),
        json!({"type":"start_model","model":"../escape"}),json!({"type":"start_model","model":"foo;evil"}),
        json!({"type":"start_test"}),json!({"type":"start_test","dryRun":"false"}),
        json!({"type":"start_script","model":"F450_PX4","script":"F450_PX4"}),
    ]{assert!(protocol::parse_decision(&json!({"reply":"test","actions":[action]}).to_string()).is_err());}
    assert!(protocol::parse_decision(&json!({"reply":"too many","actions":vec![json!({"type":"stop"});5]}).to_string()).is_err());
    assert!(protocol::parse_decision("already done").is_err());
    assert!(protocol::parse_decision(r#"{"reply":"ok","actions":[],"code":"do something"}"#).is_err());
}

#[test]
fn settings_are_private_atomic_and_disabled_by_default(){
    let dir=std::env::temp_dir().join(format!("voice-settings-test-{}",std::process::id()));let path=dir.join("voice.json");
    let mut value=config::load(&path).unwrap();assert!(!value.enabled);assert!(value.require_enabled().is_err());
    value.llm.api_key="test-secret".into();config::save(&path,&value).unwrap();
    assert_eq!(config::load(&path).unwrap().llm.api_key,"test-secret");
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode()&0o777,0o600);}
    value.llm.base_url="file:///etc/passwd".into();assert!(config::save(&path,&value).is_err());
    assert_eq!(config::load(&path).unwrap().llm.base_url,"http://127.0.0.1:11434");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn rejects_unsafe_endpoints_recorders_and_credentials(){
    for url in ["file:///tmp/x","ftp://localhost/x","http://user:password@localhost","http://localhost/x?token=secret","http://localhost/#fragment"]{
        let mut value=config::Config::default();value.llm.base_url=url.into();assert!(value.validate().is_err(),"{url}");
    }
    let mut value=config::Config::default();value.input_device="--evil-option".into();assert!(value.validate().is_err());
    value=config::Config::default();value.asr.api_key="key\nheader: injected".into();assert!(value.validate().is_err());
    value=config::Config::default();value.max_record_seconds=3600;assert!(value.validate().is_err());
}
