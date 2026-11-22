//! Relative heading tracking through the selected MANUAL_CONTROL yaw stick.
use super::attitude;
use std::collections::BTreeMap;

pub fn wrap(angle: f64) -> f64 {
    (angle + std::f64::consts::PI).rem_euclid(2. * std::f64::consts::PI) - std::f64::consts::PI
}
fn required(v: &BTreeMap<String, f64>, key: &str) -> Result<f64, String> {
    v.get(key)
        .copied()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("航向测试缺少最新反馈或参数：{key}"))
}
// Invert PX4 expo_deadzone so a requested yaw rate has the same meaning in
// manual, altitude and position modes. The full-stick scale is read from PX4.
pub fn yaw_stick(v: &BTreeMap<String, f64>, target: f64, rate: f64) -> Result<f64, String> {
    let current = attitude::heading(attitude::quaternion(v)?);
    let measured = required(v, "test/fc/yaw-rate-rad-s")?.to_degrees();
    let full = required(v, "test/profile/yaw-max-rate-deg-s")?;
    let deadzone = required(v, "test/profile/stick-deadzone")?;
    if !(1. ..=400.).contains(&full) || !(0. ..0.5).contains(&deadzone) {
        return Err("偏航杆参数无效".into());
    }
    let vector = v.get("test/fc/mode") == Some(&3.) && v.get("test/rc/input-kind") == Some(&2.);
    let cap = if vector {
        rate.min(required(v, "test/profile/vector-heading-rate-deg-s")?)
    } else {
        rate
    }
    .min(full);
    if cap <= 0. {
        return Err("航向变化速率必须大于零".into());
    }
    let demand =
        (1.5 * wrap(target - current).to_degrees() - 0.25 * measured).clamp(-cap, cap) / full;
    if demand.abs() < 1e-6 {
        return Ok(0.);
    }
    let (mut lo, mut hi) = (0., 1.);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.;
        if 0.4 * mid + 0.6 * mid * mid * mid < demand.abs() {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Ok(demand.signum() * (deadzone + (1. - deadzone) * (lo + hi) / 2.))
}

pub struct Controller {
    mode: Option<f64>,
    stable: f64,
    command: Option<f64>,
}
pub struct Output {
    pub yaw: f64,
    pub target: f64,
    pub error: f64,
    pub held: f64,
    pub position_error: f64,
    pub done: bool,
}
impl Controller {
    pub fn new() -> Self {
        Self {
            mode: None,
            stable: 0.,
            command: None,
        }
    }
    pub fn update(
        &mut self,
        v: &BTreeMap<String, f64>,
        base: &str,
        reference: f64,
        anchor: [f64; 2],
        dt: f64,
    ) -> Result<Output, String> {
        let mode = required(v, "test/fc/mode")?;
        if ![1., 2., 3.].contains(&mode)
            || required(v, "test/fc/armed")? != 1.
            || required(v, "test/fc/landed")? != 0.
        {
            return Err("航向测试需要已解锁、已离地的 MANUAL / ALTCTL / POSCTL".into());
        }
        if self.mode.is_some_and(|previous| previous != mode) {
            return Err("航向测试期间模式改变".into());
        }
        self.mode = Some(mode);
        if required(v, "test/altitude/active")? != 1. {
            return Err("航向测试须并行运行油门控高".into());
        }
        let get = |name: &str, min: f64, max: f64| -> Result<f64, String> {
            let x = required(v, &format!("{base}/{name}"))?;
            if !(min..=max).contains(&x) {
                return Err(format!("航向参数越界：{name}"));
            }
            Ok(x)
        };
        let offset = get("heading-target-deg", -180., 180.)?;
        let hold = get("heading-hold-s", 0.1, 60.)?;
        let tolerance = get("heading-tolerance-deg", 0.5, 10.)?;
        let rate = get("heading-rate-deg-s", 1., 30.)?;
        let settle = get("heading-settle-s", 0.1, 5.)?;
        let q = attitude::quaternion(v)?;
        let current = attitude::heading(q);
        let target = wrap(reference + offset.to_radians());
        let previous = self.command.unwrap_or(current);
        let cap = if mode == 3. && v.get("test/rc/input-kind") == Some(&2.) {
            rate.min(required(v, "test/profile/vector-heading-rate-deg-s")?)
        } else {
            rate
        };
        if cap <= 0. {
            return Err("矢量航向速率无效".into());
        }
        let step = cap.to_radians() * dt.clamp(0., 0.1);
        let command = wrap(previous + wrap(target - previous).clamp(-step, step));
        self.command = Some(command);
        let error = wrap(target - current).to_degrees().abs();
        let tilt = (1. - 2. * (q[1] * q[1] + q[2] * q[2]))
            .clamp(-1., 1.)
            .acos()
            .to_degrees();
        let position_error = (required(v, "test/fc/local-x-m")? - anchor[0])
            .hypot(required(v, "test/fc/local-y-m")? - anchor[1]);
        let horizontal_speed =
            required(v, "test/fc/local-vx-mps")?.hypot(required(v, "test/fc/local-vy-mps")?);
        let angular_speed = ["roll-rate-rad-s", "pitch-rate-rad-s", "yaw-rate-rad-s"]
            .iter()
            .map(|key| required(v, &format!("test/fc/{key}")))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .map(|x| x * x)
            .sum::<f64>()
            .sqrt()
            .to_degrees();
        let stable = error <= tolerance
            && wrap(target - command).to_degrees().abs() <= 0.1
            && angular_speed <= 3.
            && tilt <= 3.
            && required(v, "test/altitude/error-m")?.abs() <= 0.5
            && required(v, "test/fc/climb-rate-mps")?.abs() <= 0.3
            && (mode != 3. || (position_error <= 1. && horizontal_speed <= 0.2));
        self.stable = if stable {
            self.stable + dt.clamp(0., 0.1)
        } else {
            0.
        };
        Ok(Output {
            yaw: yaw_stick(v, command, cap)?,
            target,
            error,
            held: (self.stable - settle).max(0.).min(hold),
            position_error,
            done: self.stable + 1e-8 >= settle + hold,
        })
    }
}
