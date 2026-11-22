//! Pilot-like braking and return using MANUAL roll/pitch sticks and measured NED velocity.
use super::attitude;
use std::collections::BTreeMap;

#[derive(Clone, Copy)]
pub struct Origin {
    pub x: f64,
    pub y: f64,
    pub heading: f64,
}
pub struct Controller {
    mode: Option<f64>,
    braking: bool,
    stable: f64,
    command: Option<[f64; 2]>,
    velocity: Option<[f64; 2]>,
    desired: Option<[f64; 2]>,
    velocity_integral: [f64; 2],
}
pub struct Output {
    pub sticks: [f64; 2],
    pub command: [f64; 2],
    pub distance: f64,
    pub speed: f64,
    pub target_speed: f64,
    pub held: f64,
    pub phase: f64,
    pub done: bool,
    pub acceleration_trim: [f64; 2],
}
fn required(values: &BTreeMap<String, f64>, key: &str) -> Result<f64, String> {
    values
        .get(key)
        .copied()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("手动回位缺少最新位置、速度或配置：{key}"))
}
pub fn origin(values: &BTreeMap<String, f64>) -> Result<Origin, String> {
    Ok(Origin {
        x: required(values, "test/fc/local-x-m")?,
        y: required(values, "test/fc/local-y-m")?,
        heading: attitude::heading(attitude::quaternion(values)?),
    })
}
fn bounded(value: [f64; 2], limit: f64) -> [f64; 2] {
    let scale = (limit / value[0].hypot(value[1]).max(1e-12)).min(1.);
    [value[0] * scale, value[1] * scale]
}
impl Controller {
    pub fn new() -> Self {
        Self {
            mode: None,
            braking: true,
            stable: 0.,
            command: None,
            velocity: None,
            desired: None,
            velocity_integral: [0.; 2],
        }
    }
    pub fn update(
        &mut self,
        v: &BTreeMap<String, f64>,
        base: &str,
        anchor: Origin,
        dt: f64,
    ) -> Result<Output, String> {
        let mode = required(v, "test/fc/mode")?;
        let reference = v.get(&format!("{base}/recover-reference")).copied().unwrap_or(2.);
        if ![1.,2.,3.].contains(&mode)
            || required(v, "test/fc/armed")? != 1.
            || required(v, "test/fc/landed")? != 0.
        {
            return Err("回位需要已解锁、已离地的 MANUAL / ALTCTL / POSCTL 模式".into());
        }
        let expected_mode = v.get(&format!("{base}/recover-mode")).copied().unwrap_or(0.);
        if expected_mode != 0. && expected_mode != mode { return Err("回位当前飞行模式与所选参数不符".into()); }
        if mode == 3. && reference == 2. { return Err("定点回位请选‘仅刹停并稳定’，固定原点返回用于 MANUAL / ALTCTL".into()); }
        if self.mode.is_some_and(|previous| previous != mode) { return Err("回位期间飞行模式发生变化".into()); }
        self.mode = Some(mode);
        if (mode != 3. && required(v, "test/rc/input-kind")? != 1.) || required(v, "test/altitude/active")? != 1. {
            return Err("手动回位需要普通主杆输入，并行运行油门控高模块".into());
        }
        let get = |key: &str, min: f64, max: f64| -> Result<f64, String> {
            let x = required(v, &format!("{base}/{key}"))?;
            if !(min..=max).contains(&x) {
                return Err(format!("手动回位参数越界：{key}"));
            }
            Ok(x)
        };
        let tolerance = get("recover-position-m", 0.1, 2.)?;
        let zero_speed = get("recover-speed-mps", 0.05, 0.5)?;
        let settle = get("recover-settle-s", 1., 10.)?;
        let max_speed = get("recover-max-speed-mps", 0.3, 5.)?;
        let max_tilt = get("recover-max-tilt-deg", 3., 20.)?.min(if mode == 2. {
            required(v,"test/profile/altitude-tilt-deg")?
        } else { 90. });
        let max_acceleration =
            get("recover-acceleration-mps2", 0.2, 3.)?.min(9.80665 * max_tilt.to_radians().tan());
        let rate = get("recover-rate-deg-s", 5., 60.)?;
        let q = attitude::quaternion(v)?;
        let velocity = [
            required(v, "test/fc/local-vx-mps")?,
            required(v, "test/fc/local-vy-mps")?,
        ];
        let position = [
            required(v, "test/fc/local-x-m")?,
            required(v, "test/fc/local-y-m")?,
        ];
        let offset = [anchor.x - position[0], anchor.y - position[1]];
        let distance = offset[0].hypot(offset[1]);
        let speed = velocity[0].hypot(velocity[1]);
        // LOCAL_POSITION_NED normally arrives at 10 Hz. Suppress its sample
        // steps before velocity feedback can excite the inner attitude loop.
        let alpha = dt.clamp(0., 0.1) / (0.3 + dt.clamp(0., 0.1));
        let previous_velocity = self.velocity.unwrap_or(velocity);
        let filtered_velocity = [
            previous_velocity[0] + alpha * (velocity[0] - previous_velocity[0]),
            previous_velocity[1] + alpha * (velocity[1] - previous_velocity[1]),
        ];
        self.velocity = Some(filtered_velocity);
        if speed <= zero_speed.max(0.3) {
            self.braking = false;
        }
        let target_velocity = if self.braking || reference == 3. {
            [0.; 2]
        } else {
            bounded(
                [0.3 * offset[0], 0.3 * offset[1]],
                max_speed.min((2. * max_acceleration * distance).sqrt()),
            )
        };
        let velocity_error = [
            target_velocity[0] - filtered_velocity[0],
            target_velocity[1] - filtered_velocity[1],
        ];
        // A pilot trims the small steady error after braking. A proportional
        // velocity loop alone can stop outside the position tolerance when
        // estimated level differs slightly from physical level (or in wind).
        // Learn at low speed, including the end of braking far from home.
        // Otherwise a level bias can leave a residual speed just above the
        // brake->return threshold forever. Freeze during fast motion and the
        // long return transit so the stimulus cannot wind up this term.
        if speed < 1. && (self.braking || distance < 5.) {
            self.velocity_integral = bounded([
                self.velocity_integral[0] + 0.12 * velocity_error[0] * dt.clamp(0., 0.1),
                self.velocity_integral[1] + 0.12 * velocity_error[1] * dt.clamp(0., 0.1),
            ], 0.5);
        }
        let acceleration = bounded(
            [
                0.65 * velocity_error[0] + self.velocity_integral[0],
                0.65 * velocity_error[1] + self.velocity_integral[1],
            ],
            max_acceleration,
        );
        // NED accelerations -> heading-relative tilt: positive pitch brakes
        // forward motion, positive roll accelerates to the body's right.
        let yaw = attitude::heading(q);
        let (sy, cy) = yaw.sin_cos();
        let forward = cy * acceleration[0] + sy * acceleration[1];
        let right = -sy * acceleration[0] + cy * acceleration[1];
        let desired = bounded(
            [
                (right / 9.80665).atan().to_degrees(),
                (-forward / 9.80665).atan().to_degrees(),
            ],
            max_tilt,
        );
        // Preserve the command at handover. Clipping a preceding 45° stimulus
        // to the recovery tilt bound would create an unslewed command jump.
        // max_tilt bounds the braking/return target, not the initial attitude.
        let previous = self.command.unwrap_or([
            v.get("test/attitude/command-roll-deg").copied().unwrap_or(0.),
            v.get("test/attitude/command-pitch-deg").copied().unwrap_or(0.),
        ]);
        let alpha = dt.clamp(0., 0.1) / (0.25 + dt.clamp(0., 0.1));
        let filtered = self.desired.unwrap_or(previous);
        let desired = [
            filtered[0] + alpha * (desired[0] - filtered[0]),
            filtered[1] + alpha * (desired[1] - filtered[1]),
        ];
        self.desired = Some(desired);
        let step = rate * dt.clamp(0., 0.1);
        let change = bounded([desired[0] - previous[0], desired[1] - previous[1]], step);
        let command = if mode == 3. { [0.,0.] } else { [previous[0] + change[0], previous[1] + change[1]] };
        self.command = Some(command);
        let input_limit = v
            .get("test/profile/manual-tilt-deg")
            .copied()
            .filter(|n| n.is_finite() && *n > 0.)
            .unwrap_or(45.);
        let tilt = (1. - 2. * (q[1] * q[1] + q[2] * q[2]))
            .clamp(-1., 1.)
            .acos()
            .to_degrees();
        let angular_speed = ["roll-rate-rad-s", "pitch-rate-rad-s", "yaw-rate-rad-s"]
            .iter()
            .map(|key| required(v, &format!("test/fc/{key}")))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .map(|x| x * x)
            .sum::<f64>()
            .sqrt()
            .to_degrees();
        if tilt > 60. || angular_speed > 120. {
            return Err(format!(
                "手动回位出现异常姿态响应：倾角 {tilt:.1}°，角速度 {angular_speed:.1}°/s，终止测试"
            ));
        }
        let heading_ok = v.get("test/heading/target-rad").is_none_or(|target|
            super::heading::wrap(*target - yaw).to_degrees().abs() <= 3.);
        let stable = (reference == 3. || distance <= tolerance) && heading_ok
            && speed <= zero_speed
            && tilt <= 3.
            && angular_speed <= 3.
            && required(v, "test/altitude/error-m")?.abs() <= 0.5
            && required(v, "test/fc/climb-rate-mps")?.abs() <= 0.3;
        if stable {
            self.stable += dt.clamp(0., 0.1);
        } else {
            self.stable = 0.;
        }
        let done = self.stable >= settle;
        Ok(Output {
            sticks: [
                if mode == 2. { (command[0].to_radians().tan() / input_limit.to_radians().min(89f64.to_radians()).tan()).clamp(-1.,1.) } else { (command[0] / input_limit).clamp(-1.,1.) },
                if mode == 2. { (-command[1].to_radians().tan() / input_limit.to_radians().min(89f64.to_radians()).tan()).clamp(-1.,1.) } else { (-command[1] / input_limit).clamp(-1.,1.) },
            ],
            command,
            distance,
            speed,
            target_speed: target_velocity[0].hypot(target_velocity[1]),
            held: self.stable.min(settle),
            phase: if done {
                3.
            } else if stable {
                2.
            } else if self.braking || reference == 3. {
                0.
            } else {
                1.
            },
            done,
            acceleration_trim: self.velocity_integral,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_removes_steady_position_error_with_a_level_estimate_bias() {
        let dt = 0.02;
        for heading in [0_f64, 1.3] { for fast_braking in [false, true] {
            let (s, c) = heading.sin_cos();
            let mut position = if fast_braking { [90., -30.] } else { [1.2, -0.8] };
            let mut velocity = if fast_braking { [8_f64, -4.] } else { [0.; 2] };
            let mut estimated_tilt = if fast_braking { [0_f64, 25.] } else { [0.; 2] };
            let mut rates = [0_f64; 2];
            // Without low-speed braking trim this bias creates a residual
            // speed above 0.3 m/s, so the return phase is never entered.
            let bias = [1.2, -0.8];
            let mut v = BTreeMap::new();
            for (key, value) in [("mode", 1.), ("armed", 1.), ("landed", 0.), ("climb-rate-mps", 0.), ("yaw-rate-rad-s", 0.)] {
                v.insert(format!("test/fc/{key}"), value);
            }
            for (key, value) in [("test/rc/input-kind", 1.), ("test/altitude/active", 1.), ("test/altitude/error-m", 0.), ("test/profile/manual-tilt-deg", 45.)] {
                v.insert(key.into(), value);
            }
            v.insert("test/attitude/command-pitch-deg".into(), estimated_tilt[1]);
            for (key, value) in [("recover-position-m", 0.5), ("recover-speed-mps", 0.2), ("recover-settle-s", 2.), ("recover-max-speed-mps", 3.), ("recover-max-tilt-deg", 20.), ("recover-acceleration-mps2", 3.), ("recover-rate-deg-s", 30.)] {
                v.insert(format!("test/input/return/{key}"), value);
            }
            let mut controller = Controller::new();
            let mut done = false;
            for step in 0..6000 {
                if step % 5 == 0 {
                    for (key, value) in [("local-x-m", position[0]), ("local-y-m", position[1]), ("local-vx-mps", velocity[0]), ("local-vy-mps", velocity[1])] {
                        v.insert(format!("test/fc/{key}"), value);
                    }
                }
                for (i, value) in attitude::target(heading, estimated_tilt[0], estimated_tilt[1]).into_iter().enumerate() {
                    v.insert(format!("test/fc/q{}", i + 1), value);
                }
                v.insert("test/fc/roll-rate-rad-s".into(), rates[0]);
                v.insert("test/fc/pitch-rate-rad-s".into(), rates[1]);
                let out = controller.update(&v, "test/input/return", Origin { x: 0., y: 0., heading }, dt).unwrap();
                assert!(out.acceleration_trim[0].hypot(out.acceleration_trim[1]) <= 0.500001);
                if out.done { done = true; break; }
                for i in 0..2 {
                    let old = estimated_tilt[i];
                    let demand = out.sticks[i] * 45. * if i == 0 { 1. } else { -1. };
                    estimated_tilt[i] += (demand - old) * dt / (0.18 + dt);
                    rates[i] = (estimated_tilt[i] - old).to_radians() / dt;
                }
                // Physical level is offset from the estimator; the controller
                // sees only estimated attitude and sampled position/velocity.
                let forward = -9.80665 * (estimated_tilt[1] - bias[1]).to_radians().tan();
                let right = 9.80665 * (estimated_tilt[0] - bias[0]).to_radians().tan();
                let acceleration = [c * forward - s * right - 0.12 * velocity[0], s * forward + c * right - 0.12 * velocity[1]];
                for i in 0..2 { velocity[i] += acceleration[i] * dt; position[i] += velocity[i] * dt; }
            }
            assert!(done, "heading={heading}, fast_braking={fast_braking}, position={position:?}, velocity={velocity:?}");
            assert!(position[0].hypot(position[1]) <= 0.5 && velocity[0].hypot(velocity[1]) <= 0.2);
        }}
    }
    #[test]
    fn recover_from_large_stimulus_and_drift_without_a_handover_step() {
        let dt = 0.02;
        for axis in 0..2 { for heading in [0_f64, 1.3] {
            let (s,c) = heading.sin_cos();
            let body = if axis == 0 { [0.,1.] } else { [-1.,0.] };
            let direction = [c*body[0]-s*body[1], s*body[0]+c*body[1]];
            let mut position = [55.*direction[0],55.*direction[1]];
            let mut velocity = [20.*direction[0],20.*direction[1]];
            let mut tilt = [0_f64;2]; tilt[axis] = 45.;
            let mut rates = [0_f64;2]; let mut previous = tilt;
            let mut controller = Controller::new(); let mut v = BTreeMap::new();
            for (key,value) in [("mode",1.),("armed",1.),("landed",0.),("climb-rate-mps",0.),("yaw-rate-rad-s",0.)] { v.insert(format!("test/fc/{key}"),value); }
            for (key,value) in [("test/rc/input-kind",1.),("test/altitude/active",1.),("test/altitude/error-m",0.),("test/profile/manual-tilt-deg",45.),("test/attitude/command-roll-deg",tilt[0]),("test/attitude/command-pitch-deg",tilt[1])] { v.insert(key.into(),value); }
            for (key,value) in [("recover-position-m",0.5),("recover-speed-mps",0.2),("recover-settle-s",2.),("recover-max-speed-mps",3.),("recover-max-tilt-deg",20.),("recover-acceleration-mps2",3.),("recover-rate-deg-s",30.)] { v.insert(format!("test/input/return/{key}"),value); }
            let mut done = false;
            for step in 0..6000 {
                // Independent plant: lagged attitude, drag, and NED feedback
                // sampled at only 10 Hz. No firmware or synthetic HIL verdict.
                if step%5==0 { for (key,value) in [("local-x-m",position[0]),("local-y-m",position[1]),("local-vx-mps",velocity[0]),("local-vy-mps",velocity[1])] { v.insert(format!("test/fc/{key}"),value); } }
                let q = attitude::target(heading,tilt[0],tilt[1]);
                for (i,value) in q.into_iter().enumerate() { v.insert(format!("test/fc/q{}",i+1),value); }
                v.insert("test/fc/roll-rate-rad-s".into(),rates[0]);v.insert("test/fc/pitch-rate-rad-s".into(),rates[1]);
                let out = controller.update(&v,"test/input/return",Origin{x:0.,y:0.,heading},dt).unwrap();
                let change = (out.command[0]-previous[0]).hypot(out.command[1]-previous[1]);
                assert!(change <= 30.*dt+1e-8,"handover skipped slew: {change}"); previous=out.command;
                if out.done { done=true;break; }
                for i in 0..2 { let old=tilt[i];let demand=out.sticks[i]*45.*if i==0 {1.} else {-1.};tilt[i]+=(demand-old)*dt/(0.18+dt);rates[i]=(tilt[i]-old).to_radians()/dt; }
                let forward=-9.80665*tilt[1].to_radians().tan();let right=9.80665*tilt[0].to_radians().tan();
                let acc=[c*forward-s*right-0.12*velocity[0],s*forward+c*right-0.12*velocity[1]];
                for i in 0..2 {velocity[i]+=acc[i]*dt;position[i]+=velocity[i]*dt;}
            }
            assert!(done,"axis={axis} heading={heading} position={position:?} velocity={velocity:?}");
            assert!(position[0].hypot(position[1])<=0.5 && velocity[0].hypot(velocity[1])<=0.2);
        }}
    }
}
