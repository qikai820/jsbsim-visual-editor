use super::{
    altitude::Controller,
    attitude,
    heading,
    manual,
    xml::{Condition, Expr, Script},
};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Default)]
struct EventState {
    triggered: bool,
    notified: bool,
    start: f64,
    values: Vec<(f64, f64)>,
    transitioning: Vec<bool>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub owner: String,
    pub mask: u8,
    pub values: [f64; 4],
}
#[derive(Clone, Serialize)]
pub struct Command {
    pub owner: String,
    pub kind: u8,
    pub argument: f64,
}
pub struct Engine {
    pub script: Script,
    pub properties: BTreeMap<String, f64>,
    states: Vec<EventState>,
    altitude: BTreeMap<String, Controller>,
    attitude: BTreeMap<String, attitude::Controller>,
    manual: BTreeMap<String, manual::Controller>,
    headings: BTreeMap<String, heading::Controller>,
    heading_anchor: Option<(f64, f64, [f64; 2])>,
    manual_origin: Option<manual::Origin>,
    heading: Option<f64>,
    pub time: f64,
    pub messages: Vec<String>,
}
impl Engine {
    pub fn new(script: Script) -> Self {
        let states = vec![EventState::default(); script.events.len()];
        let properties = script.properties.clone();
        Self {
            script,
            states,
            altitude: BTreeMap::new(),
            attitude: BTreeMap::new(),
            manual: BTreeMap::new(),
            headings: BTreeMap::new(),
            heading_anchor: None,
            manual_origin: None,
            heading: None,
            properties,
            time: 0.,
            messages: Vec::new(),
        }
    }
    pub fn value(&self, path: &str) -> Option<f64> {
        if path == "simulation/sim-time-sec" {
            Some(self.time)
        } else {
            self.properties.get(path).copied()
        }
    }
    pub fn set(&mut self, path: &str, value: f64) {
        if value.is_finite() {
            self.properties.insert(path.into(), value);
        }
    }
    fn expression_at(properties: &BTreeMap<String, f64>, time: f64, e: &Expr) -> Option<f64> {
        let value = match e {
            Expr::Value(v) => *v,
            Expr::Property(p) => {
                return if p == "simulation/sim-time-sec" {
                    Some(time)
                } else {
                    properties.get(p).copied()
                }
            }
            Expr::Function(op, args) => {
                let vs = args
                    .iter()
                    .map(|a| Self::expression_at(properties, time, a))
                    .collect::<Option<Vec<_>>>()?;
                match op.as_str() {
                    "sum" => vs.iter().sum(),
                    "product" => vs.iter().product(),
                    "difference" => vs[1..].iter().fold(vs[0], |a, b| a - b),
                    "quotient" => vs[0] / vs[1],
                    "min" => vs.iter().copied().fold(f64::INFINITY, f64::min),
                    "max" => vs.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                    "abs" => vs[0].abs(),
                    _ => return None,
                }
            }
        };
        value.is_finite().then_some(value)
    }
    fn condition_at(properties: &BTreeMap<String, f64>, time: f64, c: &Condition) -> Option<bool> {
        match c {
            Condition::Compare(a, op, b) => {
                let a = Self::expression_at(properties, time, a)?;
                let b = Self::expression_at(properties, time, b)?;
                Some(match op.as_str() {
                    "ge" => a >= b,
                    "le" => a <= b,
                    "gt" => a > b,
                    "lt" => a < b,
                    "eq" => a == b,
                    "ne" => a != b,
                    _ => false,
                })
            }
            Condition::All(cs) => {
                let mut unknown = false;
                for c in cs {
                    match Self::condition_at(properties, time, c) {
                        Some(false) => return Some(false),
                        None => unknown = true,
                        _ => {}
                    }
                }
                if unknown {
                    None
                } else {
                    Some(true)
                }
            }
            Condition::Any(cs) => {
                let mut unknown = false;
                for c in cs {
                    match Self::condition_at(properties, time, c) {
                        Some(true) => return Some(true),
                        None => unknown = true,
                        _ => {}
                    }
                }
                if unknown {
                    None
                } else {
                    Some(false)
                }
            }
        }
    }
    pub fn tick(&mut self, time: f64) -> Result<(), String> {
        if !time.is_finite() || time + 1e-8 < self.time {
            return Err("测试时钟倒退".into());
        }
        let dt = time - self.time;
        self.time = time;
        self.messages.clear();
        let properties = &mut self.properties;
        for (event, state) in self.script.events.iter().zip(self.states.iter_mut()) {
            // Supported expressions have no side effects. Completed one-shot
            // events need no further work; keep the control tick allocation-free.
            if state.triggered
                && !event.persistent
                && !event.continuous
                && state.transitioning.iter().all(|v| !*v)
                && (!event.notify || state.notified)
            {
                continue;
            }
            if Self::condition_at(properties, time, &event.condition) == Some(true) {
                if !state.triggered {
                    state.start = time + event.delay;
                    state.notified = false;
                    state.values.clear();
                    state.transitioning.clear();
                    for s in &event.sets {
                        let original = properties
                            .get(&s.path)
                            .copied()
                            .ok_or_else(|| format!("属性不存在：{}", s.path))?;
                        let v = Self::expression_at(properties, time, &s.value)
                            .ok_or_else(|| format!("表达式不可用：{}", s.path))?;
                        let target = if s.kind == "delta" { original + v } else { v };
                        if !target.is_finite() {
                            return Err("数值溢出".into());
                        }
                        state.values.push((original, target));
                        state.transitioning.push(true);
                    }
                }
                state.triggered = true;
            } else if event.persistent || event.continuous {
                state.triggered = false;
            }
            if state.triggered && time + 1e-9 >= state.start {
                for (i, s) in event.sets.iter().enumerate() {
                    if !state.transitioning[i] {
                        continue;
                    }
                    let (original, target) = state.values[i];
                    let t = (time - state.start).max(0.);
                    let value = match s.action.as_str() {
                        "ramp" => {
                            if t >= s.tc && !event.continuous {
                                state.transitioning[i] = false;
                            }
                            original + (target - original) * (t / s.tc).min(1.)
                        }
                        "exp" => original + (target - original) * (1. - (-t / s.tc).exp()),
                        _ => {
                            if !event.continuous {
                                state.transitioning[i] = false;
                            }
                            if event.continuous && !matches!(s.value, Expr::Value(_)) {
                                Self::expression_at(properties, time, &s.value)
                                    .ok_or("连续表达式不可用")?
                            } else {
                                target
                            }
                        }
                    };
                    if !value.is_finite() {
                        return Err("属性计算溢出".into());
                    }
                    properties.insert(s.path.clone(), value);
                }
                if event.notify && !state.notified {
                    let mut message = event.name.clone();
                    if !event.description.is_empty() {
                        message.push_str(" · ");
                        message.push_str(&event.description);
                    }
                    for (caption, expression) in &event.notify_properties {
                        message.push_str(&format!(
                            " · {caption}={}",
                            Self::expression_at(properties, time, expression)
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| "未知".into())
                        ));
                    }
                    self.messages.push(message);
                    state.notified = true;
                }
            }
        }
        self.update_altitude(dt)?;
        self.update_attitude(dt)?;
        self.update_manual(dt)?;
        self.update_heading(dt)
    }
    pub fn needs_manual_takeoff(&self) -> bool {
        self.properties
            .keys()
            .any(|key| key.starts_with("test/input/") && key.ends_with("/height-climb-max-mps"))
    }
    pub fn needs_attitude(&self) -> bool {
        self.properties
            .keys()
            .any(|key| key.starts_with("test/input/") && (key.ends_with("/angle-roll-deg") || key.ends_with("/recover-reference") || key.ends_with("/heading-target-deg")))
    }
    pub fn needs_heading(&self) -> bool { self.properties.iter().any(|(key,value)| key.ends_with("/heading-target-deg") || (key.ends_with("/recover-heading") && *value == 1.)) }
    pub fn needs_recovery(&self) -> bool { self.properties.keys().any(|key| key.ends_with("/recover-reference")) }
    fn update_heading(&mut self, dt: f64) -> Result<(),String> {
        let owners: Vec<_> = self.properties.keys().filter_map(|key| key.strip_suffix("/heading-target-deg"))
            .filter(|base| base.starts_with("test/input/") && self.value(&format!("{base}/enabled")) == Some(1.))
            .map(str::to_owned).collect();
        self.headings.retain(|owner,_| owners.contains(owner)); self.set("test/heading/active",0.);
        if owners.is_empty() { return Ok(()); }
        self.inputs()?;
        if self.heading.is_none() { self.heading = Some(manual::origin(&self.properties)?.heading); }
        let origin = manual::origin(&self.properties)?;
        let mode = self.value("test/fc/mode").ok_or("缺少航向模式反馈")?;
        let kind = self.value("test/rc/input-kind").unwrap_or(1.);
        if self.heading_anchor.is_none_or(|(m,k,_)| m != mode || k != kind) {
            self.heading_anchor = Some((mode,kind,[origin.x,origin.y]));
        }
        for owner in owners {
            if self.value(&format!("{owner}/mask")) != Some(7.) { return Err("航向步进只能占用三个姿态轴".into()); }
            let output = self.headings.entry(owner.clone()).or_insert_with(heading::Controller::new)
                .update(&self.properties,&owner,self.heading.unwrap(),self.heading_anchor.unwrap().2,dt)?;
            for (axis,value) in [("roll",0.),("pitch",0.),("yaw",output.yaw)] { self.set(&format!("{owner}/{axis}-norm"),value); }
            self.set(&format!("test/heading/{}/status",owner.trim_start_matches("test/input/")),output.done as u8 as f64);
            self.set("test/heading/target-rad",output.target);
            for (key,value) in [("active",1.),("target-deg",output.target.to_degrees()),
                ("relative-target-deg",self.value(&format!("{owner}/heading-target-deg")).unwrap()),
                ("error-deg",output.error),("held-s",output.held),("position-error-m",output.position_error)] {
                self.set(&format!("test/heading/{key}"),value);
            }
        }
        Ok(())
    }
    fn update_manual(&mut self, dt: f64) -> Result<(), String> {
        let owners: Vec<_> = self.properties.keys().filter_map(|key| key.strip_suffix("/recover-reference"))
            .filter(|base| base.starts_with("test/input/") && self.value(&format!("{base}/enabled")) == Some(1.)).map(str::to_owned).collect();
        self.manual.retain(|owner, _| owners.contains(owner));
        self.set("test/manual/active", 0.);
        if owners.is_empty() { return Ok(()); }
        self.inputs()?;
        for owner in owners {
            if self.value(&format!("{owner}/mask")) != Some(7.) { return Err("手动回位只能占用三个姿态轴".into()); }
            let reference = self.value(&format!("{owner}/recover-reference"));
            if ![Some(1.), Some(2.), Some(3.)].contains(&reference) { return Err("回位原点选项无效".into()); }
            if !self.manual.contains_key(&owner) && reference == Some(1.) {
                let origin = manual::origin(&self.properties)?;
                self.manual_origin = Some(origin); self.heading = Some(origin.heading);
                self.heading_anchor = None;
                for (key,value) in [("origin-x-m",origin.x),("origin-y-m",origin.y),("heading-deg",origin.heading.to_degrees())] {
                    self.set(&format!("test/reference/{key}"),value);
                }
                if self.needs_heading() { self.set("test/heading/target-rad",origin.heading); }
            }
            let origin = match self.manual_origin {
                Some(origin) => origin,
                None if reference == Some(3.) => manual::origin(&self.properties)?,
                None => return Err("回位尚未记录原点，请先运行记录原点并稳定".into()),
            };
            if self.value(&format!("{owner}/recover-heading")) == Some(1.) { self.set("test/heading/target-rad",origin.heading); }
            let output = self.manual.entry(owner.clone()).or_insert_with(manual::Controller::new).update(&self.properties, &owner, origin, dt)?;
            let yaw = if let Some(target) = self.value("test/heading/target-rad") {
                heading::yaw_stick(&self.properties,target,10.)?
            } else { 0. };
            for (axis, value) in [("roll", output.sticks[0]), ("pitch", output.sticks[1]), ("yaw", yaw)] { self.set(&format!("{owner}/{axis}-norm"), value); }
            self.set(&format!("test/manual/{}/status", owner.trim_start_matches("test/input/")), output.done as u8 as f64);
            // Reset only the physical command seed. The planned sweep target
            // remains untouched so the next loop increment is still 5, 10, ...
            self.set("test/attitude/command-roll-deg", output.command[0]);
            self.set("test/attitude/command-pitch-deg", output.command[1]);
            for (key, value) in [("active", 1.), ("phase", output.phase), ("origin-x-m", origin.x), ("origin-y-m", origin.y),
                ("position-error-m", output.distance), ("speed-mps", output.speed), ("target-speed-mps", output.target_speed),
                ("acceleration-trim-north-mps2", output.acceleration_trim[0]), ("acceleration-trim-east-mps2", output.acceleration_trim[1]),
                ("held-s", output.held), ("command-roll-deg", output.command[0]), ("command-pitch-deg", output.command[1])] { self.set(&format!("test/manual/{key}"), value); }
        }
        Ok(())
    }
    fn update_attitude(&mut self, dt: f64) -> Result<(), String> {
        let owners: Vec<String> = self
            .properties
            .keys()
            .filter_map(|key| key.strip_suffix("/angle-roll-deg"))
            .filter(|base| {
                base.starts_with("test/input/")
                    && self.value(&format!("{base}/enabled")) == Some(1.)
            })
            .map(str::to_owned)
            .collect();
        self.attitude.retain(|owner, _| owners.contains(owner));
        // Completion belongs to the block until its following FGScript tick consumes it.
        for key in ["active", "aux1-norm", "aux2-norm"] {
            self.set(&format!("test/attitude/{key}"), 0.);
        }
        if owners.is_empty() {
            return Ok(());
        }
        self.inputs()?;
        if self.heading.is_none() {
            self.heading = Some(attitude::heading(attitude::quaternion(&self.properties)?));
        }
        if self.value("test/fc/mode") == Some(3.)
            && self.value("test/rc/input-kind") != Some(1.)
            && self.value("test/profile/origin-x-m").is_none()
        {
            for axis in ["x", "y"] {
                let value = self
                    .value(&format!("test/fc/local-{axis}-m"))
                    .ok_or("定点姿态扫描缺少本地位置反馈")?;
                self.set(&format!("test/profile/origin-{axis}-m"), value);
            }
        }
        for owner in owners {
            if self.value(&format!("{owner}/mask")) != Some(7.) {
                return Err("姿态角步进只能占用三个姿态轴".into());
            }
            let output = self
                .attitude
                .entry(owner.clone())
                .or_insert_with(attitude::Controller::new)
                .update(&self.properties, &owner, self.heading.unwrap(), dt)?;
            for (i, axis) in ["roll", "pitch", "yaw"].iter().enumerate() {
                self.set(&format!("{owner}/{axis}-norm"), output.sticks[i]);
            }
            let id = owner.trim_start_matches("test/input/");
            self.set(
                &format!("test/attitude/{id}/status"),
                output.done as u8 as f64,
            );
            for (key, value) in [
                ("active", 1.),
                (
                    "roll-target-deg",
                    self.value(&format!("{owner}/angle-roll-deg")).unwrap(),
                ),
                (
                    "pitch-target-deg",
                    self.value(&format!("{owner}/angle-pitch-deg")).unwrap(),
                ),
                ("error-deg", output.error),
                ("held-s", output.held),
                ("aux1-norm", output.aux[0]),
                ("aux2-norm", output.aux[1]),
                ("position-error-m", output.position_error),
                ("command-roll-deg", output.command[0]),
                ("command-pitch-deg", output.command[1]),
                ("input-range-deg", output.input_limit),
                ("input-kind", output.input_kind),
                ("mode", self.value("test/fc/mode").unwrap_or(0.)),
                ("trim-roll-norm", output.trim[0]),
                ("trim-pitch-norm", output.trim[1]),
                ("input-saturated", output.saturated as u8 as f64),
            ] {
                self.set(&format!("test/attitude/{key}"), value);
            }
        }
        Ok(())
    }
    pub fn aux(&self) -> [f64; 2] {
        [
            self.value("test/attitude/aux1-norm").unwrap_or(0.),
            self.value("test/attitude/aux2-norm").unwrap_or(0.),
        ]
    }
    pub fn needs_rc_channels(&self) -> bool {
        self.properties.keys().any(|p| p.starts_with("test/channel/rc") || p.starts_with("test/channel/vector-switch/")) || self.needs_vector_rates()
    }
    pub fn needs_vector_rates(&self) -> bool {
        super::channels::VECTOR_TARGETS.iter().any(|target|
            self.properties.contains_key(&format!("test/channel/{target}/enabled")))
    }
    pub fn manual_control_compatible(&self) -> Result<(),String> {
        if self.needs_vector_rates() {
            return Err("矢量速率通道需要完整 RC 帧与 COM_RC_IN_MODE=0".into());
        }
        if self.properties.keys().any(|p|p.starts_with("test/channel/rc")) {
            return Err("MANUAL_CONTROL 不支持任意原始 RC1～18 通道；请使用 AUX 或逻辑矢量模式开关".into());
        }
        Ok(())
    }
    pub fn manual_buttons(&self) -> Result<u16,String> {
        Ok(self.channel_value("vector-switch")?.is_some_and(|v|v>0.) as u16)
    }
    pub fn manual_outputs(&mut self) -> Result<([f64;6],u16),String> {
        self.manual_control_compatible()?;
        let (aux,_) = self.channel_outputs(8)?;
        self.properties.retain(|k,_|!k.starts_with("test/output/rc"));
        let buttons=self.manual_buttons()?;
        self.set("test/output/vector-enabled",(buttons&1) as f64);
        Ok((aux,buttons))
    }
    pub fn needs_vector_switch(&self) -> bool {
        self.properties.keys().any(|p| p.starts_with("test/channel/vector-switch/"))
    }
    pub fn required_aux(&self) -> [bool; 6] {
        let paths: Vec<_> = self.script.events.iter().flat_map(|e| &e.sets)
            .filter(|s| s.path == "test/rc/input-kind").collect();
        let vector_angles = self.needs_attitude() && ((paths.is_empty() && self.value("test/rc/input-kind") != Some(1.))
            || paths.iter().any(|s| !matches!(s.value, super::xml::Expr::Value(1.))));
        std::array::from_fn(|i| (vector_angles && i < 2) || self.properties.keys().any(|p| p.starts_with(&format!("test/channel/aux{}/", i + 1))))
    }
    fn channel_value(&self, target: &str) -> Result<Option<f64>, String> {
        match self.value(&format!("test/channel/{target}/enabled")).unwrap_or(0.) {
            0. => Ok(None),
            1. => {
                let value = self.value(&format!("test/channel/{target}/value-norm")).ok_or("通道缺少 value-norm")?;
                if !(-1. ..=1.).contains(&value) { return Err("通道值超出 −100%～100%".into()); }
                Ok(Some(value))
            }
            _ => Err("通道 enabled 须为 0 或 1".into()),
        }
    }
    pub fn channel_outputs(&mut self, vector_channel: usize) -> Result<([f64; 6], [Option<f64>; 18]), String> {
        self.mapped_channel_outputs(vector_channel, [0; 3])
    }
    pub fn mapped_channel_outputs(&mut self, vector_channel: usize, rate_channels: [usize; 3]) -> Result<([f64; 6], [Option<f64>; 18]), String> {
        let mut aux = [0.; 6];
        aux[..2].copy_from_slice(&self.aux());
        let mut rc = [None; 18];
        self.properties.retain(|k, _| !k.starts_with("test/output/"));
        for (i, output) in aux.iter_mut().enumerate() {
            if let Some(value) = self.channel_value(&format!("aux{}", i + 1))? {
                if i < 2 && self.value("test/attitude/active") == Some(1.)
                    && self.value("test/attitude/input-kind") != Some(1.) {
                    return Err(format!("AUX{} 通道控制与矢量姿态输入冲突，请先释放该通道", i + 1));
                }
                *output = value;
                self.set(&format!("test/output/aux{}-norm", i + 1), value);
            }
        }
        for (i, output) in rc.iter_mut().enumerate() {
            *output = self.channel_value(&format!("rc{}", i + 1))?;
        }
        if let Some(value) = self.channel_value("vector-switch")? {
            if !(1..=18).contains(&vector_channel) { return Err("矢量模式开关未配置 RC_MAP_VECTOR_SW".into()); }
            if rc[vector_channel - 1].is_some() { return Err("矢量模式开关与同一 RC 通道重复控制".into()); }
            rc[vector_channel - 1] = Some(value);
        }
        for (target, channel) in super::channels::VECTOR_TARGETS.into_iter().zip(rate_channels) {
            if let Some(value) = self.channel_value(target)? {
                if !(1..=18).contains(&channel) { return Err(format!("{target} 缺少飞控通道映射")); }
                if rc[channel - 1].is_some() { return Err(format!("{target} 与同一 RC 通道重复控制")); }
                rc[channel - 1] = Some(value);
            }
        }
        for (i, value) in rc.iter().enumerate() {
            if let Some(value) = value { self.set(&format!("test/output/rc{}-norm", i + 1), *value); }
        }
        Ok((aux, rc))
    }
    fn update_altitude(&mut self, dt: f64) -> Result<(), String> {
        let owners: Vec<String> = self
            .properties
            .keys()
            .filter_map(|key| key.strip_suffix("/height-target-m"))
            .filter(|base| {
                base.starts_with("test/input/")
                    && self.value(&format!("{base}/enabled")) == Some(1.)
            })
            .map(str::to_owned)
            .collect();
        self.altitude.retain(|owner, _| owners.contains(owner));
        self.properties
            .retain(|key, _| !key.starts_with("test/altitude/"));
        if owners.is_empty() {
            return Ok(());
        }
        // Validate axis ownership before computing any feedback output.
        self.inputs()?;
        for owner in owners {
            let takeoff = self
                .value(&format!("{owner}/height-climb-max-mps"))
                .is_some();
            if self.value(&format!("{owner}/mask")) != Some(if takeoff { 15. } else { 8. }) {
                return Err("油门控高模块只能占用油门轴".into());
            }
            let baseline = self.value("test/rc/throttle-norm").unwrap_or(0.5);
            let controller = self
                .altitude
                .entry(owner.clone())
                .or_insert_with(|| Controller::new(baseline));
            let output = controller.update(&self.properties, &owner, dt)?;
            self.set(&format!("{owner}/throttle-norm"), output.throttle);
            if takeoff {
                self.set(
                    &format!(
                        "test/altitude/{}/status",
                        owner.trim_start_matches("test/input/")
                    ),
                    output.done as u8 as f64,
                );
            }

            for (key, value) in [
                ("active", 1.),
                ("target-m", output.target),
                ("error-m", output.error),
                ("throttle-norm", output.throttle),
                ("holding", output.holding as u8 as f64),
                ("takeoff", takeoff as u8 as f64),
                ("climb-command-mps", output.climb_command),
            ] {
                self.set(&format!("test/altitude/{key}"), value);
            }
        }
        Ok(())
    }
    pub fn done(&self) -> bool {
        self.value("test/runtime/complete") == Some(1.)
    }
    pub fn failed(&self) -> bool {
        self.value("test/runtime/failed") == Some(1.)
    }
    pub fn inputs(&self) -> Result<Vec<Input>, String> {
        let mut result = Vec::new();
        let mut used = 0u8;
        for (path, value) in &self.properties {
            if !path.starts_with("test/input/") || !path.ends_with("/enabled") || *value == 0. {
                continue;
            }
            if *value != 1. {
                return Err("输入 enabled 须为 0 或 1".into());
            }
            let base = path.trim_end_matches("/enabled");
            let mask = self.value(&format!("{base}/mask")).ok_or("输入缺少 mask")?;
            if mask.fract() != 0. || !(1.0..=15.).contains(&mask) {
                return Err("控制轴 mask 无效".into());
            }
            let mask = mask as u8;
            if used & mask != 0 {
                return Err(format!("并行控制冲突：重复控制轴 mask={}", used & mask));
            }
            used |= mask;
            let mut values = [0.; 4];
            for (i, a) in ["roll", "pitch", "yaw", "throttle"].iter().enumerate() {
                values[i] = self
                    .value(&format!("{base}/{a}-norm"))
                    .unwrap_or(if i == 3 { 0.5 } else { 0. });
                if !values[i].is_finite()
                    || values[i] > (1.)
                    || values[i] < (if i == 3 { 0. } else { -1. })
                {
                    return Err(format!("{a} 杆量超出范围"));
                }
            }
            result.push(Input {
                owner: base.into(),
                mask,
                values,
            });
        }
        Ok(result)
    }
    pub fn rc(&self) -> Result<[f64; 4], String> {
        let mut result = [0.; 4];
        for (i, a) in ["roll", "pitch", "yaw", "throttle"].iter().enumerate() {
            result[i] = self
                .value(&format!("test/rc/{a}-norm"))
                .unwrap_or(if i == 3 { 0.5 } else { 0. });
            if !(if i == 3 { 0. } else { -1. }..=1.).contains(&result[i]) {
                return Err("基准杆量超出范围".into());
            }
        }
        for input in self.inputs()? {
            for (i, value) in input.values.iter().enumerate() {
                if input.mask & (1 << i) != 0 {
                    result[i] = *value;
                }
            }
        }
        Ok(result)
    }
    pub fn commands(&self) -> Result<Vec<Command>, String> {
        let mut result = Vec::new();
        for (path, v) in &self.properties {
            if path.starts_with("test/command/") && path.ends_with("/request") && *v != 0. {
                if *v != 1. {
                    return Err("指令 request 须为 0 或 1".into());
                }
                let base = path.trim_end_matches("/request");
                let kind = self.value(&format!("{base}/kind")).ok_or("指令缺少 kind")?;
                let argument = self.value(&format!("{base}/argument")).unwrap_or(0.);
                if kind.fract() != 0. || !(1.0..=5.).contains(&kind) {
                    return Err("飞控指令类型无效".into());
                }
                result.push(Command {
                    owner: base.into(),
                    kind: kind as u8,
                    argument,
                });
            }
        }
        Ok(result)
    }
    pub fn active_flow_nodes(&self) -> impl Iterator<Item = &str> {
        self.properties.iter().filter_map(|(path, value)| {
            let base = path.strip_suffix("/started")?;
            let id = base.strip_prefix("test/flow/")?;
            (*value == 1.
                && self.value(&format!("{base}/done")) != Some(1.)
                && self.value(&format!("{base}/cancelled")) != Some(1.))
                .then_some(id)
        })
    }
    pub fn active_blocks(&self) -> Vec<String> {
        block_ids(self.active_flow_nodes())
    }
}

pub(super) fn block_ids<'a>(nodes: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut blocks = Vec::new();
    for (id, _) in nodes.filter_map(|node| node.rsplit_once('_')) {
        if !id.is_empty() && !blocks.iter().any(|block| block == id) {
            blocks.push(id.to_owned());
        }
    }
    blocks
}
