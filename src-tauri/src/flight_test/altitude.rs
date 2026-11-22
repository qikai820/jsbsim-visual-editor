use std::collections::BTreeMap;

/// Adjust a MANUAL_CONTROL throttle stick using measured height and climb rate.
/// The flight controller keeps responsibility for attitude and motor allocation.
pub struct Controller {
    mode: u8,
    integral: f64,
    output: f64,
    stable: f64,
}

pub struct Output {
    pub throttle: f64,
    pub error: f64,
    pub target: f64,
    pub holding: bool,
    pub done: bool,
    pub climb_command: f64,
}

struct Config {
    target: f64,
    tolerance: f64,
    hover: f64,
    min: f64,
    max: f64,
    slew: f64,
    kp: f64,
    kd: f64,
    ki: f64,
    deadzone: f64,
}

fn required(values: &BTreeMap<String, f64>, key: &str) -> Result<f64, String> {
    values
        .get(key)
        .copied()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("油门控高缺少最新反馈或配置：{key}"))
}

impl Config {
    fn read(values: &BTreeMap<String, f64>, base: &str) -> Result<Self, String> {
        let get = |name: &str, min: f64, max: f64| -> Result<f64, String> {
            let v = required(values, &format!("{base}/{name}"))?;
            if !(min..=max).contains(&v) {
                return Err(format!("油门控高参数越界：{name}"));
            }
            Ok(v)
        };
        let c = Self {
            target: get("height-target-m", 0.5, 1000.)?,
            tolerance: get("height-tolerance-m", 0.05, 5.)?,
            hover: get("height-hover-norm", 0.05, 0.95)?,
            min: get("height-min-norm", 0., 0.49)?,
            max: get("height-max-norm", 0.51, 1.)?,
            slew: get("height-slew-norm-s", 0.01, 1.)?,
            kp: get("height-kp", 0.001, 1.)?,
            kd: get("height-kd", 0., 1.)?,
            ki: get("height-ki", 0., 0.2)?,
            deadzone: get("height-deadzone-norm", 0., 0.2)?,
        };
        if !(c.min..=c.max).contains(&c.hover) || c.deadzone > (0.5 - c.min).min(c.max - 0.5) {
            return Err("油门控高悬停杆位或中位死区不在油门限制内".into());
        }
        Ok(c)
    }
}

impl Controller {
    pub fn new(baseline: f64) -> Self {
        Self {
            mode: 0,
            integral: 0.,
            output: baseline,
            stable: 0.,
        }
    }

    pub fn update(
        &mut self,
        values: &BTreeMap<String, f64>,
        base: &str,
        dt: f64,
    ) -> Result<Output, String> {
        let config = Config::read(values, base)?;
        let mode = required(values, "test/fc/mode")?;
        if ![1., 2., 3., 7.].contains(&mode) {
            return Err("油门控高需要 MANUAL、ALTCTL、POSCTL 或 STABILIZED 模式".into());
        }
        if required(values, "test/fc/armed")? != 1. {
            return Err("油门控高需要先解锁飞控".into());
        }
        if self.mode != 0 && self.mode != mode as u8 {
            return Err("油门控高期间飞行模式发生变化，请重新启动测试".into());
        }
        self.mode = mode as u8;
        let takeoff = values.contains_key(&format!("{base}/height-climb-max-mps"));
        if takeoff && self.mode != 1 {
            return Err("手动油门起飞需要 MANUAL 模式".into());
        }
        let height = required(values, "test/fc/relative-alt-m")?;
        let climb = required(values, "test/fc/climb-rate-mps")?;
        let error = config.target - height;
        let effective_error = if error.abs() <= config.tolerance {
            0.
        } else {
            error
        };
        let holding = effective_error == 0. && climb.abs() <= 0.15;
        let mut climb_command = 0.;
        let dt = dt.clamp(0., 0.1);
        let correction = config.kp * effective_error - config.kd * climb;
        let target = if takeoff {
            let max_climb = required(values, &format!("{base}/height-climb-max-mps"))?;
            let settle = required(values, &format!("{base}/height-settle-s"))?;
            if !(0.1..=2.).contains(&max_climb) || !(1.0..=10.).contains(&settle) {
                return Err("手动起飞爬升速度或稳定时间无效".into());
            }
            climb_command = (0.6 * effective_error).clamp(-max_climb, max_climb);
            let velocity_error = climb_command - climb;
            let candidate = (self.integral + config.ki * velocity_error * dt).clamp(-0.2, 0.2);
            let raw = config.hover + config.kd * velocity_error + candidate;
            if (config.min..=config.max).contains(&raw)
                && (raw - self.output).abs() <= config.slew * dt + 0.02
            {
                self.integral = candidate;
            }
            if holding && required(values, "test/fc/landed")? == 0. {
                self.stable += dt;
            } else {
                self.stable = 0.;
            }
            config.hover + config.kd * velocity_error + self.integral
        } else if self.mode == 1 || self.mode == 7 {
            // Integral trim compensates for a hover-stick estimate and model loading error.
            // Do not accumulate against output saturation or a slew-rate constraint.
            let candidate = (self.integral + config.ki * effective_error * dt).clamp(-0.2, 0.2);
            let raw = config.hover + correction + candidate;
            if (config.min..=config.max).contains(&raw)
                && (raw - self.output).abs() <= config.slew * dt + 0.02
                || raw > config.max && effective_error < 0.
                || raw < config.min && effective_error > 0.
            {
                self.integral = candidate;
            }
            config.hover + correction + self.integral
        } else if holding {
            0.5
        } else {
            // ALTCTL/POSCTL interpret the center as zero climb. Cross the configured
            // stick deadzone only when requesting a correction, then return to center.
            0.5 + correction
                + if correction.abs() > 1e-9 {
                    correction.signum() * config.deadzone
                } else {
                    0.
                }
        };
        let target = target.clamp(config.min, config.max);
        self.output = (self.output
            + (target - self.output).clamp(-config.slew * dt, config.slew * dt))
        .clamp(config.min, config.max);
        if !self.output.is_finite() {
            return Err("油门控高计算结果无效".into());
        }
        let done = takeoff && self.stable >= required(values, &format!("{base}/height-settle-s"))?;
        Ok(Output {
            throttle: self.output,
            error,
            target: config.target,
            holding,
            done,
            climb_command,
        })
    }
}
