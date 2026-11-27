//! Calibrated receiver emulation and legacy supplemental RC switch frames.
//! PX4 publishes RC_CHANNELS_OVERRIDE as a complete input_rc sample, so ignored
//! channels cannot preserve an earlier sample. Send all 18 channels, retaining
//! sampled unowned channels or calibrated trim. PX4 still selects the input source.
use super::mavlink::Telemetry;
use std::time::Instant;

pub const VECTOR_TARGETS: [&str; 3] = ["vector-roll-rate", "vector-pitch-rate", "level-switch"];
pub const VECTOR_PARAMETERS: [&str; 3] = ["RC_MAP_VEC_ROLL", "RC_MAP_VEC_PITCH", "RC_MAP_LEVEL_SW"];

pub const VECTOR_RESERVED: [&str; 4] = ["RC_MAP_FLTMODE", "RC_MAP_KILL_SW", "RC_MAP_ARM_SW", "RC_MAP_RETURN_SW"];

pub fn target(name: &str) -> bool {
    name == "vector-switch" || VECTOR_TARGETS.contains(&name)
        || (1..=18).any(|i| name == format!("rc{i}"))
        || (1..=6).any(|i| name == format!("aux{i}"))
}
pub fn parameter_names(vector: bool) -> Vec<String> {
    let mut names = Vec::new();
    if vector {
        names.push("RC_MAP_VECTOR_SW".into());
    }
    for i in 1..=18 {
        for suffix in ["MIN", "TRIM", "MAX", "REV"] {
            names.push(format!("RC{i}_{suffix}"));
        }
    }
    names
}
pub fn is_parameter(name: &str) -> bool {
    VECTOR_PARAMETERS.contains(&name) || VECTOR_RESERVED.contains(&name) || ["RC_CHAN_CNT", "RC_MAP_ROLL", "RC_MAP_PITCH", "RC_MAP_YAW", "RC_MAP_THROTTLE", "RC_MAP_VECTOR_SW", "RC_MAP_LEVEL_SW"].contains(&name)
        || (1..=6).any(|i| name == format!("RC_MAP_AUX{i}"))
        || name
            .strip_prefix("RC")
            .and_then(|v| v.split_once('_'))
            .is_some_and(|(i, suffix)| {
                i.parse::<usize>().is_ok_and(|i| (1..=18).contains(&i))
                    && ["MIN", "TRIM", "MAX", "REV"].contains(&suffix)
            })
}
pub struct RcProfile {
    calibration: [[f64; 4]; 18],
    pub vector_channel: usize,
    pub vector_rate_channels: [usize; 3],
    receiver: Option<ReceiverMapping>,
}
struct ReceiverMapping {
    sticks: [usize; 4],
    aux: [usize; 6],
    baseline: [u16; 18],
}
pub fn receiver_parameter_names() -> Vec<String> {
    let mut names = parameter_names(false);
    names.extend(["RC_CHAN_CNT", "RC_MAP_ROLL", "RC_MAP_PITCH", "RC_MAP_YAW", "RC_MAP_THROTTLE", "RC_MAP_VECTOR_SW", "RC_MAP_LEVEL_SW"].map(str::to_owned));
    names.extend((1..=6).map(|i| format!("RC_MAP_AUX{i}")));
    names
}
impl RcProfile {
    pub fn from_telemetry(
        t: &Telemetry,
        since: Instant,
        vector: bool,
    ) -> Result<Self, String> {
        let get = |name: &str| -> Result<f64, String> {
            t.params
                .get(name)
                .filter(|(v, _, at)| v.is_finite() && *at >= since)
                .map(|p| p.0)
                .ok_or_else(|| format!("RC 通道控制缺少本次读取的参数 {name}"))
        };
        let mapped = if vector { get("RC_MAP_VECTOR_SW")? } else { 0. };
        if mapped.fract() != 0. || !(0. ..=18.).contains(&mapped) || (vector && mapped == 0.) {
            return Err("请先配置 RC_MAP_VECTOR_SW（1～18）后使用矢量模式开关".into());
        }
        let mut calibration = [[0.; 4]; 18];
        for (i, c) in calibration.iter_mut().enumerate() {
            for (j, suffix) in ["MIN", "TRIM", "MAX", "REV"].iter().enumerate() {
                c[j] = get(&format!("RC{}_{suffix}", i + 1))?;
            }
            if !(800. ..=2200.).contains(&c[0])
                || !(800. ..=2200.).contains(&c[2])
                || c[0] >= c[2]
                || c[1] < c[0]
                || c[1] > c[2]
                || ![-1., 1.].contains(&c[3])
            {
                return Err(format!(
                    "RC{} 校准无效，请检查 MIN / TRIM / MAX / REV",
                    i + 1
                ));
            }
        }
        Ok(Self {
            calibration,
            vector_channel: mapped as usize,
            vector_rate_channels: [0; 3],
            receiver: None,
        })
    }
    pub fn receiver_from_telemetry(t: &Telemetry, since: Instant, vector: bool, required_aux: [bool; 6]) -> Result<Self, String> {
        Self::receiver_with_vector_rates(t, since, vector, required_aux, false)
    }

