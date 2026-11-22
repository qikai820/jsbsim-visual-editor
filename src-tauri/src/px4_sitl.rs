//! Desktop-owned PX4 processes. Never writes into the selected build tree.
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, VecDeque}, fs, io::{BufRead, BufReader, Read}, net::{Ipv4Addr, UdpSocket}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant}};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Airframe { id: u32, model: String, name: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo { directory: String, executable: String, ready: bool, issues: Vec<String>, airframes: Vec<Airframe> }

pub fn inspect(directory: &str) -> Result<BuildInfo, String> {
    let root = Path::new(directory).canonicalize().map_err(|e| format!("无法读取构建目录：{e}"))?;
    if !root.is_dir() { return Err("请选择 px4_sitl_default 构建目录".into()); }
    let exe = root.join("bin/px4");
    let mut issues = Vec::new();
    if !exe.is_file() { issues.push("缺少 bin/px4，请先编译 PX4 SITL".into()); }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        if exe.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 == 0) { issues.push("bin/px4 没有执行权限".into()); }
    }
    if !root.join("etc/init.d-posix/rcS").is_file() { issues.push("缺少 etc/init.d-posix/rcS 启动脚本".into()); }
    if !root.join("bin/px4-alias.sh").is_file() { issues.push("缺少 bin/px4-alias.sh".into()); }
    let mut airframes = Vec::new();
    if let Ok(entries) = fs::read_dir(root.join("etc/init.d-posix/airframes")) {
        for entry in entries.flatten() {
            let filename = entry.file_name().to_string_lossy().into_owned();
            if filename.contains('.') { continue; }
            let Some((id, model)) = filename.split_once('_') else { continue };
            let Ok(id) = id.parse::<u32>() else { continue };
            if !entry.path().is_file() { continue; }
            let content = fs::read_to_string(entry.path()).unwrap_or_default();
            let name = content.lines().find_map(|line| line.trim().strip_prefix("# @name ")).unwrap_or(model).to_string();
            airframes.push(Airframe { id, model: model.into(), name });
        }
    }
    airframes.sort_by(|a,b| a.id.cmp(&b.id).then(a.model.cmp(&b.model)));
    if airframes.is_empty() { issues.push("没有检测到 SITL 机型脚本".into()); }
    Ok(BuildInfo { directory: root.to_string_lossy().into(), executable: exe.to_string_lossy().into(), ready: issues.is_empty(), issues, airframes })
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    directory: String, airframe: u32, instance: u8, mode: String,
    host: String, local_port: u16, remote_port: u16, speed: f64,
    latitude: f64, longitude: f64, altitude: f64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan { executable: String, args: Vec<String>, environment: BTreeMap<String,String>, work_directory: String, notes: Vec<String> }
fn simulator_host(config: &Config) -> &str {
    let host = config.host.trim();
    if host.is_empty() { "127.0.0.1" } else { host }
}
fn plan(config: &Config, data: &Path) -> Result<Plan, String> {
    let build = inspect(&config.directory)?;
    if !build.ready { return Err(build.issues.join("；")); }
    if config.instance > 9 { return Err("实例编号须为 0～9".into()); }
    let frame = build.airframes.iter().find(|f| f.id == config.airframe).ok_or("所选机型不在构建目录中")?;
    if !["hil-udp", "sitl-tcp", "sih"].contains(&config.mode.as_str()) { return Err("未知启动模式".into()); }
    if !config.speed.is_finite() || !(0.1..=10.0).contains(&config.speed) { return Err("仿真倍率须为 0.1～10".into()); }
    if !config.latitude.is_finite() || !(-90.0..=90.0).contains(&config.latitude) || !config.longitude.is_finite() || !(-180.0..=180.0).contains(&config.longitude) || !config.altitude.is_finite() || !(-1000.0..=20000.0).contains(&config.altitude) { return Err("起始经纬度或海拔无效".into()); }
    if config.mode == "hil-udp" {
        let host = simulator_host(config).parse::<Ipv4Addr>().map_err(|_| "UDP HIL 仿真地址须为 IPv4；同机仿真请留空或填写 127.0.0.1")?;
        if config.local_port == 0 || config.remote_port == 0 { return Err("UDP HIL 的 PX4 监听端口和模型接收端口须为 1～65535".into()); }
        if host.is_loopback() && config.local_port == config.remote_port { return Err("同机 UDP HIL 需要不同端口：建议 PX4 监听 14561、模型接收 14560；模型的飞控 HIL 目标须指向 127.0.0.1:14561".into()); }
    }
    if config.mode == "hil-udp" && config.speed != 1.0 { return Err("UDP HIL 使用实时倍率 1".into()); }
    if config.mode == "sitl-tcp" && !config.host.is_empty() && config.host.parse::<Ipv4Addr>().is_err() { return Err("TCP 仿真机地址须为 IPv4，或留空使用本机".into()); }
    // Prevent airframe scripts from launching Gazebo in the TCP-only mode.
    if config.mode == "sitl-tcp" && (frame.model.starts_with("gz_") || frame.model.starts_with("sihsim_")) { return Err("TCP 模式请选择 none_ / jsbsim_ / gazebo-classic_ 机型；gz_ 机型依赖 Gazebo，sihsim_ 机型请使用 SIH 模式".into()); }
    if config.mode == "sih" && !frame.model.starts_with("sihsim_") { return Err("SIH 模式请选择 sihsim_ 机型".into()); }
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new(); build.directory.hash(&mut hash);
    let work = data.join(format!("{:x}/{}/{}/{}", hash.finish(), config.mode, config.airframe, config.instance));
    let mut environment = BTreeMap::from([
        ("PX4_SYS_AUTOSTART".into(), config.airframe.to_string()),
        ("PX4_SIM_MODEL".into(), frame.model.clone()),
        ("PX4_SIMULATOR".into(), if config.mode == "sih" { "sihsim" } else { "none" }.into()),
        ("PX4_SIM_SPEED_FACTOR".into(), config.speed.to_string()),
        ("PX4_HOME_LAT".into(), config.latitude.to_string()),
        ("PX4_HOME_LON".into(), config.longitude.to_string()),
        ("PX4_HOME_ALT".into(), config.altitude.to_string()),
    ]);
    if config.mode == "sitl-tcp" && !config.host.is_empty() { environment.insert("PX4_SIM_HOST_ADDR".into(), config.host.clone()); }
    let notes = vec![if config.mode == "hil-udp" {
        format!("JSBSim UDP HIL：PX4 监听 {}，回传模型 {}:{}；请将模型的飞控 HIL 目标配置为 {}:{}。", config.local_port, simulator_host(config), config.remote_port, if simulator_host(config).parse::<Ipv4Addr>().is_ok_and(|host| host.is_loopback()) { "127.0.0.1" } else { "本电脑 IPv4" }, config.local_port)
    } else if config.mode == "sitl-tcp" {
        format!("仅启动 PX4，连接外部仿真器 {}:{}；不自动启动 JSBSim 或 Gazebo。", if config.host.is_empty() { "127.0.0.1" } else { &config.host }, 4560 + u16::from(config.instance))
    } else { "使用 PX4 内置 SIH 动力学，无需外部模型。".into() }, "进程运行不代表传感器链路或飞行状态已就绪；请通过日志及飞控心跳核对。".into()];
    Ok(Plan { executable: build.executable, args: vec!["-d".into(), "-i".into(), config.instance.to_string(), "-w".into(), work.to_string_lossy().into(), "-s".into(), "launcher.rcS".into(), Path::new(&build.directory).join("etc").to_string_lossy().into()], environment, work_directory: work.to_string_lossy().into(), notes })
}

