//! Quaternion arrival checks for existing vector manual-stick/AUX angle inputs.
//! No custom firmware interface marker is required.
use std::collections::BTreeMap;

pub type Quaternion = [f64; 4];
pub fn multiply(a: Quaternion, b: Quaternion) -> Quaternion {
    [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ]
}
pub fn target(heading: f64, roll: f64, pitch: f64) -> Quaternion {
    let (s, c) = (heading / 2.).sin_cos();
    let (sr, cr) = (roll.to_radians() / 2.).sin_cos();
    let (sp, cp) = (pitch.to_radians() / 2.).sin_cos();
    // Rz(heading) Rx(roll) Ry(pitch); single-axis sweeps remain continuous past 90°.
    multiply(multiply([c, 0., 0., s], [cr, sr, 0., 0.]), [cp, 0., sp, 0.])
}
fn required(v: &BTreeMap<String, f64>, key: &str) -> Result<f64, String> {
    v.get(key)
        .copied()
        .filter(|x| x.is_finite())
        .ok_or_else(|| format!("姿态角步进缺少最新反馈或配置：{key}"))
}
pub fn quaternion(v: &BTreeMap<String, f64>) -> Result<Quaternion, String> {
    let mut q = [0.; 4];
    for (i, x) in q.iter_mut().enumerate() {
        *x = required(v, &format!("test/fc/q{}", i + 1))?;
    }
    let norm = q.iter().map(|x| x * x).sum::<f64>().sqrt();
    if !(0.9..=1.1).contains(&norm) {
        return Err("飞控姿态四元数无效".into());
    }
    for x in &mut q {
        *x /= norm;
    }
    Ok(q)
}
pub fn heading(q: Quaternion) -> f64 {
    (2. * (q[0] * q[3] + q[1] * q[2])).atan2(1. - 2. * (q[2] * q[2] + q[3] * q[3]))
}
pub struct Controller {
    mode: u8,
    stable: f64,
    command: Option<[f64; 2]>,
    trim: Option<[f64; 2]>,
}
pub struct Output {
    pub sticks: [f64; 4],
    pub aux: [f64; 2],
    pub error: f64,
    pub held: f64,
    pub done: bool,
    pub position_error: f64,
    pub command: [f64; 2],
    pub input_limit: f64,
    pub input_kind: f64,
    pub trim: [f64; 2],
    pub saturated: bool,
}
impl Controller {
    pub fn new() -> Self {
        Self {
            mode: 0,
            stable: 0.,
            command: None,
            trim: None,
        }
    }
    pub fn update(
        &mut self,
        v: &BTreeMap<String, f64>,
        base: &str,
        heading: f64,
        dt: f64,
    ) -> Result<Output, String> {
        let get = |key: &str, min: f64, max: f64| -> Result<f64, String> {
            let x = required(v, &format!("{base}/{key}"))?;
            if !(min..=max).contains(&x) {
                return Err(format!("姿态角步进参数越界：{key}"));
            }
            Ok(x)
        };
        let roll = get("angle-roll-deg", -140., 140.)?;
        let pitch = get("angle-pitch-deg", -140., 140.)?;
        let hold = get("angle-hold-s", 0.1, 60.)?;
        let settle = get("angle-settle-s", 0.1, 5.)?;
        let tolerance = get("angle-tolerance-deg", 0.5, 10.)?;
        let rate = get("angle-rate-deg-s", 1., 30.)?;
        let mode = required(v, "test/fc/mode")?;
        if ![1., 2., 3.].contains(&mode) || required(v, "test/fc/armed")? != 1. {
            return Err("姿态角步进需要已解锁的 MANUAL / ALTCTL / POSCTL".into());
        }
        if self.mode != 0 && self.mode != mode as u8 {
            return Err("姿态角步进期间飞行模式改变".into());
        }
        self.mode = mode as u8;
        if required(v, "test/altitude/active")? != 1. {
            return Err("姿态角步进须并行运行油门控高模块".into());
        }
        let kind = v.get("test/rc/input-kind").copied().unwrap_or(0.);
        if ![0., 1., 2.].contains(&kind) {
            return Err("姿态输入路径须为普通主杆或矢量 AUX".into());
        }
        let normal = kind == 1. || (kind == 0. && self.mode == 1);
        let vector = kind == 2.;
        if vector && self.mode != 3 {
            return Err("矢量 AUX 姿态测试需要 POSCTL 模式".into());
        }
        let limit = if normal {
            45.
        } else if vector {
            140.
        } else if self.mode == 3 {
            120.
        } else {
            45.
        };
        if roll.abs() > limit || pitch.abs() > limit {
            return Err(format!(
                "当前模式姿态测试上限为 ±{limit}°，请重新载入矢量测试脚本"
            ));
        }
        let previous = self.command.unwrap_or([
            v.get("test/attitude/command-roll-deg")
                .copied()
                .unwrap_or(0.),
            v.get("test/attitude/command-pitch-deg")
                .copied()
                .unwrap_or(0.),
        ]);
        let command = [
            previous[0]
                + (roll - previous[0]).clamp(-rate * dt.clamp(0., 0.1), rate * dt.clamp(0., 0.1)),
            previous[1]
                + (pitch - previous[1]).clamp(-rate * dt.clamp(0., 0.1), rate * dt.clamp(0., 0.1)),
        ];
        self.command = Some(command);
        let q = quaternion(v)?;
        let desired = target(heading, roll, pitch);
        let mut error = multiply([q[0], -q[1], -q[2], -q[3]], desired);
        if error[0] < 0. {
            for x in &mut error {
                *x = -*x;
            }
        }
        let sin = error[1..].iter().map(|x| x * x).sum::<f64>().sqrt();
        let angle = 2. * sin.atan2(error[0].clamp(-1., 1.));
        let measured = [
            required(v, "test/fc/roll-rate-rad-s")?,
            required(v, "test/fc/pitch-rate-rad-s")?,
            required(v, "test/fc/yaw-rate-rad-s")?,
        ];
        let speed = measured
            .iter()
            .map(|x| x * x)
            .sum::<f64>()
            .sqrt()
            .to_degrees();
        if normal && self.mode == 1 {
            let tilt = (1. - 2. * (q[1] * q[1] + q[2] * q[2])).clamp(-1., 1.).acos().to_degrees();
            if tilt > 60. || speed > 120. {
                return Err(format!("手动姿态激励异常：倾角 {tilt:.1}°，角速度 {speed:.1}°/s，终止后续激励"));
            }
        }
        let height_ok = required(v, "test/altitude/error-m")?.abs() <= 0.5
            && required(v, "test/fc/climb-rate-mps")?.abs() <= 0.3;
        let manual_stimulus = normal && self.mode == 1;
        if manual_stimulus {
            let height = required(v, "test/fc/relative-alt-m")?;
            let height_error = required(v, "test/altitude/error-m")?;
            let target_height = height + height_error;
            if height_error.abs() > (0.5 * target_height).min(3.) {
                return Err("手动激励高度偏差超限，终止后续激励".into());
            }
        }
        let position_error = if self.mode == 3 && !normal {
            (required(v, "test/fc/local-x-m")? - required(v, "test/profile/origin-x-m")?)
                .hypot(required(v, "test/fc/local-y-m")? - required(v, "test/profile/origin-y-m")?)
        } else {
            0.
        };
        // A short MANUAL stimulus lasts the requested dwell after attitude
        // arrival. Height stabilization belongs to the following recovery;
        // waiting for it here can turn a 2 s stimulus into 12 s of acceleration.
        if angle.to_degrees() <= tolerance && speed <= 3. && (manual_stimulus || height_ok) && position_error <= 1. {
            self.stable += dt.clamp(0., 0.1);
        } else {
            self.stable = 0.;
        }
        let held = (self.stable - settle).max(0.).min(hold);
        // Manual/Stabilized mapping is tilt on the core sticks. Assisted
        // vector modes use independent AUX angle targets; neither is a rate input.
        let mut sticks = [0., 0., 0., 0.5];
        let mut aux = [0.; 2];
        let fallback = if normal {
            45.
        } else if vector {
            140.
        } else {
            120.
        };
        let path = if normal {
            "test/profile/manual-tilt-deg"
        } else {
            "test/profile/aux-angle-deg"
        };
        let input_limit = v
            .get(path)
            .copied()
            .filter(|x| x.is_finite() && *x > 0.)
            .unwrap_or(fallback);
        let mut trim = self
            .trim
            .unwrap_or(if v.get("test/attitude/mode") == Some(&mode) {
                [
                    v.get("test/attitude/trim-roll-norm").copied().unwrap_or(0.),
                    v.get("test/attitude/trim-pitch-norm")
                        .copied()
                        .unwrap_or(0.),
                ]
            } else {
                [0.; 2]
            });
        if normal {
            let mut demand = [command[0] / input_limit, command[1] / input_limit];
            if self.mode != 1 {
                let mut feedback = multiply(
                    [q[0], -q[1], -q[2], -q[3]],
                    target(heading, command[0], command[1]),
                );
                if feedback[0] < 0. {
                    for x in &mut feedback {
                        *x = -*x;
                    }
                }
                let sine = feedback[1..].iter().map(|x| x * x).sum::<f64>().sqrt();
                let rotation = 2. * sine.atan2(feedback[0]);
                for axis in 0..2 {
                    let error = if sine > 1e-9 {
                        feedback[axis + 1] * rotation / sine
                    } else {
                        0.
                    };
                    let candidate =
                        (trim[axis] + 0.18 * error * dt.clamp(0., 0.1)).clamp(-0.35, 0.35);
                    let raw = demand[axis] + 0.6 * error + candidate - 0.04 * measured[axis];
                    if (-1.0..=1.).contains(&raw)
                        || (raw > 1. && error < 0.)
                        || (raw < -1. && error > 0.)
                    {
                        trim[axis] = candidate;
                    }
                    demand[axis] += 0.6 * error + trim[axis] - 0.04 * measured[axis];
                }
            } else {
                trim = [0.; 2];
            }
            sticks[0] = demand[0].clamp(-1., 1.);
            sticks[1] = -demand[1].clamp(-1., 1.);
        } else {
            aux = [
                (command[0] / input_limit).clamp(-1., 1.),
                (command[1] / input_limit).clamp(-1., 1.),
            ];
            trim = [0.; 2];
        }
        self.trim = Some(trim);
        let saturated = angle.to_degrees() > tolerance
            && (sticks[0].abs() >= 0.999
                || sticks[1].abs() >= 0.999
                || aux[0].abs() >= 0.999
                || aux[1].abs() >= 0.999);
        Ok(Output {
            sticks,
            aux,
            error: angle.to_degrees(),
            held,
            done: self.stable + 1e-8 >= settle + hold,
            position_error,
            command,
            input_limit,
            input_kind: if normal { 1. } else { 2. },
            trim,
            saturated,
        })
    }
}
