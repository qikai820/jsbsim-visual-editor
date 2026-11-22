use super::config::Config;
use serde::Serialize;
use std::{fs, path::PathBuf, process::{Child,Command,Stdio}, sync::{atomic::{AtomicU64,Ordering}, Mutex,OnceLock}, time::{Duration,Instant}};

static NEXT: AtomicU64=AtomicU64::new(1);
struct Recording { id:u64, child:Child, file:AudioFile }
static RECORDING:OnceLock<Mutex<Option<Recording>>>=OnceLock::new();
fn recording()->&'static Mutex<Option<Recording>>{RECORDING.get_or_init(||Mutex::new(None))}
pub struct AudioFile { pub path:PathBuf, directory:PathBuf }
impl Drop for AudioFile {fn drop(&mut self){let _=fs::remove_file(&self.path);let _=fs::remove_dir(&self.directory);}}
impl AudioFile {
    fn new()->Result<Self,String>{
        let mut token=[0u8;16];getrandom::fill(&mut token).map_err(|e|e.to_string())?;
        let name=token.iter().map(|b|format!("{b:02x}")).collect::<String>();
        let directory=std::env::temp_dir().join(format!("jsbsim-voice-{name}"));
        let mut builder=fs::DirBuilder::new();
        #[cfg(unix)]{use std::os::unix::fs::DirBuilderExt;builder.mode(0o700);}
        builder.create(&directory).map_err(|e|e.to_string())?;
        Ok(Self{path:directory.join("microphone.wav"),directory})
    }
    pub fn validate(&self)->Result<(),String>{
        use std::io::Read;
        let mut file=fs::File::open(&self.path).map_err(|_|"没有录到音频，请检查麦克风设备和权限")?;
        let size=file.metadata().map_err(|e|e.to_string())?.len();
        let mut header=[0u8;12];
        if !(100..=4_000_000).contains(&size)||file.read_exact(&mut header).is_err()||&header[..4]!=b"RIFF"||&header[8..]!=b"WAVE"{return Err("录音不是有效 WAV 或没有音频数据，请检查输入设备".into());}
        Ok(())
    }
}
fn executable(name:&str)->Option<PathBuf>{
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir|dir.join(name)).find(|path|{
        if !path.is_file(){return false;}
        #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;return path.metadata().is_ok_and(|m|m.permissions().mode()&0o111!=0);}
        #[cfg(not(unix))]{true}
    })
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Capabilities{pub recorders:Vec<String>,pub platform:String}
pub fn capabilities()->Capabilities{Capabilities{recorders:["pw-record","arecord"].iter().filter(|name|executable(name).is_some()).map(|name|name.to_string()).collect(),platform:std::env::consts::OS.into()}}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Started{pub id:u64,pub recorder:String,pub max_seconds:u32}
pub fn start(config:&Config)->Result<Started,String>{
    config.require_enabled()?;
    if !cfg!(target_os="linux"){return Err("本机麦克风录音目前支持 Linux；其他平台可先使用文字指令".into());}
    let mut state=recording().lock().map_err(|e|e.to_string())?;
    if state.is_some(){return Err("麦克风已在录音，请先停止或取消".into());}
    let selected=if config.recorder=="auto"{["pw-record","arecord"].into_iter().find(|name|executable(name).is_some()).ok_or("缺少 pw-record / arecord，请安装 PipeWire 工具或 alsa-utils")?}else{&config.recorder};
    let program=executable(selected).ok_or("找不到所选录音程序")?;
    let file=AudioFile::new()?;let mut command=Command::new(program);
    if selected=="pw-record"{
        command.args(["--rate","16000","--channels","1","--format","s16"]);
        if !config.input_device.is_empty(){command.args(["--target",&config.input_device]);}
    }else{
        command.args(["-q","-t","wav","-f","S16_LE","-r","16000","-c","1","-d",&config.max_record_seconds.to_string()]);
        command.args(["-D",if config.input_device.is_empty(){"default"}else{&config.input_device}]);
    }
    command.arg(&file.path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child=command.spawn().map_err(|e|format!("无法打开麦克风：{e}"))?;
    std::thread::sleep(Duration::from_millis(120));
    if let Some(status)=child.try_wait().map_err(|e|e.to_string())? { return Err(format!("录音程序已退出（{status}），请检查系统默认输入设备、麦克风权限和设备名称")); }
    let id=NEXT.fetch_add(1,Ordering::Relaxed);*state=Some(Recording{id,child,file});
    let seconds=config.max_record_seconds;
    // Independent of the webview: losing focus or a crashed UI cannot leave
    // microphone capture running beyond the configured limit.
    watch_limit(id,seconds);
    Ok(Started{id,recorder:selected.into(),max_seconds:seconds})
}
fn watch_limit(id:u64,seconds:u32) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(u64::from(seconds));
        loop {
            std::thread::sleep(Duration::from_millis(100));
            let Ok(mut state) = recording().lock() else { return };
            let Some(r) = state.as_mut().filter(|r| r.id == id) else { return };
            if Instant::now() >= deadline { let _ = stop_child(&mut r.child); return; }
        }
    });
}
fn stop_child(child:&mut Child)->Result<(),String>{
    if child.try_wait().map_err(|e|e.to_string())?.is_some(){return Ok(());}
    #[cfg(unix)]unsafe{libc::kill(child.id()as i32,libc::SIGINT);}
    #[cfg(not(unix))]{let _=child.kill();}
    let deadline=Instant::now()+Duration::from_secs(2);
    while Instant::now()<deadline{if child.try_wait().map_err(|e|e.to_string())?.is_some(){return Ok(());}std::thread::sleep(Duration::from_millis(20));}
    let _=child.kill();child.wait().map_err(|e|e.to_string())?;Ok(())
}
pub fn finish(id:u64)->Result<AudioFile,String>{
    let mut state=recording().lock().map_err(|e|e.to_string())?;
    if !state.as_ref().is_some_and(|r|r.id==id){return Err("录音会话已变化或已取消".into());}
    let mut r=state.take().unwrap();drop(state);stop_child(&mut r.child)?;r.file.validate()?;Ok(r.file)
}
pub fn cancel(id:u64){if let Ok(mut state)=recording().lock(){if state.as_ref().is_some_and(|r|r.id==id){if let Some(mut r)=state.take(){let _=stop_child(&mut r.child);}}}}
pub fn current_id()->Option<u64>{recording().lock().ok()?.as_ref().map(|r|r.id)}
pub fn shutdown(){if let Ok(mut state)=recording().lock(){if let Some(mut r)=state.take(){let _=stop_child(&mut r.child);}}}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn audio_is_private_validated_and_removed(){let path;let dir;{let file=AudioFile::new().unwrap();path=file.path.clone();dir=file.directory.clone();assert!(file.validate().is_err());let mut data=vec![0u8;128];data[..4].copy_from_slice(b"RIFF");data[8..12].copy_from_slice(b"WAVE");fs::write(&path,&data).unwrap();assert!(file.validate().is_ok());#[cfg(unix)]{use std::os::unix::fs::PermissionsExt;assert_eq!(fs::metadata(&dir).unwrap().permissions().mode()&0o777,0o700);}}assert!(!path.exists());assert!(!dir.exists());}
    #[test]
    #[cfg(target_os="linux")]
    fn session_cancel_and_time_limit_reap_owned_process_and_remove_audio() {
        fn fixture()->(u64,PathBuf) {
            let file=AudioFile::new().unwrap();let path=file.path.clone();
            let mut bytes=vec![0u8;128];bytes[..4].copy_from_slice(b"RIFF");bytes[8..12].copy_from_slice(b"WAVE");fs::write(&path,bytes).unwrap();
            let child=Command::new("sleep").arg("60").spawn().unwrap();let id=NEXT.fetch_add(1,Ordering::Relaxed);
            *recording().lock().unwrap()=Some(Recording{id,child,file});(id,path)
        }
        struct Cleanup;impl Drop for Cleanup{fn drop(&mut self){shutdown();}}
        let _cleanup=Cleanup;
        let (id,path)=fixture();cancel(id+1);assert_eq!(current_id(),Some(id));cancel(id);assert!(current_id().is_none());assert!(!path.exists());
        let (id,path)=fixture();watch_limit(id,0);let deadline=Instant::now()+Duration::from_secs(4);
        loop {
            let ended=recording().lock().unwrap().as_mut().unwrap().child.try_wait().unwrap().is_some();
            if ended{break;}
            assert!(Instant::now()<deadline,"recording time limit must terminate its process");std::thread::sleep(Duration::from_millis(20));
        }
        let audio=finish(id).unwrap();assert!(path.exists());drop(audio);assert!(!path.exists());assert!(current_id().is_none());
    }

}