fn gazebo_motor_functions(config: &Config) -> Result<BTreeMap<usize,u16>,String> {
    fn visit(path: &Path, etc: &Path, stack: &mut Vec<PathBuf>, functions: &mut BTreeMap<usize,u16>) -> Result<(),String> {
        let path=path.canonicalize().map_err(|e|format!("无法读取机型脚本 {}：{e}",path.display()))?;
        if !path.starts_with(etc) || stack.len()>=16 || stack.contains(&path) {
            return Err("机型脚本包含越界路径、循环引用或过深的引用".into());
        }
        stack.push(path.clone());
        let source=fs::read_to_string(&path).map_err(|e|e.to_string())?;
        for line in source.lines() {
            let words=line.split('#').next().unwrap_or("").split_whitespace().collect::<Vec<_>>();
            if words.len()>=2 && words[0]=="." {
                let target=words[1].trim_matches('"');
                if let Some(relative)=target.strip_prefix("${R}etc/") {
                    visit(&etc.join(relative),etc,stack,functions)?;
                }
            }
            if words.len()<4 || words[0]!="param" || !["set-default","set"].contains(&words[1]) { continue; }
            let index=if words[2]=="-s" {3} else {2};
            if words.len()<=index+1 { continue; }
            let Some(channel)=words[index].strip_prefix("SIM_GZ_EC_FUNC").and_then(|s|s.parse::<usize>().ok()) else {continue};
            let Some(function)=words[index+1].parse::<u16>().ok() else {continue};
            if (1..=16).contains(&channel) && (101..=112).contains(&function) { functions.insert(channel,function); }
        }
        stack.pop();Ok(())
    }
    let build=inspect(&config.directory)?;
    let frame=build.airframes.iter().find(|frame|frame.id==config.airframe).ok_or("所选机型不在构建目录中")?;
    let etc=Path::new(&build.directory).join("etc").canonicalize().map_err(|e|e.to_string())?;
    let mut functions=BTreeMap::new();
    visit(&etc.join(format!("init.d-posix/airframes/{}_{}",frame.id,frame.model)),&etc,&mut Vec::new(),&mut functions)?;
    Ok(functions)
}

