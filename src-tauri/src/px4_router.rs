use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;
use std::sync::Mutex;

static OPERATIONS: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub device: String,
    pub baud: u32,
    pub host: String,
    pub qgc_port: u16,
    pub toolbox_port: u16,
}
#[derive(Clone, Debug, Serialize)]
pub struct Route {
    pub name: String, pub rx_bytes: u64, pub tx_bytes: u64, pub errors: u64, pub last_error: i32,
}
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub simulator: String,
    pub state: String,
    pub config: Config,
    pub active_config: Config,
    pub routes: Vec<Route>,
    #[serde(skip)]
    original: String,
}
fn validate(config: &Config) -> Result<(), String> {
    let suffix = config.device.strip_prefix("/dev/ttyACM").or_else(|| config.device.strip_prefix("/dev/ttyUSB"));
    if !suffix.is_some_and(|s| !s.is_empty() && s.len() <= 2 && s.bytes().all(|b| b.is_ascii_digit())) {
        return Err("USB 设备应为 /dev/ttyACM0 或 /dev/ttyUSB0 等板端串口路径".into());
    }
    if ![57600,115200,230400,460800,921600].contains(&config.baud) { return Err("不支持的 USB 波特率".into()); }
    let host: Ipv4Addr = config.host.parse().map_err(|_| "目标地址须为有效的 IPv4 地址")?;
    if host.is_unspecified() || host.is_multicast() || host.is_broadcast() || host.is_loopback() { return Err("目标地址须为电脑的有效单播 IPv4 地址".into()); }
    if config.qgc_port == 0 || config.toolbox_port == 0 || config.qgc_port == config.toolbox_port {
        return Err("QGC 和工具箱须使用不同的 1～65535 端口".into());
    }
    Ok(())
}
fn terminal(output: &str) -> String {
    let mut out = String::new(); let mut chars = output.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); for c in chars.by_ref() { if ('@'..='~').contains(&c) { break; } }
        } else if c != '\r' { out.push(c); }
    }
    out
}
fn config_from_fields(fields: &std::collections::HashMap<&str,&str>) -> Result<Config,String> {
    let field = |key| fields.get(key).copied().ok_or_else(|| format!("板端转发配置缺少 {key}"));
    Ok(Config { device:field("device")?.into(),host:field("host")?.into(),
        baud:field("baud")?.parse().map_err(|_|"无效波特率")?,
        qgc_port:field("qgc_port")?.parse().map_err(|_|"无效 QGC 端口")?,
        toolbox_port:field("toolbox_port")?.parse().map_err(|_|"无效工具箱端口")? })
}
fn parse_config(output: &str) -> Result<Config,String> {
    let mut fields = std::collections::HashMap::new();
    for line in output.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let (key,value) = line.split_once('=').ok_or("板端转发配置格式无效")?;
        let key=key.trim();
        if !["device","baud","host","qgc_port","toolbox_port"].contains(&key) || fields.insert(key,value.trim()).is_some() {
            return Err("板端转发配置包含未知或重复字段".into());
        }
    }
    let config = config_from_fields(&fields)?; validate(&config)?; Ok(config)
}
fn serialize(config: &Config) -> String {
    format!("device={}\nbaud={}\nhost={}\nqgc_port={}\ntoolbox_port={}\n",config.device,config.baud,config.host,config.qgc_port,config.toolbox_port)
}
fn parse_status(host: Ipv4Addr, status: &str, original: String) -> Result<Snapshot,String> {
    let status=terminal(status);
    let line=status.lines().find_map(|l|l.strip_prefix("MAVLINK_ROUTER "))
        .ok_or("仿真机未返回独立转发服务状态，请确认已安装支持常驻转发的固件")?;
    let fields:std::collections::HashMap<_,_>=line.split_whitespace().filter_map(|p|p.split_once('=')).collect();
    let state=*fields.get("state").ok_or("转发服务未返回运行状态")?;
    if !["running","stopped","starting","stopping"].contains(&state) {return Err("未知转发服务状态".into());}
    let active_config=config_from_fields(&fields)?;
    let mut routes=Vec::new();
    for line in status.lines().filter_map(|l|l.strip_prefix("MAVLINK_ROUTE ")) {
        let fields:std::collections::HashMap<_,_>=line.split_whitespace().filter_map(|p|p.split_once('=')).collect();
        let number=|key|fields.get(key).ok_or("转发统计字段缺失")?.parse::<u64>().map_err(|_|"转发统计无效");
        let name=fields.get("name").ok_or("转发通道名称缺失")?;
        if !["qgc","px4-toolbox"].contains(name) || routes.iter().any(|r:&Route|r.name==*name) {return Err("转发通道重复或未知".into());}
        routes.push(Route{name:(*name).into(),rx_bytes:number("rx_bytes")?,tx_bytes:number("tx_bytes")?,errors:number("errors")?,
            last_error:fields.get("last_error").ok_or("转发错误码缺失")?.parse().map_err(|_|"转发错误码无效")?});
    }
    if routes.len()!=2 {return Err("仿真机未返回完整的两路转发统计".into());}
    let config=parse_config(&original)?;
    Ok(Snapshot{simulator:host.to_string(),state:state.into(),config,active_config,routes,original})
}
trait Board {
    fn snapshot(&mut self) -> Result<Snapshot,String>;
    fn write(&mut self, before:&str, next:&str) -> Result<(),String>;
    fn command(&mut self, action:&str) -> Result<(),String>;
}
struct Runtime { host:Ipv4Addr }
impl Board for Runtime {
    fn snapshot(&mut self) -> Result<Snapshot,String> {
        crate::romfs_network::with_host_session(self.host,|session| {
            let status=session.command("jsbsim router status")?;
            let original=session.command("cat /mnt/home/mavlink-router.conf")?;
            parse_status(self.host,&status,original)
        })
    }
    fn write(&mut self,before:&str,next:&str)->Result<(),String> {
        crate::network_files::write_router_config_at(self.host,before.as_bytes(),next.as_bytes())
    }
    fn command(&mut self,action:&str)->Result<(),String> {
        let output=crate::romfs_network::with_host_session(self.host,|session|session.command(&format!("jsbsim router {action}")))?;
        if output.contains("state=running") && action=="start" || output.contains("state=stopped") && action=="stop" {Ok(())}
        else {Err(format!("转发服务{action}未确认：{}",terminal(&output).trim()))}
    }
}
fn runtime()->Result<Runtime,String> {
    Ok(Runtime{host:crate::transport::network_host().ok_or("未发现网口仿真机")?})
}
fn runtime_at(simulator:&str)->Result<Runtime,String> {
    let target:Ipv4Addr=simulator.parse().map_err(|_|"无效仿真机地址")?;
    let board=runtime()?;
    if target!=board.host {return Err("当前仿真机目标已变化，请刷新后重试".into());}
    Ok(board)
}
pub fn read()->Result<Snapshot,String> {
    let _guard=OPERATIONS.lock().map_err(|_|"转发设置锁异常")?;runtime()?.snapshot()
}
fn apply_on(board:&mut impl Board,config:Config,expected:Config)->Result<Snapshot,String> {
    validate(&config)?;
    let before=board.snapshot()?;
    if before.config!=expected {return Err("板端转发配置已变化，请刷新后重新编辑".into());}
    if !["running","stopped"].contains(&before.state.as_str()) {return Err("转发服务正在切换状态，请稍后重试".into());}
    if before.config==config && (before.state!="running" || before.active_config==config) {return Ok(before);}
    let next=serialize(&config);
    if before.config!=config {board.write(&before.original,&next)?;}
    if before.state=="running" {
        let restart=(|| {board.command("stop")?;board.command("start")})();
        if let Err(error)=restart {
            let restore:Result<(),String>=(|| {
                board.write(&next,&before.original)?;
                // A start reply can be lost after the daemon already started.
                // Restart explicitly; idempotent start alone keeps new wiring.
                board.command("stop")?;board.command("start")?;
                let restored=board.snapshot()?;
                if restored.config!=before.config || restored.active_config!=before.config || restored.state!="running" {return Err("恢复后的运行配置不一致".into());}
                Ok(())
            })();
            return Err(format!("应用转发配置失败：{error}；{}",match restore {Ok(())=>"已恢复原配置并启动服务".into(),Err(e)=>format!("恢复未确认：{e}")}));
        }
    }
    let after=board.snapshot()?;
    if after.config!=config || before.state=="running" && (after.state!="running" || after.active_config!=config) {
        return Err("保存后状态回读不一致，请刷新核对仿真机实际配置".into());
    }
    Ok(after)
}
pub fn apply(config:Config,expected:Config,simulator:&str)->Result<Snapshot,String> {
    let _guard=OPERATIONS.lock().map_err(|_|"转发设置锁异常")?;apply_on(&mut runtime_at(simulator)?,config,expected)
}
pub fn control(action:&str,simulator:&str)->Result<Snapshot,String> {
    if !["start","stop"].contains(&action) {return Err("无效服务操作".into());}
    let _guard=OPERATIONS.lock().map_err(|_|"转发设置锁异常")?;
    let mut board=runtime_at(simulator)?;board.command(action)?;let after=board.snapshot()?;
    if after.state!=if action=="start"{"running"}else{"stopped"} {return Err("服务状态回读未确认".into());}
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config()->Config {Config{device:"/dev/ttyACM0".into(),baud:921600,host:"192.168.3.109".into(),qgc_port:14550,toolbox_port:14553}}
    fn snapshot(state:&str)->Snapshot {
        let c=config();Snapshot{simulator:"192.168.3.82".into(),state:state.into(),config:c.clone(),active_config:c.clone(),routes:vec![],original:serialize(&c)}
    }
    struct Mock { value:Snapshot, calls:Vec<String>, fail_start:bool, fail_after_start:bool }
    impl Board for Mock {
        fn snapshot(&mut self)->Result<Snapshot,String>{self.calls.push("read".into());Ok(self.value.clone())}
        fn write(&mut self,before:&str,next:&str)->Result<(),String>{assert_eq!(self.value.original,before);self.calls.push("write".into());self.value.original=next.into();self.value.config=parse_config(next)?;Ok(())}
        fn command(&mut self,action:&str)->Result<(),String>{self.calls.push(action.into());if action=="start"&&self.fail_start {self.fail_start=false;return Err("start failed".into());}self.value.state=if action=="start"{"running"}else{"stopped"}.into();if action=="start"{self.value.active_config=self.value.config.clone();if self.fail_after_start{self.fail_after_start=false;return Err("start reply lost".into());}}Ok(())}
    }
    fn mock(state:&str)->Mock {Mock{value:snapshot(state),calls:vec![],fail_start:false,fail_after_start:false}}
    #[test] fn ansi_status_and_strict_configuration() {
        let text="\x1b[KMAVLINK_ROUTER state=running device=/dev/ttyACM0 baud=921600 host=192.168.3.109 qgc_port=14550 toolbox_port=14553\nMAVLINK_ROUTE name=qgc rx_bytes=1234 tx_bytes=56 errors=0 last_error=0\nMAVLINK_ROUTE name=px4-toolbox rx_bytes=1234 tx_bytes=7 errors=2 last_error=98\n";
        let s=parse_status("192.168.3.82".parse().unwrap(),text,serialize(&config())).unwrap();assert_eq!(s.routes[1].last_error,98);assert_eq!(s.config,config());
        assert!(parse_status("192.168.3.82".parse().unwrap(),"Unknown option",serialize(&config())).is_err());
        assert!(parse_config(&(serialize(&config())+"host=192.168.3.1\n")).is_err());
        for change in ["qgc_port=14553","host=0.0.0.0","device=/dev/ttyACM0;reboot","baud=12"] {
            let key=change.split('=').next().unwrap();let input=serialize(&config()).lines().map(|line|if line.starts_with(&format!("{key}=")){change}else{line}).collect::<Vec<_>>().join("\n");
            assert!(parse_config(&input).is_err(),"{input}");
        }
    }
    #[test] fn changed_configuration_restarts_only_after_verified_write() {
        let mut board=mock("running");let mut next=config();next.toolbox_port=14554;
        assert_eq!(apply_on(&mut board,next.clone(),config()).unwrap().active_config,next);
        assert_eq!(board.calls,["read","write","stop","start","read"]);
    }
    #[test] fn unchanged_config_does_not_interrupt_shell() {
        let mut board=mock("running");apply_on(&mut board,config(),config()).unwrap();assert_eq!(board.calls,["read"]);
    }
    #[test] fn stale_and_transitional_snapshots_never_write() {
        let mut board=mock("running");let mut stale=config();stale.host="192.168.3.110".into();assert!(apply_on(&mut board,config(),stale).is_err());assert_eq!(board.calls,["read"]);
        let mut board=mock("starting");let mut next=config();next.toolbox_port=14554;assert!(apply_on(&mut board,next,config()).is_err());assert_eq!(board.calls,["read"]);
    }
    #[test] fn saving_stopped_service_does_not_start_it() {
        let mut board=mock("stopped");let mut next=config();next.toolbox_port=14554;
        assert_eq!(apply_on(&mut board,next,config()).unwrap().state,"stopped");assert_eq!(board.calls,["read","write","read"]);
    }
    #[test] fn lost_start_reply_does_not_leave_new_active_wiring_after_rollback() {
        let mut board=mock("running");board.fail_after_start=true;let mut next=config();next.toolbox_port=14554;
        assert!(apply_on(&mut board,next,config()).unwrap_err().contains("已恢复原配置"));assert_eq!(board.value.active_config,config());
    }
    #[test] fn restart_failure_restores_previous_config_and_reports_failure() {
        let mut board=mock("running");board.fail_start=true;let mut next=config();next.toolbox_port=14554;
        assert!(apply_on(&mut board,next,config()).unwrap_err().contains("已恢复原配置"));assert_eq!(board.value.config,config());assert_eq!(board.value.state,"running");
    }
}
