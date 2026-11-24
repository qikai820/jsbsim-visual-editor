mod audio;
pub mod config;
mod http;
pub mod protocol;
use base64::Engine;
use config::Config;
use serde::Serialize;
use serde_json::{json,Value};
use std::{path::PathBuf,time::{SystemTime,UNIX_EPOCH}};
use tauri::Manager;

fn path(app:&tauri::AppHandle)->Result<PathBuf,String>{Ok(app.path().app_config_dir().map_err(|e|e.to_string())?.join("voice-assistant.json"))}
fn load(app:&tauri::AppHandle)->Result<Config,String>{config::load(&path(app)?)}
pub fn shutdown(){http::shutdown();audio::shutdown();}

#[tauri::command]
pub async fn voice_config_get(app:tauri::AppHandle)->Result<Value,String>{super::run_blocking(move||Ok(json!({"config":load(&app)?,"capabilities":audio::capabilities(),"recordingId":audio::current_id()}))).await}
#[tauri::command]
pub async fn voice_config_save(app:tauri::AppHandle,config:Config)->Result<Config,String>{super::run_blocking(move||{config::save(&path(&app)?,&config)?;Ok(config)}).await}
#[tauri::command]
pub async fn voice_record_start(app:tauri::AppHandle)->Result<audio::Started,String>{super::run_blocking(move||audio::start(&load(&app)?)).await}
#[tauri::command]
pub async fn voice_record_cancel(id:u64)->Result<(),String>{super::run_blocking(move||{audio::cancel(id);Ok(())}).await}
#[tauri::command]
pub fn voice_cancel(request_id:String){http::cancel(&request_id);}
#[tauri::command]
pub async fn voice_transcribe(app:tauri::AppHandle,id:u64,request_id:String)->Result<String,String>{
    let job=http::Job::begin(request_id)?;
    super::run_blocking(move||{
        // Take ownership before checking settings: all error paths erase audio.
        let file=audio::finish(id)?;job.check()?;let config=load(&app)?;config.require_enabled()?;
        let endpoint=http::url(&config.asr.base_url,if config.asr_protocol=="whispercpp"{"inference"}else{"audio/transcriptions"});
        let response=http::json_request(&config.asr,&endpoint,http::Body::Audio(&file.path,&config.asr.model,&config.language),config.timeout_seconds,&job)?;
        let text=response["text"].as_str().ok_or("语音服务缺少 text 字段")?.trim();
        if text.is_empty(){return Err(empty_transcription_message(&response));}
        if text.chars().count()>2000{return Err("识别文字过长，请分段操作".into());}
        Ok(text.to_string())
    }).await
}
fn empty_transcription_message(response:&Value)->String {
    let level=response["audio_rms"].as_f64().filter(|value|value.is_finite()&&*value>=0.0&&*value<=32768.0)
        .map(|rms|format!("（录音 RMS {rms:.1}）")).unwrap_or_default();
    let message=match response["empty_reason"].as_str(){
        Some("low_volume")=>"录音音量过低或静音，请在系统声音设置的“输入”中检查麦克风选择、静音和输入音量",
        Some("vad_no_speech")=>"录到声音，但语音检测未找到讲话；请确认输入设备是麦克风而非输出监听，录音开始后连续说一句话",
        Some("asr_empty")=>"录到声音，但模型未转写出文字；请检查输入设备和语音语言，并录制清晰完整的句子",
        _=>"识别服务未返回文字；请检查系统麦克风输入和音量，录音开始后再讲话",
    };
    format!("{message}{level}")
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Plan{pub id:String,pub created_at_ms:u64,pub expires_at_ms:u64,pub reply:String,pub actions:Vec<protocol::Action>}
#[tauri::command]
pub async fn voice_interpret(app:tauri::AppHandle,text:String,context:Value,request_id:String)->Result<Plan,String>{
    let job=http::Job::begin(request_id.clone())?;
    super::run_blocking(move||{
        let config=load(&app)?;config.require_enabled()?;
        if text.trim().is_empty()||text.chars().count()>2000||context.to_string().len()>60_000{return Err("指令为空或上下文过长".into());}
        let decision=interpret_decision(&config,&text,&context,&job)?;
        let now=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_millis()as u64;
        Ok(Plan{id:request_id,created_at_ms:now,expires_at_ms:now+60_000,reply:decision.reply,actions:decision.actions})
    }).await
}
fn interpret_decision(config:&Config,text:&str,context:&Value,job:&http::Job)->Result<protocol::Decision,String>{
    job.check()?;
    if let Some(decision)=protocol::local_cancellation(text){return Ok(decision);}
    let body=http::chat_body(config,text,context);
    let endpoint=http::url(&config.llm.base_url,if config.llm_protocol=="ollama"{"api/chat"}else{"chat/completions"});
    let response=http::json_request(&config.llm,&endpoint,http::Body::Json(&body),config.timeout_seconds,job)?;
    protocol::parse_decision(http::content(config,&response)?)
}
#[tauri::command]
pub async fn voice_probe(config:Config,request_id:String)->Result<Value,String>{
    config.validate()?;let job=http::Job::begin(request_id)?;
    super::run_blocking(move||{
        let llm_endpoint=http::url(&config.llm.base_url,if config.llm_protocol=="ollama"{"api/tags"}else{"models"});
        let llm=http::json_request(&config.llm,&llm_endpoint,http::Body::None,8,&job);
        let asr_base=if config.asr_protocol=="openai"{config.asr.base_url.trim_end_matches('/').strip_suffix("/v1").unwrap_or(&config.asr.base_url)}else{&config.asr.base_url};
        let asr=http::json_request(&config.asr,&http::url(asr_base,"health"),http::Body::None,8,&job);
        Ok(probe_summary(&config,llm,asr))
    }).await
}
fn probe_summary(config:&Config,llm:Result<Value,String>,asr:Result<Value,String>)->Value {
    let all_models=llm.as_ref().ok().and_then(|value|if config.llm_protocol=="ollama"{value["models"].as_array()}else{value["data"].as_array()});
    let names=all_models.map(|items|items.iter().filter_map(|v|v["name"].as_str().or_else(||v["id"].as_str())).collect::<Vec<_>>()).unwrap_or_default();
    let found=names.iter().any(|name|*name==config.llm.model||*name==format!("{}:latest",config.llm.model));
    let llm_message=llm.as_ref().err().cloned().unwrap_or_else(||if found{"所选大模型可用".into()}else{"服务已响应，但所选模型不在列表中".into()});
    let ready=asr.as_ref().is_ok_and(|value|value.is_object()&&value["ready"]!=false&&!matches!(value["status"].as_str(),Some("loading"|"starting"|"error"|"failed")));
    let model_matches=asr.as_ref().ok().and_then(|value|value["model"].as_str()).is_none_or(|name|name==config.asr.model);
    let asr_message=asr.as_ref().err().cloned().unwrap_or_else(||if !ready{"语音模型尚未就绪，请等待服务加载".into()}else if !model_matches{"识别服务已响应，但配置的识别模型与服务模型不一致".into()}else{"语音服务已就绪，识别效果需录音验证".into()});
    json!({"llm":{"ok":llm.is_ok()&&found,"models":names.into_iter().take(100).collect::<Vec<_>>(),"message":llm_message},"asr":{"ok":ready&&model_matches,"message":asr_message}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn empty_transcription_explains_capture_and_vad_separately(){
        assert!(empty_transcription_message(&json!({"empty_reason":"low_volume","audio_rms":0})).contains("静音"));
        assert!(empty_transcription_message(&json!({"empty_reason":"vad_no_speech","audio_rms":500})).contains("语音检测"));
        assert!(empty_transcription_message(&json!({"empty_reason":"asr_empty"})).contains("模型未转写"));
        assert!(!empty_transcription_message(&json!({"empty_reason":"untrusted details","audio_rms":-1})).contains("untrusted"));
    }
    #[test] fn probe_checks_ready_model_and_searches_past_display_limit() {
        let c=Config::default();let mut models=(0..110).map(|n|json!({"name":format!("other-{n}")})).collect::<Vec<_>>();models.push(json!({"name":c.llm.model}));
        let response=probe_summary(&c,Ok(json!({"models":models})),Ok(json!({"ready":false,"model":"small"})));
        assert_eq!(response["llm"]["ok"],true);assert_eq!(response["llm"]["models"].as_array().unwrap().len(),100);assert_eq!(response["asr"]["ok"],false);
        let wrong=probe_summary(&c,Err("no LLM".into()),Ok(json!({"ready":true,"model":"tiny"})));assert_eq!(wrong["asr"]["ok"],false);
    }

    #[test]
    #[ignore = "requires an explicitly selected config path and a live local Piper service"]
    fn configure_and_test_local_tts() {
        let path=PathBuf::from(std::env::var_os("JSBSIM_VOICE_TTS_SETUP_CONFIG").expect("需要明确指定语音配置路径"));
        let mut c=config::load(&path).expect("读取现有语音配置失败；未覆盖配置");
        c.require_enabled().expect("请先完成语音输入配置");
        c.speak_replies=true;
        c.tts=config::Api{base_url:"http://127.0.0.1:8179/v1".into(),api_key:String::new(),model:"piper-zh-cn".into()};
        c.tts_voice="huayan".into();
        c.validate().unwrap();
        let job=http::Job::begin(format!("local-tts-setup-{}",std::process::id())).unwrap();
        let health=http::json_request(&c.tts,"http://127.0.0.1:8179/health",http::Body::None,8,&job).expect("本地 TTS 服务未就绪");
        assert_eq!(health["ready"],true);assert_eq!(health["model"],c.tts.model);assert_eq!(health["voices"],json!([c.tts_voice]));
        let started=std::time::Instant::now();
        let body=json!({"model":c.tts.model,"input":"中文语音播报已启用，可以查询仿真状态。","voice":c.tts_voice,"response_format":"wav"});
        let bytes=http::request(&c.tts,&http::url(&c.tts.base_url,"audio/speech"),http::Body::Json(&body),c.timeout_seconds,&job).expect("中文语音合成失败");
        assert!(bytes.len()>44&&&bytes[..4]==b"RIFF"&&&bytes[8..12]==b"WAVE","TTS 未返回有效 WAV 音频");
        println!("[测试] PASS：原生 HTTP → 本地中文 TTS → WAV（{} 字节，{:.2} 秒）。",bytes.len(),started.elapsed().as_secs_f64());
        if let Some(output)=std::env::var_os("JSBSIM_VOICE_TTS_SETUP_WAV") {
            std::fs::write(output,&bytes).expect("保存播报示例失败");
        }
        config::save(&path,&c).expect("保存播报配置失败");
        let stored=config::load(&path).unwrap();
        assert!(stored.speak_replies&&stored.tts.model=="piper-zh-cn"&&stored.tts_voice=="huayan");
        println!("[配置] 中文播报已启用并保存（权限 0600）：{}",path.display());
    }

    // Explicitly invoked by setup-local-voice.sh in the user's own terminal.
    // Reuses production HTTP, schema, parser, recorder and private config writer.
    #[test]
    #[ignore = "requires explicitly selected config path and live local models; optional microphone"]
    fn configure_and_test_local_services() {
        let path=PathBuf::from(std::env::var_os("JSBSIM_VOICE_SETUP_CONFIG").expect("请通过 scripts/setup-local-voice.sh 调用"));
        let mut c=config::load(&path).expect("读取现有语音配置失败；未覆盖配置");
        c.enabled=true;
        c.llm_protocol="ollama".into();
        c.llm=config::Api{base_url:"http://127.0.0.1:11434".into(),api_key:String::new(),model:std::env::var("JSBSIM_VOICE_SETUP_MODEL").unwrap_or_else(|_|"qwen3:4b".into())};
        c.asr_protocol="openai".into();
        c.asr.base_url="http://127.0.0.1:8178/v1".into();c.asr.model="small".into();
        c.json_mode=true;c.language="zh".into();c.timeout_seconds=180;
        c.validate().expect("配置验证失败");
        let job=http::Job::begin(format!("local-setup-{}",std::process::id())).unwrap();
        let llm=http::json_request(&c.llm,&http::url(&c.llm.base_url,"api/tags"),http::Body::None,8,&job);
        let asr=http::json_request(&c.asr,"http://127.0.0.1:8178/health",http::Body::None,8,&job);
        let summary=probe_summary(&c,llm,asr);
        assert_eq!(summary["llm"]["ok"],true,"大模型检查失败：{}",summary["llm"]["message"]);
        assert_eq!(summary["asr"]["ok"],true,"ASR 检查失败：{}",summary["asr"]["message"]);
        println!("[测试] PASS：small ASR 与 {} 指令模型就绪。",c.llm.model);
        let context=json!({"binding":{"instance":"01","selectedModel":"","busy":false},"simulation":{"connected":false},"models":[],"scripts":[],"test":{"status":"idle"},"catalogErrors":[]});
        let interpret=|text:&str| interpret_decision(&c,text,&context,&job).expect("指令解析失败");
        for (text,expected) in [("查询当前仿真状态","status"),("有哪些模型","list_models"),("取消操作，什么也不要执行","")] {
            let decision=interpret(text);
            let actions=serde_json::to_value(&decision.actions).unwrap();
            if expected.is_empty(){assert!(decision.actions.is_empty(),"取消指令不应产生动作");}
            else{assert_eq!(actions,json!([{"type":expected}]),"指令解析不符合预期：{text}");}
            println!("[测试] PASS：{text} → {actions}（仅解析，未执行）。");
        }
        // Save only after both services and real model responses have passed.
        config::save(&path,&c).expect("无法保存上位机配置");
        let stored=config::load(&path).unwrap();
        assert!(stored.enabled&&stored.llm.model==c.llm.model&&stored.asr.model=="small");
        println!("[配置] 已启用并保存语音配置（权限 0600）：{}",path.display());
        if std::env::var("JSBSIM_VOICE_SETUP_MIC").as_deref()==Ok("1") {
            use std::io::Write;
            print!("[麦克风] 按回车后录音 5 秒，请说“查询当前仿真状态”：");
            std::io::stdout().flush().unwrap();
            let mut line=String::new();assert!(std::io::stdin().read_line(&mut line).unwrap()>0,"未获得录音确认");
            let recording=audio::start(&c).expect("打开麦克风失败；服务配置已保存，可在上位机重试录音");
            struct Cleanup(u64);impl Drop for Cleanup{fn drop(&mut self){audio::cancel(self.0);}}
            let _cleanup=Cleanup(recording.id);
            println!("[麦克风] 正在录音，请讲话……");
            std::thread::sleep(std::time::Duration::from_secs(5));
            let file=audio::finish(recording.id).expect("录音失败");
            let response=http::json_request(&c.asr,&http::url(&c.asr.base_url,"audio/transcriptions"),http::Body::Audio(&file.path,&c.asr.model,&c.language),c.timeout_seconds,&job).expect("真实音频转写失败");
            let text=response["text"].as_str().unwrap_or("").trim();
            assert!(!text.is_empty(),"{}；配置已保存",empty_transcription_message(&response));
            println!("[麦克风] 识别文字：{text}");
            let decision=interpret(text);
            assert_eq!(serde_json::to_value(&decision.actions).unwrap(),json!([{"type":"status"}]),"请按提示说查询当前仿真状态；其他动作不会执行");
            println!("[测试] PASS：真实麦克风 → small 识别 → 大模型 → status，未执行仿真动作。音频测试结束后删除。");
        }else{println!("[测试] 未录音；需要实际音频联调时加 --test-mic。");}
    }
}
#[tauri::command]
pub async fn voice_synthesize(app:tauri::AppHandle,text:String,request_id:String)->Result<Value,String>{
    let job=http::Job::begin(request_id)?;
    super::run_blocking(move||{
        let config=load(&app)?;config.require_enabled()?;
        if !config.speak_replies{return Err("语音播报未启用".into());}
        if text.trim().is_empty()||text.chars().count()>1000{return Err("播报文字为空或过长".into());}
        let body=json!({"model":config.tts.model,"input":text,"voice":config.tts_voice,"response_format":"wav"});
        let bytes=http::request(&config.tts,&http::url(&config.tts.base_url,"audio/speech"),http::Body::Json(&body),config.timeout_seconds,&job)?;
        if bytes.len()<12||&bytes[..4]!=b"RIFF"||&bytes[8..12]!=b"WAVE"{return Err("播报服务未返回 WAV 音频".into());}
        Ok(json!({"mime":"audio/wav","data":base64::engine::general_purpose::STANDARD.encode(bytes)}))
    }).await
}