fn startup(config: &Config) -> Result<String,String> {
    let source = fs::read_to_string(Path::new(&config.directory).join("etc/init.d-posix/rcS")).map_err(|e| e.to_string())?;
    let hook = "\t. px4-rc.simulator";
    if !source.contains(hook) { return Err("该 PX4 rcS 结构不受支持：找不到仿真器启动入口".into()); }
    let script = if config.mode == "hil-udp" {
        // Gazebo airframes map motors to SIM_GZ_EC, while pwm_out_sim reads
        // PWM_MAIN. Carry those functions across only into unmapped slots;
        // preserve any explicit user PWM mapping and the airframe's geometry.
        // The native build may omit Gazebo and therefore all SIM_GZ_EC
        // parameters. Read literal motor defaults (including inherited
        // airframe scripts) instead of querying nonexistent runtime params.
        let mapping = gazebo_motor_functions(config)?.iter().map(|(channel,function)| format!(
            "\tif param compare PWM_MAIN_FUNC{channel} 0\n\tthen\n\t\tparam set PWM_MAIN_FUNC{channel} {function}\n\tfi\n"
        )).collect::<String>();
        format!("\tparam set SYS_HITL 1\n{mapping}\tmavlink start -x -u {} -o {} -t {} -r 4000000 -m custom\n", config.local_port, config.remote_port, simulator_host(config))
    } else { format!("\tparam set SYS_HITL 0\n{hook}\n") };
    let source = source.replacen(hook, &script, 1);
    if config.mode == "hil-udp" {
        // POSIX commander does not read SYS_HITL to enable HIL. Without -h,
        // mavlink ignores HIL_SENSOR/HIL_GPS even with SYS_HITL set to 1.
        if !source.lines().any(|line| line.trim() == "commander start") {
            return Err("该 PX4 rcS 结构不受支持：找不到 commander start，无法启用 HIL 传感器接收".into());
        }
        let output_hook = "pwm_out_sim start -m sim";
        if source.matches(output_hook).count() != 1 {
            return Err("该 PX4 rcS 结构不受支持：找不到唯一 pwm_out_sim start -m sim，无法启用 HIL 电机输出".into());
        }
        // HIL commander intentionally sets lockdown for physical outputs.
        // Only the simulated output driver uses HIL mode; manual lockdown and
        // failsafe checks remain enforced by the normal mixer implementation.
        let source = source.replacen(output_hook, "pwm_out_sim start -m hil", 1);
        Ok(source.lines().map(|line| if line.trim() == "commander start" {
            line.replacen("commander start", "commander start -h", 1)
        } else { line.to_owned() }).collect::<Vec<_>>().join("\n") + "\n")
    } else { Ok(source) }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine { sequence: u64, stream: String, text: String }
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { pub(crate) running: bool, pid: Option<u32>, exit_code: Option<i32>, config: Option<Config>, plan: Option<Plan>, logs: Vec<LogLine>, external: bool }
impl Snapshot {
    pub(crate) fn matches_local_hil(&self, host: &str, port: u16) -> bool {
        self.running && host.parse::<Ipv4Addr>().is_ok_and(|ip| ip.is_loopback()) &&
            self.config.as_ref().is_some_and(|c| c.mode == "hil-udp" && c.local_port == port &&
                simulator_host(c).parse::<Ipv4Addr>().is_ok_and(|ip| ip.is_loopback()))
    }
}
#[derive(Clone)]
struct ExistingProcess { pid: u32, started: String, executable: PathBuf }
impl ExistingProcess {
    fn read(proc: &Path, pid: u32) -> Option<Self> {
        let root = proc.join(pid.to_string());
        let stat = fs::read_to_string(root.join("stat")).ok()?;
        let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
        if matches!(*fields.first()?, "Z" | "X") { return None; }
        Some(Self { pid, started: fields.get(19)?.to_string(), executable: fs::read_link(root.join("exe")).ok()? })
    }
    fn alive(&self) -> bool {
        Self::read(Path::new("/proc"), self.pid).is_some_and(|p| p.started == self.started && p.executable == self.executable)
    }
    fn signal(&self, signal: i32) -> Result<(), String> {
        if !self.alive() { return Ok(()); }
        #[cfg(unix)] {
            if unsafe { libc::kill(self.pid as i32, signal) } != 0 { return Err(format!("无法停止已检测的 PX4：{}", std::io::Error::last_os_error())); }
        }
        Ok(())
    }
}
fn discover_process(proc: &Path, config: &Config) -> Option<(ExistingProcess, Option<Config>)> {
    #[cfg(not(target_os = "linux"))] { let _ = (proc, config); return None; }
    #[cfg(target_os = "linux")] {
        use std::os::unix::fs::MetadataExt;
        let expected_executable = Path::new(&config.directory).join("bin/px4").canonicalize().ok();
        let sockets: Vec<String> = if config.mode == "hil-udp" {
            fs::read_to_string(proc.join("net/udp")).unwrap_or_default().lines().filter_map(|line| {
                let columns: Vec<_> = line.split_whitespace().collect();
                let port = u16::from_str_radix(columns.get(1)?.rsplit_once(':')?.1, 16).ok()?;
                (port == config.local_port).then(|| format!("socket:[{}]", columns.get(9).unwrap_or(&"")))
            }).collect()
        } else { vec![] };
        let mut found = Vec::new();
        for entry in fs::read_dir(proc).ok()?.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let Ok(metadata) = entry.metadata() else { continue };
            if metadata.uid() != unsafe { libc::geteuid() } { continue; }
            let Some(identity) = ExistingProcess::read(proc, pid) else { continue };
            if identity.executable.file_name().is_none_or(|name| name != "px4") { continue; }
            let argv = fs::read(entry.path().join("cmdline")).unwrap_or_default();
            let args: Vec<_> = argv.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
            if args.first().is_none_or(|arg| Path::new(arg).file_name().is_none_or(|name| name != "px4")) { continue; }
            let instance = args.windows(2).find(|v| v[0] == "-i").and_then(|v| v[1].parse::<u8>().ok()).unwrap_or(0);
            let owns_port = !sockets.is_empty() && fs::read_dir(entry.path().join("fd")).ok().is_some_and(|fds| fds.flatten().any(|fd| {
                fs::read_link(fd.path()).ok().is_some_and(|link| sockets.iter().any(|s| link == Path::new(s)))
            }));
            if !owns_port && !(expected_executable.as_ref() == Some(&identity.executable) && instance == config.instance) { continue; }
            let environment = fs::read(entry.path().join("environ")).unwrap_or_default();
            let env: BTreeMap<_,_> = environment.split(|b| *b == 0).filter_map(|s| std::str::from_utf8(s).ok()?.split_once('=')).collect();
            let saved = fs::read_link(entry.path().join("cwd")).ok().and_then(|cwd| fs::read(cwd.join("launcher-config.json")).ok())
                .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).ok())
                .filter(|c| c.instance == instance && Path::new(&c.directory).join("bin/px4").canonicalize().ok().as_ref() == Some(&identity.executable));
            let actual = saved.or_else(|| env.get("PX4_SYS_AUTOSTART").and_then(|s| s.parse().ok()).filter(|_| owns_port).map(|airframe| {
                let mut actual = config.clone(); actual.airframe = airframe; actual.instance = instance;
                if let Some(root) = identity.executable.parent().and_then(Path::parent) { actual.directory = root.to_string_lossy().into(); }
                actual
            }));
            found.push((owns_port, identity, actual));
        }
        // A verified socket owner takes precedence over a matching instance.
        found.sort_by_key(|(port, process, _)| (!port, process.pid));
        found.into_iter().next().map(|(_, process, config)| (process, config))
    }
}
#[derive(Default)]
struct Inner { child: Option<Child>, existing: Option<ExistingProcess>, snapshot: Snapshot, logs: VecDeque<LogLine>, sequence: u64, generation: u64 }
#[derive(Default)]
pub struct Manager { inner: Arc<Mutex<Inner>> }
impl Manager {
    fn log(inner: &mut Inner, stream: &str, value: String) {
        inner.sequence += 1;
        inner.logs.push_back(LogLine { sequence: inner.sequence, stream: stream.into(), text: value });
        while inner.logs.len() > 1500 { inner.logs.pop_front(); }
    }
    fn read_output(&self, reader: impl Read + Send + 'static, stream: &'static str, generation: u64) {
        let inner = self.inner.clone();
        std::thread::spawn(move || {
            // Bounded chunks also handle progress output without newlines.
            let mut reader = BufReader::new(reader);
            loop {
                let mut bytes = Vec::new();
                match reader.by_ref().take(8192).read_until(b'\n', &mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => { let mut guard = inner.lock().unwrap(); if guard.generation != generation { break; } Self::log(&mut guard, stream, String::from_utf8_lossy(&bytes).trim_end().to_string()); }
                }
            }
        });
    }
    fn reap(inner: &mut Inner) -> Result<(), String> {
        if inner.existing.as_ref().is_some_and(|process| !process.alive()) {
            inner.existing = None; inner.snapshot.running = false; inner.snapshot.pid = None;
            Self::log(inner, "manager", "已检测的 PX4 已退出".into());
        }
        if let Some(child) = inner.child.as_mut() {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
                inner.child = None; inner.snapshot.running = false; inner.snapshot.pid = None; inner.snapshot.exit_code = status.code();
                Self::log(inner, "manager", format!("PX4 已退出：{status}"));
            }
        }
        Ok(())
    }
    pub fn status(&self) -> Result<Snapshot, String> {
        let mut inner = self.inner.lock().unwrap(); Self::reap(&mut inner)?;
        let mut result = inner.snapshot.clone(); result.logs = inner.logs.iter().cloned().collect(); Ok(result)
    }
    fn discover(&self, config: &Config) -> Result<Snapshot, String> {
        let mut inner = self.inner.lock().unwrap(); Self::reap(&mut inner)?;
        if inner.child.is_none() && inner.existing.is_none() {
            if let Some((process, actual)) = discover_process(Path::new("/proc"), config) {
                inner.generation += 1; inner.logs.clear();
                Self::log(&mut inner, "manager", format!("检测到已有 PX4 PID {}；该进程由其他启动入口运行，历史 stdout/stderr 不可读取。", process.pid));
                inner.snapshot = Snapshot { running:true, pid:Some(process.pid), config:actual, external:true, ..Snapshot::default() };
                inner.existing = Some(process);
            }
        }
        let mut result = inner.snapshot.clone(); result.logs = inner.logs.iter().cloned().collect(); Ok(result)
    }
    pub fn start(&self, config: Config, data: &Path) -> Result<Snapshot, String> {
        self.start_inner(config, data, None)
    }
    fn start_inner(&self, config: Config, data: &Path, libraries: Option<&Path>) -> Result<Snapshot, String> {
        let detected = self.discover(&config)?;
        if detected.running && detected.external { return Ok(detected); }
        let mut inner = self.inner.lock().unwrap(); Self::reap(&mut inner)?;
        if inner.child.is_some() { return Err("已有软件飞控运行，请先停止后更换配置".into()); }
        let mut plan = plan(&config, data)?;
        if let Some(path) = libraries { plan.environment.insert("LD_LIBRARY_PATH".into(), path.to_string_lossy().into()); }
        let startup = startup(&config)?;
        // Fail before spawning when another app owns the selected transport.
        let _udp = if config.mode == "hil-udp" { Some(UdpSocket::bind((Ipv4Addr::UNSPECIFIED, config.local_port)).map_err(|e| format!("HIL UDP {} 不可用：{e}", config.local_port))?) } else { None };
        fs::create_dir_all(&plan.work_directory).map_err(|e| e.to_string())?;
        fs::write(Path::new(&plan.work_directory).join("launcher.rcS"), startup).map_err(|e| e.to_string())?;
        fs::write(Path::new(&plan.work_directory).join("launcher-config.json"), serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        drop(_udp);
        let mut command = Command::new(&plan.executable);
        command.args(&plan.args).current_dir(&plan.work_directory).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Ignore launch variables inherited from another PX4 development shell.
        let inherited: Vec<_> = std::env::vars_os().filter(|(key,_)| key.to_string_lossy().starts_with("PX4_")).map(|(key,_)| key).collect();
        for key in inherited { command.env_remove(key); }
        command.env_remove("replay_mode").envs(&plan.environment);
        #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
        let mut child = command.spawn().map_err(|e| format!("PX4 启动失败：{e}"))?;
        inner.generation += 1; let generation = inner.generation;
        inner.logs.clear();
        Self::log(&mut inner, "manager", format!("已启动 PX4 PID {}；工作目录 {}", child.id(), plan.work_directory));
        if let Some(reader) = child.stdout.take() { self.read_output(reader, "stdout", generation); }
        if let Some(reader) = child.stderr.take() { self.read_output(reader, "stderr", generation); }
        inner.snapshot = Snapshot { running: true, pid: Some(child.id()), exit_code: None, config: Some(config), plan: Some(plan), logs: vec![], external: false };
        inner.child = Some(child); drop(inner); self.status()
    }
    pub fn stop(&self) -> Result<Snapshot, String> {
        let mut inner = self.inner.lock().unwrap(); Self::reap(&mut inner)?;
        if let Some(mut child) = inner.child.take() {
            #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGINT); }
            #[cfg(not(unix))] let _ = child.kill();
            let deadline = Instant::now() + Duration::from_secs(3);
            let status = loop {
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
                if Instant::now() >= deadline { let _ = child.kill(); break child.wait().map_err(|e| e.to_string())?; }
                std::thread::sleep(Duration::from_millis(40));
            };
            #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            inner.snapshot.running = false; inner.snapshot.pid = None; inner.snapshot.exit_code = status.code();
            Self::log(&mut inner, "manager", "软件飞控已停止".into());
        }
        drop(inner); self.status()
    }
    fn stop_detected(&self) -> Result<Snapshot, String> {
        let mut inner = self.inner.lock().unwrap(); Self::reap(&mut inner)?;
        if let Some(process) = inner.existing.clone() {
            process.signal(libc::SIGINT)?;
            let deadline = Instant::now() + Duration::from_secs(3);
            while process.alive() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(40)); }
            if process.alive() { process.signal(libc::SIGKILL)?; }
            Self::reap(&mut inner)?;
        }
        drop(inner); self.stop()
    }
}
pub fn start_builtin(directory: &Path, data: &Path, libraries: &Path) -> Result<Snapshot, String> {
    let config = Config { directory:directory.to_string_lossy().into(),airframe:3010,instance:0,mode:"hil-udp".into(),host:"127.0.0.1".into(),local_port:14561,remote_port:14560,speed:1.0,latitude:34.157,longitude:108.953,altitude:400.0 };
    global().start_inner(config,data,Some(libraries))
}
pub fn global() -> &'static Manager { static VALUE: OnceLock<Manager> = OnceLock::new(); VALUE.get_or_init(Manager::default) }

