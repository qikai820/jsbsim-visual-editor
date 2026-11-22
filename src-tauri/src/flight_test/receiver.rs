//! Existing PX4 manual-input selection. No custom parameters or telemetry.
use super::*;
static BUSY: AtomicBool = AtomicBool::new(false);
static GATE: Mutex<()> = Mutex::new(());
struct IdleLease {
    cancel: Arc<AtomicBool>,
    session: Option<u64>,
    generation: u64,
}
static IDLE: Mutex<Option<IdleLease>> = Mutex::new(None);
static QUERY: Mutex<Option<(u64, Instant)>> = Mutex::new(None);
pub fn busy() -> bool {
    BUSY.load(Ordering::Acquire)
}
pub fn idle_active() -> bool {
    IDLE.lock().ok().is_some_and(|v| {
        v.as_ref()
            .is_some_and(|l| !l.cancel.load(Ordering::Acquire))
    })
}
pub fn gate() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    GATE.lock().map_err(|e| e.to_string())
}
pub fn clear_idle() {
    if let Ok(mut v) = IDLE.lock() {
        if let Some(l) = v.take() {
            l.cancel.store(true, Ordering::Release);
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub mode: Option<u8>,
    pub selected: Option<u8>,
    pub actual: Option<u8>,
    pub ready: bool,
    pub supported: bool,
    pub switching: bool,
    pub idle_sending: bool,
    pub feedback_age_ms: Option<u64>,
    pub reason: String,
}
pub fn configured(t: &Telemetry, source: u8) -> bool {
    t.params.get("COM_RC_IN_MODE").map(|p| p.0) == Some(source as f64)
}
pub fn manual_ready(
    t: &Telemetry,
    expected: Option<[f64; 4]>,
    since: Instant,
    now: Instant,
) -> bool {
    if !configured(t, 1) {
        return false;
    }
    t.manual_control.is_some_and(|(raw, at)| {
        at >= since
            && now.saturating_duration_since(at) < Duration::from_millis(700)
            && expected.is_none_or(|v| {
                [v[1], v[0], v[3], v[2]]
                    .iter()
                    .zip(raw)
                    .all(|(v, r)| ((*v * 1000.).round() as i16 - r).abs() <= 2)
            })
    })
}
fn describe(t: &Telemetry, options: &Options) -> SourceStatus {
    let now = Instant::now();
    let mode = t
        .params
        .get("COM_RC_IN_MODE")
        .and_then(|p| (p.0.fract() == 0. && (0. ..=8.).contains(&p.0)).then_some(p.0 as u8));
    let selected = mode.filter(|v| *v <= 1);
    let idle_sending = IDLE.lock().ok().is_some_and(|v| {
        v.as_ref().is_some_and(|l| {
            l.session == options.session_id
                && l.generation == t.generation
                && !l.cancel.load(Ordering::Acquire)
        })
    });
    let observed = if selected == Some(1) {
        manual_ready(
            t,
            if live_running() { None } else { Some([0.; 4]) },
            now - Duration::from_secs(2),
            now,
        ) && (idle_sending || live_running())
    } else if selected == Some(0) {
        t.rc_channels
            .is_some_and(|(_, at)| now.duration_since(at) < Duration::from_millis(700))
            && t.rc_health
                .is_some_and(|(v, at)| v && now.duration_since(at) < Duration::from_millis(1500))
    } else {
        false
    };
    let ready = t.fresh(now) && t.hil && observed;
    let feedback_age_ms = if selected == Some(1) {
        t.manual_control
            .map(|(_, at)| now.duration_since(at).as_millis() as u64)
    } else {
        t.rc_channels
            .map(|(_, at)| now.duration_since(at).as_millis() as u64)
    };
    let reason = if !t.fresh(now) {
        "飞控心跳过期"
    } else if !t.hil {
        "仅在 HIL 仿真中切换主输入"
    } else if busy() {
        "正在切换主输入"
    } else if mode.is_none() {
        "等待 COM_RC_IN_MODE 回读"
    } else if selected.is_none() {
        "当前为自动／混合输入；点击选择工具箱 MAVLink 主杆"
    } else if ready {
        "主输入选择与反馈已确认"
    } else if selected == Some(1) && !idle_sending && !live_running() {
        "MAVLink 已选，点击启动工具箱模拟输入"
    } else {
        "等待所选主输入的新鲜有效反馈"
    }
    .into();
    SourceStatus {
        mode,
        selected,
        actual: ready.then_some(selected.unwrap_or(0)),
        ready,
        supported: mode.is_some(),
        switching: busy(),
        idle_sending,
        feedback_age_ms,
        reason,
    }
}
pub fn query(options: &Options, sequence: &mut u8, parameter: bool) -> Result<(), String> {
    let target = (options.system, options.component);
    if parameter {
        write(
            options,
            mavlink::request_param_named(target, "COM_RC_IN_MODE", *sequence),
        )?;
        *sequence = sequence.wrapping_add(1);
    }
    for id in [65., 69.] {
        write(
            options,
            mavlink::command(target, 512, [id, 0., 0., 0., 0., 0., 0.], *sequence),
        )?;
        *sequence = sequence.wrapping_add(1);
    }
    Ok(())
}
pub fn status(options: Options) -> Result<SourceStatus, String> {
    let t = telemetry(&options)?;
    let now = Instant::now();
    let due = {
        let mut q = QUERY.lock().map_err(|e| e.to_string())?;
        let due = q.is_none_or(|(s, at)| {
            Some(s) != options.session_id || now.duration_since(at) >= Duration::from_millis(500)
        });
        if due {
            *q = Some((options.session_id.unwrap_or(0), now));
        }
        due
    };
    if due && t.fresh(now) && t.hil && !busy() {
        query(&options, &mut 0, true)?;
    }
    Ok(describe(&t, &options))
}
pub fn require_manual(
    options: &Options,
    expected: &Telemetry,
    sequence: &mut u8,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let since = Instant::now();
    query(options, sequence, true)?;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("操作已取消".into());
        }
        let t = telemetry(options)?;
        if !t.fresh(Instant::now()) || !t.hil || !same_target(&t, expected) {
            return Err("确认主输入期间飞控状态变化".into());
        }
        if t.params.get("COM_RC_IN_MODE").is_some_and(|p| p.2 >= since) {
            return if configured(&t, 1) {
                Ok(())
            } else {
                Err("请先将主输入切换至工具箱 MAVLink（COM_RC_IN_MODE=1）".into())
            };
        }
        if since.elapsed() > Duration::from_millis(1800) {
            return Err("未取得 COM_RC_IN_MODE 回读，未执行测试".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}
fn check_change(
    options: &Options,
    expected: &Telemetry,
    scene: &(f64, String, u64),
) -> Result<Telemetry, String> {
    let t = telemetry(options)?;
    if !t.fresh(Instant::now()) || !t.hil || t.armed || !same_target(&t, expected) {
        return Err("切换期间飞控身份、HIL、心跳或上锁状态变化".into());
    }
    let s = simulator(options.instance)?;
    if s.1 != scene.1 || s.2 != scene.2 {
        return Err("切换期间仿真实例变化".into());
    }
    Ok(t)
}
pub fn select(options: Options, source: u8) -> Result<SourceStatus, String> {
    options.validate()?;
    if options.dry_run || options.rc_emulation || source > 1 {
        return Err("主输入来源选择无效，需要 MANUAL_CONTROL 模式".into());
    }
    if BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("已有主输入切换正在进行，请先查询状态".into());
    }
    struct BusyGuard;
    impl Drop for BusyGuard {
        fn drop(&mut self) {
            BUSY.store(false, Ordering::Release);
        }
    }
    let _busy = BusyGuard;
    let _gate = gate()?;
    if running() {
        return Err("仿真测试运行中不能切换主输入".into());
    }
    let expected = telemetry(&options)?;
    if !expected.fresh(Instant::now()) || !expected.hil || expected.armed {
        return Err("切换主输入需要新鲜 HIL 心跳且飞控已上锁".into());
    }
    let scene = simulator(options.instance)?;
    let mut sequence = 0;
    let since = Instant::now();
    query(&options, &mut sequence, true)?;
    let initial = loop {
        let t = check_change(&options, &expected, &scene)?;
        if t.params.get("COM_RC_IN_MODE").is_some_and(|p| p.2 >= since) {
            break t;
        }
        if since.elapsed() > Duration::from_millis(1800) {
            return Err("未取得 COM_RC_IN_MODE 回读".into());
        }
        thread::sleep(Duration::from_millis(10));
    };
    clear_idle();
    let changed = Instant::now();
    // One write only. Confirmation uses readback, never a write retry.
    write(
        &options,
        mavlink::set_int_parameter(
            (options.system, options.component),
            "COM_RC_IN_MODE",
            source as i32,
            initial.param_bytewise,
            sequence,
        ),
    )?;
    sequence = sequence.wrapping_add(1);
    write(
        &options,
        mavlink::command(
            (options.system, options.component),
            511,
            [69., 100_000., 0., 0., 0., 0., 0.],
            sequence,
        ),
    )?;
    sequence = sequence.wrapping_add(1);
    let mut stable = None;
    let mut last_query = changed - Duration::from_secs(1);
    let mut last_input = last_query;
    loop {
        let now = Instant::now();
        let t = check_change(&options, &expected, &scene)?;
        if source == 1
            && now.duration_since(last_input)
                >= Duration::from_secs_f64(1. / options.rate_hz as f64)
        {
            write_neutral(&options, None, [0.; 4], &mut sequence)?;
            last_input = now;
        }
        if now.duration_since(last_query) >= Duration::from_millis(250) {
            query(&options, &mut sequence, true)?;
            last_query = now;
        }
        let readback = t
            .params
            .get("COM_RC_IN_MODE")
            .is_some_and(|p| p.2 >= changed && p.0 == source as f64);
        let healthy = if source == 1 {
            manual_ready(&t, Some([0.; 4]), changed, now)
        } else {
            t.rc_channels.is_some_and(|(_, at)| {
                at >= changed && now.duration_since(at) < Duration::from_millis(700)
            }) && t.rc_health.is_some_and(|(v, at)| {
                v && at >= changed && now.duration_since(at) < Duration::from_millis(1500)
            })
        };
        if readback && healthy {
            stable.get_or_insert(now);
        } else {
            stable = None;
        }
        if stable.is_some_and(|at| now.duration_since(at) >= Duration::from_secs(1)) {
            if source == 1 {
                start_idle(options.clone(), expected, scene)?;
            }
            let mut result = describe(&t, &options);
            result.switching = false;
            return Ok(result);
        }
        if changed.elapsed() > Duration::from_secs(6) {
            return Err(
                "主输入切换未确认：参数回读或输入反馈未就绪。模拟发送已停止，请先查询当前选择"
                    .into(),
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
}
fn start_idle(
    options: Options,
    expected: Telemetry,
    scene: (f64, String, u64),
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    *IDLE.lock().map_err(|e| e.to_string())? = Some(IdleLease {
        cancel: cancel.clone(),
        session: options.session_id,
        generation: expected.generation,
    });
    thread::spawn(move || {
        let mut sequence = 0;
        let mut last_query = Instant::now();
        let mut last_heartbeat = last_query - Duration::from_secs(1);
        while !cancel.load(Ordering::Acquire) {
            thread::sleep(Duration::from_secs_f64(1. / options.rate_hz as f64));
            let Ok(_gate) = GATE.try_lock() else {
                continue;
            };
            if cancel.load(Ordering::Acquire) {
                break;
            }
            if live_running() || busy() {
                continue;
            }
            let Ok(t) = check_change(&options, &expected, &scene) else {
                break;
            };
            if !configured(&t, 1) {
                break;
            }
            if write_neutral(&options, None, [0.; 4], &mut sequence).is_err() {
                break;
            }
            if last_query.elapsed() > Duration::from_millis(500) {
                if query(&options, &mut sequence, true).is_err() {
                    break;
                }
                last_query = Instant::now();
            }
            if last_heartbeat.elapsed() > Duration::from_secs(1) {
                if write(
                    &options,
                    mavlink::encode(0, &[0, 0, 0, 0, 6, 8, 0, 4, 3], sequence),
                )
                .is_err()
                {
                    break;
                }
                sequence = sequence.wrapping_add(1);
                last_heartbeat = Instant::now();
            }
        }
        cancel.store(true, Ordering::Release);
    });
    Ok(())
}

pub fn prepare_manual(
    options: &Options,
    cancel: &AtomicBool,
    snapshot: &Arc<Mutex<Snapshot>>,
    sequence: &mut u8,
    expected: &Telemetry,
    neutral: [f64; 4],
) -> Result<(), String> {
    record(
        snapshot,
        0.,
        "info",
        "准备 MAVLink 主杆：等待 COM_RC_IN_MODE=1 与主杆回传匹配，连续确认 1 秒后执行脚本",
    );
    let since = Instant::now();
    let mut stable = None;
    let mut last_input = since - Duration::from_secs(1);
    let mut last_query = last_input;
    loop {
        let now = Instant::now();
        if cancel.load(Ordering::Acquire) {
            return Err("MAVLink 主杆准备已取消".into());
        }
        let t = telemetry(options)?;
        if !t.fresh(now)
            || !t.hil
            || !same_target(&t, expected)
            || t.armed != expected.armed
            || !configured(&t, 1)
        {
            return Err("MAVLink 主杆准备期间飞控状态或输入选择变化".into());
        }
        if now.duration_since(last_input) >= Duration::from_secs_f64(1. / options.rate_hz as f64) {
            write_neutral(options, None, neutral, sequence)?;
            last_input = now;
        }
        if now.duration_since(last_query) >= Duration::from_millis(200) {
            query(options, sequence, true)?;
            last_query = now;
        }
        if manual_ready(&t, Some(neutral), since, now) {
            stable.get_or_insert(now);
        } else {
            stable = None;
        }
        let held = stable
            .map(|at| now.duration_since(at).as_secs_f64())
            .unwrap_or(0.);
        if let Ok(mut s) = snapshot.lock() {
            s.rc = neutral;
            s.values = t.values(now);
            s.values
                .insert("test/receiver/ready".into(), (held >= 1.) as u8 as f64);
        }
        if held >= 1. {
            return Ok(());
        }
        if since.elapsed() > Duration::from_secs(6) {
            return Err("MAVLink 主杆未就绪：参数或回传尚未匹配，未执行脚本动作".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}