    pub fn receiver_with_vector_rates(t: &Telemetry, since: Instant, vector: bool,
        required_aux: [bool; 6], vector_rates: bool) -> Result<Self, String> {
        let mut profile = Self::from_telemetry(t, since, vector || vector_rates)?;
        let get = |name: &str| -> Result<usize, String> {
            let value = t.params.get(name).filter(|(v, _, at)| v.is_finite() && *at >= since)
                .map(|p| p.0).ok_or_else(|| format!("遥控器模拟缺少本次读取的参数 {name}"))?;
            if value.fract() != 0. || !(0. ..=18.).contains(&value) { return Err(format!("{name} 须为 0～18 的通道编号")); }
            Ok(value as usize)
        };
        if get("RC_CHAN_CNT")? == 0 { return Err("遥控器模拟需要已有 RC 校准（RC_CHAN_CNT > 0），请先完成遥控器校准".into()); }
        let mut used = std::collections::BTreeMap::new();
        let mut mapped = |name: &str, required: bool| -> Result<usize, String> {
            let channel = get(name)?;
            if required && channel == 0 { return Err(format!("遥控器模拟需要配置 {name}（1～18）")); }
            if channel > 0 {
                if let Some(previous) = used.insert(channel, name.to_owned()) { return Err(format!("{name} 与 {previous} 重复映射 RC{channel}")); }
            }
            Ok(channel)
        };
        let mut sticks = [0; 4];
        for (i, name) in ["RC_MAP_ROLL", "RC_MAP_PITCH", "RC_MAP_YAW", "RC_MAP_THROTTLE"].iter().enumerate() { sticks[i] = mapped(name, true)?; }
        // rc_update centers QGC's endpoint throttle trim internally, while the
        // parameter readback still contains the endpoint. Invert that effective
        // calibration rather than trying to use its zero-width half-span.
        let throttle = &mut profile.calibration[sticks[3] - 1];
        if (throttle[3] > 0. && throttle[1] == throttle[0])
            || (throttle[3] < 0. && throttle[1] == throttle[2]) {
            throttle[1] = ((throttle[0] as u16 + throttle[2] as u16) / 2) as f64;
        }
        let mut aux = [0; 6];
        for (i, channel) in aux.iter_mut().enumerate() { *channel = mapped(&format!("RC_MAP_AUX{}", i + 1), required_aux[i])?; }
        profile.vector_channel = mapped("RC_MAP_VECTOR_SW", vector || vector_rates)?;
        if vector_rates {
            for (channel, name) in profile.vector_rate_channels.iter_mut().zip(VECTOR_PARAMETERS) {
                *channel = mapped(name, true)?;
                let c = profile.calibration[*channel - 1];
                if !(c[0] < c[1] && c[1] < c[2]) {
                    return Err(format!("{name} 对应的 RC{channel} 需要有效的中位和双向行程"));
                }
            }
            for name in VECTOR_RESERVED {
                let channel = get(name)?;
                if channel > 0 && profile.vector_rate_channels.iter().chain([&profile.vector_channel]).any(|mapped| *mapped == channel) {
                    return Err(format!("{name} 与矢量测试通道重复映射 RC{channel}"));
                }
            }
        } else {
            mapped("RC_MAP_LEVEL_SW", false)?;
        }
        let mut baseline = profile.values(&[None; 18])?;
        // Retain current switch positions when available; never copy invalid/lost channels.
        if let Some((raw, at)) = &t.rc_channels {
            if at.elapsed().as_millis() < 1500 {
                for (i, value) in raw.iter().enumerate() {
                    if (800..=2200).contains(value) { baseline[i] = *value; }
                }
            }
        }
        if vector_rates {
            let [roll, pitch, level] = profile.vector_rate_channels;
            let mut safe = [None; 18];
            safe[roll - 1] = Some(0.);
            safe[pitch - 1] = Some(0.);
            safe[level - 1] = Some(-1.);
            safe[profile.vector_channel - 1] = Some(-1.);
            let pwm = profile.values(&safe)?;
            for (i, value) in safe.iter().enumerate() {
                if value.is_some() { baseline[i] = pwm[i]; }
            }
        }
        profile.receiver = Some(ReceiverMapping { sticks, aux, baseline });
        Ok(profile)
    }
    pub fn receiver_values(&self, sticks: [f64; 4], aux: [f64; 6], channels: &[Option<f64>; 18]) -> Result<[u16; 18], String> {
        let mapping = self.receiver.as_ref().ok_or("缺少遥控器输入映射")?;
        let mut merged = *channels;
        let mut set = |channel: usize, value: f64, label: &str| -> Result<(), String> {
            if channel == 0 {
                if value != 0. { return Err(format!("{label} 未配置 RC 通道映射")); }
            } else {
                if merged[channel - 1].is_some() { return Err(format!("RC{channel} 通道控制与 {label} 映射冲突")); }
                merged[channel - 1] = Some(value);
            }
            Ok(())
        };
        for (i, label) in ["Roll", "Pitch", "Yaw", "Throttle"].iter().enumerate() {
            set(mapping.sticks[i], if i == 3 { sticks[i] * 2. - 1. } else { sticks[i] }, label)?;
        }
        for (i, value) in aux.iter().enumerate() { set(mapping.aux[i], *value, &format!("AUX{}", i + 1))?; }
        let calibrated = self.values(&merged)?;
        Ok(std::array::from_fn(|i| if merged[i].is_some() { calibrated[i] } else { mapping.baseline[i] }))
    }
    pub fn values(&self, channels: &[Option<f64>; 18]) -> Result<[u16; 18], String> {
        let mut pwm = [0; 18];
        for (i, c) in self.calibration.iter().enumerate() {
            let v = channels[i].unwrap_or(0.) * c[3];
            if !v.is_finite() || !(-1. ..=1.).contains(&v) {
                return Err("RC 通道值超出 −100%～100%".into());
            }
            let span = if v < 0. { c[1] - c[0] } else { c[2] - c[1] };
            if v != 0. && span == 0. {
                return Err(format!("RC{} 校准无法输出请求方向", i + 1));
            }
            pwm[i] = (c[1] + v * span).round() as u16;
        }
        Ok(pwm)
    }
}