#[tauri::command]
pub async fn px4_sitl_inspect(directory: String) -> Result<BuildInfo, String> { super::run_blocking(move || inspect(&directory)).await }
#[tauri::command]
pub async fn px4_sitl_preview(app: tauri::AppHandle, config: Config) -> Result<Plan, String> {
    use tauri::Manager;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?.join("px4-sitl");
    super::run_blocking(move || { startup(&config)?; plan(&config, &data) }).await
}
#[tauri::command]
pub async fn px4_sitl_start(app: tauri::AppHandle, config: Config) -> Result<Snapshot, String> {
    use tauri::Manager;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?.join("px4-sitl");
    super::run_blocking(move || global().start(config, &data)).await
}
#[tauri::command]
pub async fn px4_sitl_status(config: Option<Config>) -> Result<Snapshot, String> { super::run_blocking(move || match config { Some(c) => global().discover(&c), None => global().status() }).await }
#[tauri::command]
pub async fn px4_sitl_stop() -> Result<Snapshot, String> { super::run_blocking(|| global().stop_detected()).await }

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn px4_sitl_pick(window: tauri::WebviewWindow, initial_directory: Option<String>) -> Result<Option<BuildInfo>, String> {
    use gtk::prelude::*;
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Option<PathBuf>,String>>();
    let parent = window.clone();
    window.run_on_main_thread(move || {
        gtk::glib::MainContext::default().spawn_local(async move {
            let result = async {
                let parent = parent.gtk_window().map_err(|e| e.to_string())?;
                let dialog = gtk::FileChooserNative::new(Some("选择 PX4 SITL 构建目录"), Some(&parent), gtk::FileChooserAction::SelectFolder, Some("选择"), Some("取消"));
                dialog.set_modal(true);
                if let Some(path) = initial_directory.as_deref().map(Path::new).filter(|p| p.is_dir()) { dialog.set_current_folder(path); }
                let response = dialog.run_future().await;
                let path = if response == gtk::ResponseType::Accept { dialog.filename() } else { None };
                dialog.destroy(); Ok(path)
            }.await;
            let _ = sender.send(result);
        });
    }).map_err(|e| e.to_string())?;
    match receiver.await.map_err(|e| e.to_string())?? { Some(path) => super::run_blocking(move || inspect(&path.to_string_lossy()).map(Some)).await, None => Ok(None) }
}
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn px4_sitl_pick() -> Result<Option<BuildInfo>, String> { Err("请手动输入本机 PX4 构建目录；当前启动功能面向 Linux 桌面".into()) }

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU64,Ordering};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(program: &str) -> Self {
            static ID: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("px4-launcher-{}-{}",std::process::id(),ID.fetch_add(1,Ordering::Relaxed)));
            fs::create_dir_all(path.join("bin")).unwrap();
            fs::create_dir_all(path.join("etc/init.d-posix/airframes")).unwrap();
            fs::write(path.join("bin/px4"),program).unwrap();
            fs::set_permissions(path.join("bin/px4"), fs::Permissions::from_mode(0o755)).unwrap();
            fs::write(path.join("bin/px4-alias.sh"), "# aliases").unwrap();
            fs::write(path.join("etc/init.d-posix/rcS"),"#!/bin/sh\nif true; then\n\t. px4-rc.simulator\nfi\nsensors start\ncommander start\npwm_out_sim start -m sim\n").unwrap();
            fs::write(path.join("etc/init.d-posix/airframes/10016_none_iris"),"# @name Generic Iris Quadrotor SITL\n").unwrap();
            fs::write(path.join("etc/init.d-posix/airframes/10016_none_iris.post"),"# ignored").unwrap();
            fs::write(path.join("etc/init.d-posix/airframes/10040_sihsim_quadx"),"# @name SIH Quad\n").unwrap();
            Self(path)
        }
        fn config(&self) -> Config { Config { directory:self.0.to_string_lossy().into(),airframe:10016,instance:0,mode:"hil-udp".into(),host:"127.0.0.1".into(),local_port:14561,remote_port:14560,speed:1.,latitude:34.,longitude:108.,altitude:400. } }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn detects_models_and_missing_executable_without_writing() {
        let f=Fixture::new("#!/bin/sh\nexit 0\n");
        let build=inspect(&f.0.to_string_lossy()).unwrap();
        assert!(build.ready); assert_eq!(build.airframes.len(),2); assert_eq!(build.airframes[0].name,"Generic Iris Quadrotor SITL");
        fs::remove_file(f.0.join("bin/px4")).unwrap();
        let build=inspect(&f.0.to_string_lossy()).unwrap(); assert!(!build.ready); assert!(build.issues[0].contains("bin/px4"));
    }
    #[test]
    fn validates_and_isolates_runtime_and_generates_hil_script() {
        let f=Fixture::new("#!/bin/sh\nexit 0\n"); let mut c=f.config();
        let plan=plan(&c,&f.0.join("data")).unwrap();
        assert!(plan.work_directory.starts_with(f.0.join("data").to_str().unwrap()));
        assert!(!Path::new(&plan.work_directory).exists(),"preview must not create files");
        let script=startup(&c).unwrap();assert!(script.contains("param set SYS_HITL 1"));assert!(!script.contains(". px4-rc.simulator"));
        assert!(script.lines().any(|line| line == "commander start -h"));
        assert!(script.contains("pwm_out_sim start -m hil"));assert!(!script.contains("pwm_out_sim start -m sim"));
        c.mode="sitl-tcp".into();
        let tcp=startup(&c).unwrap();assert!(tcp.lines().any(|line| line == "commander start"));assert!(!tcp.contains("commander start -h"));
        assert!(tcp.contains("pwm_out_sim start -m sim"));assert!(!tcp.contains("SIM_GZ_EC_FUNC"));
        c.mode="sih".into();assert!(!startup(&c).unwrap().contains("commander start -h"));
        c.mode="hil-udp".into();
        assert!(fs::read_to_string(f.0.join("etc/init.d-posix/rcS")).unwrap().contains(". px4-rc.simulator"));
        c.host="127.0.0.1; touch /tmp/px4-injection".into(); assert!(super::plan(&c,&f.0).is_err());
        c=f.config();c.instance=10; assert!(super::plan(&c,&f.0).is_err());
        c=f.config();c.airframe=999; assert!(super::plan(&c,&f.0).is_err());
        c=f.config();c.latitude=f64::NAN; assert!(super::plan(&c,&f.0).is_err());
        c=f.config();c.mode="sih".into(); assert!(super::plan(&c,&f.0).is_err());
        c.airframe=10040;assert_eq!(super::plan(&c,&f.0).unwrap().environment["PX4_SIMULATOR"],"sihsim");
    }
    #[test]
    fn udp_hil_supports_local_and_board_models_and_checks_ports() {
        let f = Fixture::new("#!/bin/sh\nexit 0\n"); let mut c = f.config();
        for host in ["", "  ", "127.0.0.1", " 127.0.0.1 "] {
            c.host = host.into();
            let preview = plan(&c, &f.0).unwrap();
            assert!(preview.notes[0].contains("127.0.0.1:14560"));
            assert!(startup(&c).unwrap().contains("-u 14561 -o 14560 -t 127.0.0.1"));
        }
        c.local_port = 14560;
        for host in ["", "127.0.0.1", "127.0.0.2"] {
            c.host = host.into(); assert!(plan(&c, &f.0).err().unwrap().contains("不同端口"));
        }
        c.host = "192.168.3.82".into();
        assert!(plan(&c, &f.0).is_ok(), "different hosts may use the same port");
        assert!(startup(&c).unwrap().contains("-u 14560 -o 14560 -t 192.168.3.82"));
        c.local_port = 0; assert!(plan(&c, &f.0).is_err());
        c.local_port = 14561; c.remote_port = 0; assert!(plan(&c, &f.0).is_err());
        c.remote_port = 14560; c.host = "invalid".into(); assert!(plan(&c, &f.0).is_err());
    }
    #[test]
    fn hil_requires_commander_hook_and_local_target_matches_verified_endpoint() {
        let f=Fixture::new("#!/bin/sh\nexit 0\n");let c=f.config();
        let mut state=Snapshot { running:true,config:Some(c.clone()),..Snapshot::default() };
        assert!(state.matches_local_hil("127.0.0.1",14561));
        assert!(!state.matches_local_hil("192.168.1.10",14561));
        assert!(!state.matches_local_hil("127.0.0.1",14560));
        state.running=false;assert!(!state.matches_local_hil("127.0.0.1",14561));
        fs::write(f.0.join("etc/init.d-posix/rcS"),"\t. px4-rc.simulator\nsensors start\n").unwrap();
        assert!(startup(&c).unwrap_err().contains("commander start"));
        fs::write(f.0.join("etc/init.d-posix/rcS"),"\t. px4-rc.simulator\ncommander start\n").unwrap();
        assert!(startup(&c).unwrap_err().contains("pwm_out_sim"));
    }
    #[test]
    fn hil_script_executes_gazebo_motor_mapping_and_preserves_custom_outputs() {
        let f=Fixture::new("#!/bin/sh\nexit 0\n");
        fs::write(f.0.join("etc/init.d-posix/airframes/4005_gz_x500_vision"),". ${R}etc/init.d-posix/airframes/4001_gz_x500\n").unwrap();
        fs::write(f.0.join("etc/init.d-posix/airframes/4001_gz_x500"),"param set-default SIM_GZ_EC_FUNC1 101\nparam set-default SIM_GZ_EC_FUNC2 102\nparam set-default SIM_GZ_EC_FUNC3 103\nparam set-default SIM_GZ_EC_FUNC4 104\n").unwrap();
        let mut config=f.config();config.airframe=4005;
        let params=f.0.join("parameters");fs::create_dir_all(&params).unwrap();
        for channel in 1..=16 {
            fs::write(params.join(format!("PWM_MAIN_FUNC{channel}")),"0").unwrap();
        }
        // Reproduce the real native build: Gazebo parameters do not exist.
        // Explicit user mappings must survive the Gazebo -> UDP HIL bridge.
        fs::write(params.join("PWM_MAIN_FUNC1"),"104").unwrap();
        let stubs=r#"
param() {
    operation=$1; shift
    if [ "$1" = -s ] || [ "$1" = -q ]; then shift; fi
    case "$operation" in
        set) printf '%s' "$2" > "$PARAM_TEST_DIR/$1" ;;
        compare) value=$(cat "$PARAM_TEST_DIR/$1" 2>/dev/null) || return 1; [ "$value" = "$2" ] ;;
        greater) value=$(cat "$PARAM_TEST_DIR/$1" 2>/dev/null) || return 1; [ "$value" -gt "$2" ] ;;
        show) cat "$PARAM_TEST_DIR/$1" ;;
        *) return 1 ;;
    esac
}
mavlink() { :; }
sensors() { :; }
commander() { printf '%s\n' "$*" > "$PARAM_TEST_DIR/commander"; }
pwm_out_sim() { printf '%s\n' "$*" > "$PARAM_TEST_DIR/pwm_out_sim"; }
"#;
        let script=f.0.join("test.rcS");
        let generated=startup(&config).unwrap();
        assert!(!generated.contains("param show -q SIM_GZ_EC"));
        fs::write(&script,format!("{stubs}\n{generated}")).unwrap();
        let output=Command::new("/bin/sh").arg(script).env("PARAM_TEST_DIR",&params).output().unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        assert_eq!(fs::read_to_string(params.join("PWM_MAIN_FUNC1")).unwrap(),"104");
        for channel in 2..=4 {
            assert_eq!(fs::read_to_string(params.join(format!("PWM_MAIN_FUNC{channel}"))).unwrap(),(100+channel).to_string());
        }
        assert_eq!(fs::read_to_string(params.join("PWM_MAIN_FUNC5")).unwrap(),"0");
        assert_eq!(fs::read_to_string(params.join("commander")).unwrap(),"start -h\n");
        assert_eq!(fs::read_to_string(params.join("pwm_out_sim")).unwrap(),"start -m hil\n");
    }
    #[test]
    #[ignore = "requires PX4_SITL_TEST_BUILD with the real 4005/4001 airframe scripts; read-only, no sockets"]
    fn installed_gazebo_airframe_generates_hil_outputs_without_gazebo_parameters() {
        let f=Fixture::new("#!/bin/sh\nexit 0\n");let mut config=f.config();
        config.directory=std::env::var("PX4_SITL_TEST_BUILD").expect("PX4_SITL_TEST_BUILD");config.airframe=4005;
        let script=startup(&config).unwrap();
        for channel in 1..=4 { assert!(script.contains(&format!("param set PWM_MAIN_FUNC{channel} {}",100+channel))); }
        assert!(script.contains("commander start -h"));assert!(script.contains("pwm_out_sim start -m hil"));
        assert!(!script.contains("param show -q SIM_GZ_EC"));
        let file=f.0.join("actual-launcher.rcS");fs::write(&file,script).unwrap();
        assert!(Command::new("/bin/sh").arg("-n").arg(file).status().unwrap().success());
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn discovers_existing_px4_by_socket_or_build_instance_without_adopting_other_apps() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new("#!/bin/sh\nexit 0\n");
        let proc = f.0.join("proc"); let pid = proc.join("4242");
        fs::create_dir_all(pid.join("fd")).unwrap(); fs::create_dir_all(proc.join("net")).unwrap();
        let mut stat = vec!["0"; 20]; stat[0] = "S"; stat[19] = "12345";
        fs::write(pid.join("stat"), format!("4242 (px4 with spaces) {}", stat.join(" "))).unwrap();
        symlink(f.0.join("bin/px4"), pid.join("exe")).unwrap();
        symlink("socket:[123456]", pid.join("fd/7")).unwrap();
        fs::write(pid.join("cmdline"), b"/other/bin/px4\0-d\0-i\0".iter().copied().chain(b"0\0".iter().copied()).collect::<Vec<_>>()).unwrap();
        fs::write(pid.join("environ"), b"PX4_SYS_AUTOSTART=3010\0").unwrap();
        fs::write(proc.join("net/udp"), "header\n0: 00000000:38E1 00000000:0000 07 0:0 0:0 0 1000 0 123456\n").unwrap();
        let mut c = f.config(); c.directory = "/another/build".into();
        let (identity, actual) = discover_process(&proc, &c).expect("detect PX4 owning UDP 14561 despite a stale build selection");
        assert_eq!(identity.pid, 4242); assert_eq!(identity.started, "12345"); assert_eq!(actual.unwrap().airframe, 3010);
        c.local_port = 14600; assert!(discover_process(&proc, &c).is_none(), "another port is not this connection");
        c = f.config(); c.local_port = 14600;
        assert!(discover_process(&proc, &c).is_some(), "recognize build and instance before UDP is bound");
        c.instance = 1; assert!(discover_process(&proc, &c).is_none());
        c = f.config(); fs::write(pid.join("cmdline"), b"px4-listener\0-i\0".iter().copied().chain(b"0\0".iter().copied()).collect::<Vec<_>>()).unwrap();
        assert!(discover_process(&proc, &c).is_none(), "PX4 CLI clients are not a running daemon");
        fs::write(pid.join("cmdline"), b"px4\0").unwrap();
        fs::remove_file(pid.join("exe")).unwrap(); symlink("/usr/bin/python3", pid.join("exe")).unwrap();
        assert!(discover_process(&proc, &c).is_none(), "a non-PX4 socket owner must not become a stoppable flight controller");
    }
    #[test]
    #[cfg(target_os = "linux")]
    fn discovered_process_is_preserved_on_exit_and_stopped_only_by_explicit_action() {
        let mut child = Command::new("sleep").arg("120").spawn().unwrap();
        struct Cleanup(u32); impl Drop for Cleanup { fn drop(&mut self) { if self.0 != 0 { unsafe { libc::kill(self.0 as i32, libc::SIGKILL); } } } }
        let mut guard = Cleanup(child.id());
        let identity = ExistingProcess::read(Path::new("/proc"), child.id()).unwrap();
        let mut stale = identity.clone(); stale.started = "wrong-start-time".into();
        stale.signal(libc::SIGKILL).unwrap(); assert!(identity.alive(), "PID reuse must not signal a different process");
        let m = Manager::default();
        { let mut inner = m.inner.lock().unwrap(); inner.existing = Some(identity); inner.snapshot = Snapshot { running:true, pid:Some(child.id()), external:true, ..Snapshot::default() }; }
        assert!(m.stop().unwrap().running, "application shutdown leaves externally started PX4 running");
        m.stop_detected().unwrap(); child.wait().unwrap(); guard.0 = 0; assert!(!m.status().unwrap().running);
    }
    #[test]
    #[ignore = "requires permission to bind local UDP sockets"]
    fn rejects_busy_port_before_creating_process() {
        let f=Fixture::new("#!/bin/sh\nexit 0\n");let m=Manager::default();let mut c=f.config();
        let listener=UdpSocket::bind("0.0.0.0:0").unwrap();c.local_port=listener.local_addr().unwrap().port();
        assert!(m.start(c,&f.0.join("data")).err().unwrap().contains("不可用"));assert!(!m.status().unwrap().running);
    }
    #[test]
    fn owns_process_captures_logs_and_cleans_process_group() {
        let f=Fixture::new("#!/bin/sh\necho stdout-ready\necho stderr-ready >&2\nsleep 120 &\necho $! > descendant.pid\nwait\n");let m=Manager::default();
        let mut c=f.config();c.mode="sih".into();c.airframe=10040;let started=m.start(c.clone(),&f.0.join("data")).unwrap();assert!(started.running);
        assert!(m.start(c,&f.0.join("data")).is_err(),"duplicate starts must fail");
        let work=PathBuf::from(started.plan.unwrap().work_directory);
        let deadline=Instant::now()+Duration::from_secs(2);
        while !work.join("descendant.pid").exists() || m.status().unwrap().logs.len()<3 { assert!(Instant::now()<deadline); std::thread::sleep(Duration::from_millis(20)); }
        let descendant: i32=fs::read_to_string(work.join("descendant.pid")).unwrap().trim().parse().unwrap();
        let logs=m.status().unwrap().logs;assert!(logs.iter().any(|l|l.stream=="stderr"&&l.text=="stderr-ready"));
        assert!(!m.stop().unwrap().running);assert!(!m.stop().unwrap().running);
        let deadline=Instant::now()+Duration::from_secs(1);
        loop {
            let stat=fs::read_to_string(format!("/proc/{descendant}/stat")).unwrap_or_default();
            if stat.is_empty() || stat.split_whitespace().nth(2)==Some("Z") { break; }
            assert!(Instant::now()<deadline,"descendant must have stopped");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn reports_immediate_exit_and_can_restart() {
        let f=Fixture::new("#!/bin/sh\necho boot-error >&2\nexit 7\n");let m=Manager::default();let mut c=f.config();c.mode="sih".into();c.airframe=10040;
        m.start(c.clone(),&f.0.join("data")).unwrap();
        let deadline=Instant::now()+Duration::from_secs(2);
        while m.status().unwrap().running { assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(10)); }
        assert_eq!(m.status().unwrap().exit_code,Some(7));
        m.start(c,&f.0.join("data")).unwrap();m.stop().unwrap();
    }
    #[test]
    #[ignore = "requires PX4_SITL_TEST_BUILD pointing at an actual Linux PX4 build"]
    fn real_sih_startup_topics_and_shutdown() {
        let directory = std::env::var("PX4_SITL_TEST_BUILD").expect("set PX4_SITL_TEST_BUILD");
        let output = std::env::var("PX4_SITL_TEST_OUTPUT").map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join(format!("px4-sitl-real-{}", std::process::id())));
        fs::create_dir_all(&output).unwrap();
        let config = Config { directory:directory.clone(),airframe:10040,instance:9,mode:"sih".into(),host:String::new(),local_port:14569,remote_port:14569,speed:1.,latitude:34.157,longitude:108.953,altitude:400. };
        let manager = Manager::default();
        struct StopOnDrop<'a>(&'a Manager);
        impl Drop for StopOnDrop<'_> { fn drop(&mut self) { let _ = self.0.stop(); } }
        let _guard = StopOnDrop(&manager);
        let inspected = inspect(&directory).unwrap();
        assert!(inspected.ready, "{:?}", inspected.issues);
        manager.start(config.clone(), &output.join("runtime")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let booted = loop {
            let state = manager.status().unwrap();
            let booted = state.logs.iter().any(|line| line.text.contains("Startup script returned successfully"));
            if booted || !state.running || Instant::now() >= deadline {
                fs::write(output.join("startup.json"),serde_json::to_vec_pretty(&state).unwrap()).unwrap();
                break booted;
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        assert!(booted, "PX4 did not finish startup; inspect {}", output.join("startup.json").display());
        let cli = |module:&str,args:&[&str]| {
            let mut command = Command::new("timeout");
            command.arg("8").arg(Path::new(&directory).join(format!("bin/px4-{module}"))).args(["--instance","9"]).args(args);
            let result = command.output().unwrap();
            let text = format!("{}{}",String::from_utf8_lossy(&result.stdout),String::from_utf8_lossy(&result.stderr));
            fs::write(output.join(format!("{module}-{}.txt",args[0])),&text).unwrap();
            assert!(result.status.success(), "{module} {args:?} failed: {text}");
            text
        };
        cli("simulator_sih", &["status"]);
        let sensor = cli("listener", &["sensor_combined","-n","1"]);
        assert!(sensor.contains("timestamp:"), "No simulated IMU data: {sensor}");
        let attitude = cli("listener", &["vehicle_attitude","-n","1"]);
        assert!(attitude.contains("timestamp:"), "No estimator attitude: {attitude}");
        let mode = cli("param", &["show","-q","SYS_HITL"]);
        assert!(mode.lines().any(|line| line.trim()=="0"), "SIH must disable HIL: {mode}");
        assert!(manager.start(config, &output.join("runtime")).is_err());
        let stopped = manager.stop().unwrap();
        assert!(!stopped.running);
        fs::write(output.join("stopped.json"),serde_json::to_vec_pretty(&stopped).unwrap()).unwrap();
        let status = Command::new("timeout").arg("3").arg(Path::new(&directory).join("bin/px4-simulator_sih")).args(["--instance","9","status"]).output().unwrap();
        assert!(!status.status.success(), "PX4 daemon survived stop");
        println!("Real PX4 SIH startup, IMU, estimator, duplicate start and shutdown PASS; evidence {}",output.display());
    }

}
