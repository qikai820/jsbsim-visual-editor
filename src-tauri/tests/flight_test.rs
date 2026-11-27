#![allow(dead_code)]
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| e.to_string())?
}
#[path = "../src/serial_assistant.rs"]
mod serial_assistant;
mod tool_transport {
    pub fn manager() -> &'static crate::serial_assistant::SerialManager {
        static M: std::sync::OnceLock<crate::serial_assistant::SerialManager> =
            std::sync::OnceLock::new();
        M.get_or_init(crate::serial_assistant::SerialManager::new)
    }
    pub fn px4_datagram_writer(id: u64) -> Result<crate::serial_assistant::DatagramWriter, String> {
        manager().datagram_writer(id)
    }
}
mod scene_telemetry {
    pub static MORPHQUAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    pub static PAUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    pub fn snapshots() -> Vec<serde_json::Value> {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        vec![
            serde_json::json!({"instance_id":"01","model":if MORPHQUAD.load(std::sync::atomic::Ordering::Relaxed){"MorphQuad"}else{"ball"},"scene_epoch":1,"timestamp":START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64(),"age_ms":0,"state":if PAUSED.load(std::sync::atomic::Ordering::Relaxed){"paused"}else{"running"}}),
        ]
    }
}
#[path = "../src/flight_test/mod.rs"]
mod flight_test;
#[path = "../src/mcp.rs"]
mod mcp;
mod local_sim {
    pub fn mcp_status() -> serde_json::Value { serde_json::json!({"active":false,"bundled":false,"ready":false}) }
}
fn sim_status(_:tauri::AppHandle)->Result<serde_json::Value,String>{Ok(serde_json::json!({}))}
mod mcp_logs {
    #[derive(serde::Serialize)] pub struct Status{pub job_id:u64}
    pub struct Request{pub id:u16,pub expected_size:u32,pub expected_time:u32}
    pub fn validate(_:serde_json::Value)->Result<Request,String>{Err("offline test".into())}
    pub fn status()->Option<Status>{None}
}

fn fixture(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/flight-test-xml.json");
    let source =
        std::fs::read_to_string(path).expect("run node tests/flight-test-compiler.mjs first");
    serde_json::from_str::<serde_json::Value>(&source).unwrap()[name]
        .as_str()
        .unwrap()
        .into()
}
fn engine(name: &str) -> flight_test::engine::Engine {
    let mut e = flight_test::engine::Engine::new(flight_test::xml::parse(&fixture(name)).unwrap());
    e.set("test/runtime/ready", 1.);
    e
}

#[test]
fn normal_position_script_checks_response_and_braking() {
    use flight_test::{engine::Engine, xml};
    let source = include_str!("../../examples/flight-tests/morphquad-attitude/05_posctl_pitch.xml");
    // Feed independent telemetry cases through the production script engine:
    // complete response, no tilt (old vector path), no motion, and no braking.
    for scenario in 0..4 {
        let mut e = Engine::new(xml::parse(source).unwrap());
        for (key, value) in [("test/runtime/ready",1.),("test/fc/armed",1.),
            ("test/fc/landed",0.),("test/fc/mode",3.),("test/fc/relative-alt-m",10.),
            ("test/fc/roll-abs-deg",0.),("test/fc/pitch-abs-deg",0.),("test/fc/groundspeed-mps",0.)] {
            e.set(key, value);
        }
        let mut saw_pulse = false;
        let mut directions = std::collections::BTreeSet::new();
        for i in 0..4000 {
            let pitch = e.rc().unwrap()[1];
            let pulsing = pitch.abs() > 0.1;
            if pulsing { saw_pulse = true; directions.insert(if pitch > 0. {1} else {-1}); }
            e.set("test/fc/pitch-abs-deg", if pulsing && scenario != 1 { 2. } else { 0. });
            let moving = (pulsing && scenario != 2) || (scenario == 3 && saw_pulse);
            e.set("test/fc/groundspeed-mps", if moving { 0.8 } else { 0. });
            let q=if pulsing && scenario!=1 { let h=1_f64.to_radians();[h.cos(),0.,h.sin(),0.] } else {[1.,0.,0.,0.]};
            for (j,value) in q.iter().enumerate(){e.set(&format!("test/fc/q{}",j+1),*value);}
            for key in ["roll-rate-rad-s","pitch-rate-rad-s","yaw-rate-rad-s","local-x-m","local-y-m","local-vy-mps"]{e.set(&format!("test/fc/{key}"),0.);}
            e.set("test/fc/local-vx-mps",if moving{0.8}else{0.});e.set("test/fc/climb-rate-mps",0.);
            e.tick(i as f64 * 0.02).unwrap();
            for c in e.commands().unwrap() {
                assert_eq!(c.kind, 3, "position script must only request the mode");
                e.set(&format!("{}/status", c.owner), 1.);
            }
            assert_eq!(e.manual_buttons().unwrap(), 0, "normal Position keeps Vector off");
            if e.done() || e.failed() { break; }
        }
        if scenario == 0 {
            assert!(e.done() && !e.failed());
            assert_eq!(directions.len(), 2);
            assert!(e.inputs().unwrap().is_empty());
        } else {
            assert!(e.failed() && !e.done(), "scenario {scenario} must fail, not silently pass");
        }
    }
}

#[test]
fn channel_latches_release_and_detect_alias_or_attitude_conflicts() {
    let mut e = engine("channels");
    assert!(e.needs_rc_channels() && e.needs_vector_switch());
    e.tick(0.).unwrap();
    let (aux, rc) = e.channel_outputs(8).unwrap();
    assert_eq!(aux, [0., 0., 0., 0., 0., 0.25]); assert_eq!(rc[7], Some(1.));
    assert_eq!(e.rc().unwrap(), [0., 0., 0., 0.5]);
    e.tick(0.19).unwrap(); assert_eq!(e.channel_outputs(8).unwrap().1[7], Some(1.));
    e.tick(0.2).unwrap(); assert_eq!(e.channel_outputs(8).unwrap().1[7], Some(-1.));
    e.tick(0.4).unwrap();
    let (aux, rc) = e.channel_outputs(8).unwrap();
    assert_eq!(aux, [0.; 6]); assert!(rc.iter().all(Option::is_none));
    assert!(!e.properties.keys().any(|k| k.starts_with("test/output/")));
    e.set("test/channel/aux6/enabled", 2.); assert!(e.channel_outputs(8).unwrap_err().contains("enabled"));
    e.set("test/channel/aux6/enabled", 1.); e.set("test/channel/aux6/value-norm", 1.01);
    assert!(e.channel_outputs(8).unwrap_err().contains("超出"));
    let mut e = engine("channels_conflict"); e.tick(0.).unwrap();
    assert!(e.channel_outputs(8).unwrap_err().contains("重复"));
    let mut e = engine("channels_aux_conflict");
    altitude_feedback(&mut e, 3., 5., 0.); angle_feedback(&mut e, 3., [1., 0., 0., 0.], [0.; 3]);
    e.tick(0.).unwrap(); assert!(e.channel_outputs(8).unwrap_err().contains("冲突"));
    assert!(!flight_test::xml::writable("test/channel/rc19/enabled"));
    assert!(!flight_test::xml::writable("test/channel/aux7/enabled"));
}

#[test]
fn channel_profile_requires_current_mapping_calibration_without_input_mode_gate() {
    use flight_test::{channels::*, mavlink::Telemetry}; use std::time::{Duration, Instant};
    let now = Instant::now(); let mut t = Telemetry::default();
    for name in parameter_names(true) {
        let value = match name.as_str() { "RC_MAP_VECTOR_SW" => 8.,
            n if n.ends_with("_MIN") => 1000., n if n.ends_with("_MAX") => 2000.,
            n if n.ends_with("_REV") => 1., _ => 1500. };
        t.params.insert(name, (value, 0, now));
    }
    t.params.insert("RC8_TRIM".into(), (1520., 0, now));
    t.params.insert("RC8_REV".into(), (-1., 0, now));
    assert!(!parameter_names(true).iter().any(|n| n == "COM_RC_IN_MODE"));
    assert!(!parameter_names(false).iter().any(|n| n == "COM_RC_IN_MODE"));
    assert!(!is_parameter("COM_RC_IN_MODE"));
    let p = RcProfile::from_telemetry(&t, now, true).unwrap();
    let mut inputs = [None; 18]; inputs[7] = Some(0.5);
    let pwm = p.values(&inputs).unwrap(); assert_eq!(pwm[7], 1260); assert_eq!(pwm[0], 1500);
    inputs[7] = Some(-1.); assert_eq!(p.values(&inputs).unwrap()[7], 2000);
    assert!(RcProfile::from_telemetry(&t, now + Duration::from_millis(1), true).is_err());
    for mode in [0., 1., 2., 3., 4.] {
        t.params.insert("COM_RC_IN_MODE".into(), (mode, 0, now - Duration::from_secs(4)));
        RcProfile::from_telemetry(&t, now, true).unwrap();
    }
    t.params.remove("COM_RC_IN_MODE");
    t.params.get_mut("RC_MAP_VECTOR_SW").unwrap().0 = 0.;
    assert!(RcProfile::from_telemetry(&t, now, true).err().unwrap().contains("RC_MAP_VECTOR_SW"));
    RcProfile::from_telemetry(&t, now, false).unwrap();
    t.params.remove("RC_MAP_VECTOR_SW");
    RcProfile::from_telemetry(&t, now, false).unwrap();
    assert!(!parameter_names(false).iter().any(|n|n=="RC_MAP_VECTOR_SW"));
    t.params.remove("RC18_TRIM");
    assert!(RcProfile::from_telemetry(&t, now, false).err().unwrap().contains("RC18_TRIM"));
}

#[test]
fn receiver_mapping_roundtrips_px4_calibration_and_keeps_switch_baseline() {
    use flight_test::{channels::*, mavlink::Telemetry};
    use std::time::Instant;
    let now = Instant::now(); let mut t = Telemetry::default();
    for name in receiver_parameter_names() {
        let value = match name.as_str() {
            "RC_CHAN_CNT" => 18., "RC_MAP_ROLL" => 3., "RC_MAP_PITCH" => 1.,
            "RC_MAP_YAW" => 4., "RC_MAP_THROTTLE" => 2., "RC_MAP_AUX1" => 9.,
            "RC_MAP_AUX2" => 12., "RC_MAP_AUX6" => 18., "RC_MAP_VECTOR_SW" => 8., "RC_MAP_LEVEL_SW" => 7.,
            n if n.starts_with("RC_MAP_") => 0., n if n.ends_with("_MIN") => 1000.,
            n if n.ends_with("_MAX") => 2000., n if n.ends_with("_REV") => 1., _ => 1500.,
        };
        t.params.insert(name, (value, 0, now));
    }
    t.params.get_mut("RC9_TRIM").unwrap().0 = 1520.;
    t.params.get_mut("RC9_REV").unwrap().0 = -1.;
    let mut baseline = [1500; 18]; baseline[4] = 2034; baseline[5] = 1900; baseline[7] = 2000;
    t.rc_channels = Some((baseline, now));
    let p = RcProfile::receiver_from_telemetry(&t, now, true, [true, true, false, false, false, true]).unwrap();
    let mut channels = [None; 18]; channels[7] = Some(-1.);
    let pwm = p.receiver_values([0.2, -0.1, 0.15, 0.7], [0.5, -0.25, 0., 0., 0., 0.25], &channels).unwrap();
    assert_eq!([pwm[2], pwm[0], pwm[3], pwm[1], pwm[8], pwm[11], pwm[17]], [1600, 1450, 1575, 1700, 1260, 1375, 1625]);
    assert_eq!(pwm[5], 1900, "unowned switch retains its sampled position");
    assert_eq!(pwm[4], 2034, "receiver endpoint overshoot retains the switch position rather than replacing it with trim");
    assert_eq!(pwm[7], 1000, "explicit mapped vector switch");
    // Reconstruct AUX1 independently with the exact piecewise scaling used by rc_update.
    let scaled = if pwm[8] < 1520 { (pwm[8] as f64 - 1520.) / 520. } else { (pwm[8] as f64 - 1520.) / 480. };
    assert!((-scaled - 0.5).abs() < 1e-9);
    assert_eq!(p.receiver_values([0., 0., 0., 0.], [0.; 6], &[None; 18]).unwrap()[1], 1000);
    assert_eq!(p.receiver_values([0., 0., 0., 1.], [0.; 6], &[None; 18]).unwrap()[1], 2000);
    let neutral = p.receiver_values([0., 0., 0., 0.5], [0.; 6], &[None; 18]).unwrap();
    assert_eq!([neutral[8], neutral[11], neutral[5]], [1520, 1500, 1900]);
    channels[8] = Some(0.); assert!(p.receiver_values([0.; 4], [0.; 6], &channels).unwrap_err().contains("AUX1"));
    for (name,value) in [("RC_MAP_VEC_ROLL",13.),("RC_MAP_VEC_PITCH",14.),("RC_MAP_FLTMODE",5.),
        ("RC_MAP_KILL_SW",6.),("RC_MAP_ARM_SW",0.),("RC_MAP_RETURN_SW",0.)] {
        t.params.insert(name.to_owned(),(value,0,now));
    }
    t.rc_channels.as_mut().unwrap().0[12] = 2000;
    t.rc_channels.as_mut().unwrap().0[13] = 1000;
    let configured = RcProfile::receiver_with_vector_rates(&t,now,true,[false;6],true).unwrap();
    assert_eq!(configured.vector_rate_channels,[13,14,7]);
    let safe=configured.receiver_values([0.,0.,0.,0.5],[0.;6],&[None;18]).unwrap();
    assert_eq!([safe[12],safe[13],safe[6],safe[7]],[1500,1500,1000,1000]);
    t.params.get_mut("RC_MAP_KILL_SW").unwrap().0=13.;
    assert!(RcProfile::receiver_with_vector_rates(&t,now,true,[false;6],true).err().unwrap().contains("RC_MAP_KILL_SW"));
    t.params.get_mut("RC_MAP_AUX2").unwrap().0 = 9.;
    assert!(RcProfile::receiver_from_telemetry(&t, now, true, [true; 6]).err().unwrap().contains("重复"));
    t.params.get_mut("RC_MAP_AUX2").unwrap().0 = 0.;
    assert!(RcProfile::receiver_from_telemetry(&t, now, true, [true; 6]).err().unwrap().contains("RC_MAP_AUX2"));
    t.params.get_mut("RC_CHAN_CNT").unwrap().0 = 0.;
    assert!(RcProfile::receiver_from_telemetry(&t, now, true, [false; 6]).err().unwrap().contains("校准"));
    assert!(!receiver_parameter_names().iter().any(|n| n == "COM_RC_IN_MODE"));
    assert_eq!(engine("manual_recover").required_aux(), [false; 6]);
    assert_eq!(engine("vector140").required_aux(), [true, true, false, false, false, false]);
}

#[test]
fn receiver_throttle_matches_px4_endpoint_trim_correction() {
    use flight_test::{channels::*, mavlink::Telemetry};
    use std::time::Instant;
    let now = Instant::now(); let mut t = Telemetry::default();
    for name in receiver_parameter_names() {
        let value = match name.as_str() {
            "RC_CHAN_CNT" => 18., "RC_MAP_ROLL" => 1., "RC_MAP_PITCH" => 2.,
            "RC_MAP_THROTTLE" => 3., "RC_MAP_YAW" => 4.,
            n if n.starts_with("RC_MAP_") => 0., n if n.ends_with("_MIN") => 1000.,
            n if n.ends_with("_MAX") => 2000., n if n.ends_with("_REV") => 1., _ => 1500.,
        };
        t.params.insert(name, (value, 0, now));
    }
    for (trim, reverse, expected) in [(1000., 1., [1000,1250,1500,1750,2000]), (2000., -1., [2000,1750,1500,1250,1000]), (1400., 1., [1000,1200,1400,1700,2000])] {
        t.params.get_mut("RC3_TRIM").unwrap().0 = trim;
        t.params.get_mut("RC3_REV").unwrap().0 = reverse;
        let p = RcProfile::receiver_from_telemetry(&t, now, false, [false; 6]).unwrap();
        for (throttle, raw) in [0., 0.25, 0.5, 0.75, 1.].into_iter().zip(expected) {
            assert_eq!(p.receiver_values([0.,0.,0.,throttle],[0.;6],&[None;18]).unwrap()[2],raw);
        }
    }
    assert_eq!(t.params["RC3_TRIM"].0, 1400., "mapping never writes device calibration");
}

#[test]
fn receiver_readiness_requires_fresh_echo_and_selected_input_health() {
    use flight_test::mavlink::{Telemetry, Frame};
    use std::time::{Instant, Duration};
    let legacy:flight_test::Options=serde_json::from_value(serde_json::json!({"dryRun":false,"rcEmulation":true,
        "sessionId":1,"system":7,"component":1,"instance":1,"rateHz":50,"clock":"realtime","onFinish":"hold","onAbort":"hold"})).unwrap();
    assert!(flight_test::receiver::select(legacy,1).unwrap_err().contains("无效"),"source selection cannot accidentally use legacy joystick output");
    let now = Instant::now(); let since = now - Duration::from_millis(100);
    let pwm = [1500; 18]; let mut t = Telemetry::default();t.target=Some((7,1));
    t.rc_channels=Some((pwm,now));
    assert!(!flight_test::receiver_feedback_ready(&t,&pwm,since,now));
    let mut p=vec![0;43];p[..4].copy_from_slice(&(1u32<<16).to_le_bytes());p[8..12].copy_from_slice(&(1u32<<16).to_le_bytes());
    t.ingest(&Frame{id:1,system:7,component:1,payload:p,signed:false},now);
    assert!(flight_test::receiver_feedback_ready(&t,&pwm,since,now));
    let mut wrong=pwm;wrong[6]=1600;t.rc_channels=Some((wrong,now));
    assert!(!flight_test::receiver_feedback_ready(&t,&pwm,since,now),"competing RC input must not pass");
    t.rc_channels=Some((pwm,since-Duration::from_millis(1)));
    assert!(!flight_test::receiver_feedback_ready(&t,&pwm,since,now),"cached pre-test echo must not pass");
    t.rc_channels=Some((pwm,now-Duration::from_millis(500)));
    assert!(!flight_test::receiver_feedback_ready(&t,&pwm,now-Duration::from_secs(1),now));
    t.rc_channels=Some((pwm,now));t.rc_health=Some((false,now));
    assert!(!flight_test::receiver_feedback_ready(&t,&pwm,since,now));
    t.rc_health=Some((true,since-Duration::from_millis(1)));
    assert!(!flight_test::receiver_feedback_ready(&t,&pwm,since,now),"cached health must not pass");
}

#[test]
fn channel_mavlink_all_aux_and_rc_extension_offsets() {
    use flight_test::mavlink::*;
    let mut parser = Parser::default();
    let aux = [-1., -0.5, 0., 0.25, 0.5, 1.];
    let frames = parser.push(&manual_with_channels(7, [0., 0., 0., 0.5], aux, 1), true);
    let p = &frames[0].payload; assert_eq!(p[13], 0xfc);
    for (i, v) in aux.iter().enumerate() { assert_eq!(i16::from_le_bytes(p[18+i*2..20+i*2].try_into().unwrap()), (*v*1000.) as i16); }
    let raw = std::array::from_fn(|i| 1000 + i as u16 * 50);
    let frames = parser.push(&rc_channels((7, 1), raw, 2), true); let p = &frames[0].payload;
    assert_eq!(frames[0].id, 70); assert_eq!(&p[16..18], &[7, 1]);
    for (i, v) in raw.iter().enumerate() { let o = if i < 8 {i*2} else {18+(i-8)*2}; assert_eq!(u16::from_le_bytes(p[o..o+2].try_into().unwrap()), *v); }
}

fn altitude_feedback(e: &mut flight_test::engine::Engine, mode: f64, height: f64, climb: f64) {
    for (key, value) in [("armed", 1.), ("mode", mode), ("relative-alt-m", height), ("climb-rate-mps", climb)] {
        e.set(&format!("test/fc/{key}"), value);
    }
}

#[test]
fn altitude_manual_feedback_converges_with_limits_and_disturbances() {
    for mode in [1., 2., 3., 7.] {
        let mut e = engine("altitude");
        let (mut height, mut climb, mut previous) = (0f64, 0f64, 0.5f64);
        let mut worst_tail_error = 0f64;
        for step in 0..2450 {
            let time = step as f64 * 0.02;
            // Independent plant receives sampled 10 Hz telemetry, like the HIL bridge.
            if step % 5 == 0 { altitude_feedback(&mut e, mode, height, climb); }
            e.tick(time).unwrap();
            let u = e.rc().unwrap()[3];
            assert!((0.25..=0.75).contains(&u));
            assert!((u - previous).abs() <= 0.0050001, "stick slew at {time}: {previous} -> {u}");
            previous = u;
            let disturbance = if time > 15. { 0.3 } else { 0. };
            let acceleration = if mode == 1. || mode == 7. {
                // The actual hover point deliberately differs from the configured 50%.
                (u - 0.58) * 20. - 0.4 * climb + disturbance
            } else {
                let offset = u - 0.5;
                let requested = offset.signum() * (offset.abs() - 0.05).max(0.) / 0.45 * 3.;
                (requested - climb) / 0.45 + disturbance
            };
            climb += acceleration * 0.02;
            height += climb * 0.02;
            if height < 0. { height = 0.; climb = climb.max(0.); }
            if time > 35. { worst_tail_error = worst_tail_error.max((height - 5.).abs()); }
        }
        assert!(worst_tail_error < 0.35, "mode {mode}, final h={height:.3}, vz={climb:.3}, tail error={worst_tail_error:.3}");
        assert!(climb.abs() < 0.2, "mode {mode}, unstable final climb {climb}");
        println!("manual altitude plant mode={mode}: final height={height:.3}m climb={climb:.3}m/s tail_error={worst_tail_error:.3}m");
    }
}

#[test]
fn altitude_control_requires_fresh_feedback_and_releases_ownership() {
    for (height, climb, upward) in [(0.,0.,true),(8.,0.,false),(5.,2.,false),(5.,-2.,true)] {
        let mut e=engine("altitude"); altitude_feedback(&mut e,3.,height,climb);e.tick(0.).unwrap();e.tick(0.1).unwrap();
        assert_eq!(e.rc().unwrap()[3]>0.5,upward,"wrong pilot correction at h={height}, climb={climb}");
    }
    for missing in ["relative-alt-m", "climb-rate-mps", "mode", "armed"] {
        let mut e = engine("altitude"); altitude_feedback(&mut e, 3., 0., 0.);
        e.properties.remove(&format!("test/fc/{missing}"));
        assert!(e.tick(0.).unwrap_err().contains("反馈"));
    }
    let mut e = engine("altitude"); altitude_feedback(&mut e, 4., 5., 0.);
    assert!(e.tick(0.).unwrap_err().contains("模式"));
    let mut e = engine("altitude"); altitude_feedback(&mut e, 3., 5., 0.); e.set("test/fc/armed", 0.);
    assert!(e.tick(0.).unwrap_err().contains("解锁"));
    let mut e = engine("altitude_parallel"); altitude_feedback(&mut e, 3., 0., 0.);
    e.tick(0.).unwrap(); e.tick(0.1).unwrap();
    assert_eq!(e.rc().unwrap()[0], 0.2); assert!(e.rc().unwrap()[3] > 0.5);
    let mut e = engine("altitude_conflict"); altitude_feedback(&mut e, 3., 0., 0.);
    assert!(e.tick(0.).unwrap_err().contains("冲突"));
    let mut e = engine("altitude_cancel"); altitude_feedback(&mut e, 3., 0., 0.); e.tick(0.).unwrap();
    e.properties.retain(|key, _| !key.starts_with("test/fc/")); e.tick(2.).unwrap();
    assert!(e.done()); assert!(e.inputs().unwrap().is_empty()); assert_eq!(e.rc().unwrap()[3], 0.5);
    assert_eq!(e.value("test/altitude/active"), None);
    let mut e = engine("altitude"); altitude_feedback(&mut e, 3., 5., 0.); e.tick(0.).unwrap();
    e.set("test/fc/mode", 7.); assert!(e.tick(0.02).unwrap_err().contains("模式发生变化"));
}

#[test]
fn altitude_climb_rate_uses_ned_sign_and_expires() {
    use flight_test::mavlink::*;
    use std::time::{Instant, Duration};
    let now = Instant::now(); let mut t = Telemetry::default();
    t.ingest(&Frame { id:0,system:7,component:1,payload:vec![0,0,3,0,2,12,160,4,3],signed:false }, now);
    let mut p = vec![0u8;28]; p[16..20].copy_from_slice(&5000i32.to_le_bytes()); p[24..26].copy_from_slice(&(-125i16).to_le_bytes());
    t.ingest(&Frame { id:33,system:7,component:1,payload:p,signed:false }, now);
    assert_eq!(t.values(now)["test/fc/relative-alt-m"], 5.);
    assert_eq!(t.values(now)["test/fc/climb-rate-mps"], 1.25);
    assert!(!t.values(now + Duration::from_millis(1501)).contains_key("test/fc/climb-rate-mps"));
}

fn quat_mul(a:[f64;4],b:[f64;4])->[f64;4]{
    [a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]]
}
fn angle_feedback(e:&mut flight_test::engine::Engine,mode:f64,q:[f64;4],rates:[f64;3]){
    altitude_feedback(e,mode,5.,0.);
    e.set("test/profile/manual-tilt-deg",45.);e.set("test/profile/aux-angle-deg",120.);
    e.set("test/fc/local-x-m",0.);e.set("test/fc/local-y-m",0.);
    e.set("test/fc/local-vx-mps",0.);e.set("test/fc/local-vy-mps",0.);e.set("test/fc/landed",0.);
    for (i,x) in q.iter().enumerate(){e.set(&format!("test/fc/q{}",i+1),*x);}
    for (i,key) in ["roll-rate-rad-s","pitch-rate-rad-s","yaw-rate-rad-s"].iter().enumerate(){e.set(&format!("test/fc/{key}"),rates[i]);}
}

#[test]
fn heading_closed_loop_crosses_wrap_and_respects_current_rate_limits() {
    for (mode,kind) in [(1.,1.),(2.,1.),(3.,1.),(3.,2.)] {
        for initial in [170_f64,-175.] {
            let mut e=engine("heading");let mut yaw=initial.to_radians();let mut rate=0_f64;
            let cap=if kind==2.{8.}else{10.};let mut done=false;let mut max_command=0_f64;
            for step in 0..2000 {
                let(hs,hc)=(yaw/2.).sin_cos();angle_feedback(&mut e,mode,[hc,0.,0.,hs],[0.,0.,rate]);
                e.set("test/rc/input-kind",kind);
                for (key,value) in [("yaw-max-rate-deg-s",120.),("stick-deadzone",0.1),("vector-heading-rate-deg-s",8.)] {e.set(&format!("test/profile/{key}"),value);}
                e.tick(step as f64*0.02).unwrap();assert!(!e.failed());
                if e.done(){done=true;break;}
                let stick=e.rc().unwrap()[2];let linear=stick.signum()*((stick.abs()-0.1)/0.9).max(0.);
                let requested=(0.4*linear+0.6*linear.powi(3))*120.;
                max_command=max_command.max(requested.abs());
                rate+=(requested.to_radians()-rate)*(0.02/0.15);yaw+=rate*0.02;
            }
            let error=((initial+30.).to_radians()-yaw+std::f64::consts::PI).rem_euclid(std::f64::consts::TAU)-std::f64::consts::PI;
            assert!(done && error.abs().to_degrees()<=3.,"mode={mode},kind={kind},error={}",error.to_degrees());
            assert!(max_command<=cap+1e-4,"commanded {max_command} > {cap}");
            assert!(e.inputs().unwrap().is_empty());
        }
    }
}

#[test]
fn heading_requires_continuous_stability_and_fresh_feedback() {
    let mut e=engine("heading");let mut done=false;
    for step in 0..300 {
        let yaw=if step==0{0_f64}else{30_f64.to_radians()};let(s,c)=(yaw/2.).sin_cos();
        angle_feedback(&mut e,3.,[c,0.,0.,s],[0.;3]);
        for (key,value) in [("yaw-max-rate-deg-s",120.),("stick-deadzone",0.1),("vector-heading-rate-deg-s",20.)] {e.set(&format!("test/profile/{key}"),value);}
        if step==160{e.set("test/fc/local-x-m",1.2);}
        if step==175{e.set("test/fc/local-vx-mps",0.5);}
        e.tick(step as f64*0.02).unwrap();
        if step<=194{assert!(!e.done(),"a disturbance must restart the complete settle+dwell");}
        if e.done(){done=true;break;}
    }
    assert!(done);
    let mut e=engine("heading");angle_feedback(&mut e,1.,[1.,0.,0.,0.],[0.;3]);
    e.properties.remove("test/fc/q1");assert!(e.tick(0.).unwrap_err().contains("反馈"));
    assert!(!flight_test::xml::writable("test/heading/bheading/status"));
    assert!(!flight_test::xml::writable("test/heading/target-rad"));
}

#[test]
fn four_mode_template_sequences_all_axes_with_one_shared_origin() {
    let source=include_str!("../../examples/flight-tests/morphquad-attitude/10_four_mode_complete.xml");
    let mut e=flight_test::engine::Engine::new(flight_test::xml::parse(source).unwrap());e.set("test/runtime/ready",1.);
    let(mut mode,mut armed,mut landed)=(1.,false,true);
    let mut angles=std::collections::BTreeSet::new();let mut headings=std::collections::BTreeSet::new();
    let mut returns=std::collections::BTreeSet::new();let mut capture_count=0;let mut limits=[0_f64;3];let mut done=false;
    let mut tilt=[0_f64;2];
    let mut commands=std::collections::BTreeSet::new();
    let mut level_requests=0;
    let mut previous_level=false;
    for step in 0..4000 {
        let pulsing=e.inputs().unwrap().iter().any(|input|input.owner.contains("_pulse_"));
        let (aux, rc) = e.mapped_channel_outputs(7,[13,14,8]).unwrap();
        assert_eq!(aux,[0.;6]);
        let rates=[rc[12].unwrap_or(0.),rc[13].unwrap_or(0.)];
        let level=rc[7]==Some(1.);
        level_requests+=(level && !previous_level) as usize;
        previous_level=level;
        for i in 0..2 {
            if rates[i]!=0. {commands.insert((i,rates[i].is_sign_positive()));}
            tilt[i]=if level {0.} else {tilt[i]+rates[i]*2.};
        }
        angle_feedback(&mut e,mode,[1.,0.,0.,0.],[rates[0]*0.4,rates[1]*0.4,0.]);
        for (key,value) in [("test/fc/roll-deg",tilt[0]),("test/fc/pitch-deg",tilt[1]),("test/fc/relative-alt-m",10.),("test/fc/armed",armed as u8 as f64),("test/fc/landed",landed as u8 as f64),
            ("test/fc/local-x-m",5.),("test/fc/local-y-m",-8.),("test/fc/groundspeed-mps",if pulsing{0.8}else{0.}),
            ("test/fc/roll-abs-deg",if pulsing{2.}else{tilt[0].abs()}),("test/fc/pitch-abs-deg",if pulsing{2.}else{tilt[1].abs()}),
            ("test/profile/altitude-tilt-deg",35.),("test/profile/manual-tilt-deg",60.),("test/profile/yaw-max-rate-deg-s",120.),
            ("test/profile/stick-deadzone",0.1),("test/profile/vector-heading-rate-deg-s",20.)] {e.set(key,value);}
        e.tick(step as f64*0.1).unwrap();assert!(!e.failed(),"{:?}",e.messages);
        if e.done(){done=true;break;}
        for c in e.commands().unwrap(){match c.kind{1=>armed=true,3=>mode=c.argument,_=>panic!("unexpected state command")};e.set(&format!("{}/status",c.owner),1.);}
        for input in e.inputs().unwrap(){let owner=&input.owner;
            if e.value(&format!("{owner}/angle-roll-deg")).is_some(){
                angles.insert(owner.clone());
                let peak=e.value(&format!("{owner}/angle-roll-deg")).unwrap().abs().max(e.value(&format!("{owner}/angle-pitch-deg")).unwrap().abs());
                let group=if owner.contains("bfour_manual_"){0}else if owner.contains("bfour_altctl_"){1}else{2};limits[group]=limits[group].max(peak);
                e.set(&format!("test/attitude/{}/status",owner.trim_start_matches("test/input/")),1.);
            }
            if e.value(&format!("{owner}/heading-target-deg")).is_some(){headings.insert(owner.clone());e.set(&format!("test/heading/{}/status",owner.trim_start_matches("test/input/")),1.);}
            if let Some(reference)=e.value(&format!("{owner}/recover-reference")){
                if returns.insert(owner.clone()) && reference==1.{capture_count+=1;}
                e.set(&format!("test/manual/{}/status",owner.trim_start_matches("test/input/")),1.);
            }
        }
        if e.properties.iter().any(|(k,v)|k.contains("bprepare_manual_takeoff")&&k.ends_with("/enabled")&&*v==1.){landed=false;}
    }
    assert!(done);assert_eq!(angles.len(),92);assert_eq!(headings.len(),52);assert_eq!(limits,[35.,20.,0.]);
    assert_eq!(commands.len(),4);
    assert_eq!(level_requests,5);
    assert_eq!(capture_count,1);assert_eq!(e.value("test/manual/origin-x-m"),Some(5.));assert_eq!(e.value("test/manual/origin-y-m"),Some(-8.));
    assert!(e.inputs().unwrap().is_empty());
}
#[test]
fn attitude_quaternion_sweeps_cross_ninety_and_use_mode_specific_manual_channels(){
    for mode in [1.,2.,3.] {for axis in [0,1] {for sign in [-1.,1.] {
        let limit=if mode==3.{120.}else{45.};let mut e=engine("attitude");
        for (key,value) in e.properties.iter_mut(){if key.ends_with("/angle-roll-deg"){*value=if axis==0{sign*limit}else{0.};}if key.ends_with("/angle-pitch-deg"){*value=if axis==1{sign*limit}else{0.};}}
        let mut q=[1.,0.,0.,0.];let mut rate=[0.;3];let mut crossed=false;let mut finished=false;
        for step in 0..2000 {
            angle_feedback(&mut e,mode,q,rate);e.tick(step as f64*0.02).unwrap();
            if e.done(){finished=true;break;}
            assert!(!e.failed());
            let rc=e.rc().unwrap();
            let demand=if mode==1.{assert_eq!(e.aux(),[0.,0.]);(if axis==0{rc[0]}else{-rc[1]})*45.}else{assert_eq!(&rc[..3],&[0.,0.,0.]);e.aux()[axis]*120.};
            let current=2.*q[axis+1].atan2(q[0]);let demand=demand.to_radians();
            let desired=(2.*(demand-current)).clamp(-0.5,0.5);rate[axis]+=(desired-rate[axis])*0.12;
            let norm=rate.iter().map(|x|x*x).sum::<f64>().sqrt();
            let delta=if norm>1e-9{let (s,c)=(norm*0.02/2.).sin_cos();[c,rate[0]/norm*s,rate[1]/norm*s,rate[2]/norm*s]}else{[1.,0.,0.,0.]};q=quat_mul(q,delta);
            crossed|=current.abs()>(limit*0.8f64).to_radians();
        }
        assert!(finished&&crossed,"mode={mode} axis={axis} sign={sign} error={:?}",e.value("test/attitude/error-deg"));
        assert!((q[axis+1]-(limit.to_radians()/2.).sin()*sign).abs()<0.03);
        assert_eq!(e.aux(),[0.,0.]);assert!(e.inputs().unwrap().is_empty());
    }}}
}
#[test]
fn attitude_dwell_resets_on_angle_or_height_loss_and_timeout_fails(){
    let mut e=engine("attitude_hold");
    for step in 0..60{angle_feedback(&mut e,3.,[1.,0.,0.,0.],[0.;3]);if step==30{e.set("test/fc/relative-alt-m",6.);}e.tick(step as f64*0.02).unwrap();assert!(!e.done());}
    assert!(e.value("test/attitude/held-s").unwrap()<0.5);
    for step in 60..95{angle_feedback(&mut e,3.,[1.,0.,0.,0.],[0.;3]);e.tick(step as f64*0.02).unwrap();}
    assert!(e.done());
    let mut position=engine("attitude_hold");
    for step in 0..100{angle_feedback(&mut position,3.,[1.,0.,0.,0.],[0.;3]);if step>0{position.set("test/fc/local-x-m",2.);}position.tick(step as f64*0.02).unwrap();assert!(!position.done());}
    let mut e=engine("attitude_timeout");angle_feedback(&mut e,3.,[1.,0.,0.,0.],[0.;3]);e.tick(0.).unwrap();e.tick(0.51).unwrap();assert!(e.failed());assert!(!e.done());
    let mut e=engine("attitude");angle_feedback(&mut e,3.,[1.,0.,0.,0.],[0.;3]);e.properties.remove("test/fc/q1");assert!(e.tick(0.).unwrap_err().contains("q1"));
}
#[test]
fn short_manual_stimulus_does_not_wait_for_height_settling() {
    let mut e=engine("attitude_hold");
    for step in 0..200 {
        angle_feedback(&mut e,1.,[1.,0.,0.,0.],[0.;3]);
        e.set("test/fc/relative-alt-m",4.);e.set("test/altitude/error-m",1.);
        e.tick(step as f64*0.02).unwrap();
        if e.done(){break;}
    }
    assert!(e.done(),"height settling must not prolong the MANUAL stimulus");
    let mut e=engine("attitude_hold");angle_feedback(&mut e,1.,[1.,0.,0.,0.],[0.;3]);
    e.set("test/fc/relative-alt-m",1.);e.set("test/altitude/error-m",4.);
    assert!(e.tick(0.).unwrap_err().contains("高度偏差超限"));
}
#[test]
fn existing_vector_manual_mapping_saturates_without_claiming_arrival(){
    let mut e=engine("attitude");
    for (key,value) in &mut e.properties{if key.ends_with("/angle-pitch-deg"){*value=45.;}}
    let half=10f64.to_radians();
    for step in 0..251{
        angle_feedback(&mut e,1.,[half.cos(),0.,half.sin(),0.],[0.;3]);
        e.set("test/profile/manual-tilt-deg",20.);e.tick(step as f64*0.02).unwrap();
    }
    assert_eq!(e.rc().unwrap()[1],-1.);assert_eq!(e.aux(),[0.,0.]);
    assert!(!e.done());assert_eq!(e.value("test/attitude/held-s"),Some(0.));
    assert!((e.value("test/attitude/error-deg").unwrap()-25.).abs()<1e-6);
    assert_eq!(e.value("test/attitude/input-range-deg"),Some(20.));
}
#[test]
fn attitude_mavlink_extensions_quaternion_without_custom_interface_guard(){
    use flight_test::mavlink::*;use std::time::Instant;
    let mut parser=Parser::default();
    let frames=parser.push(&manual_with_aux(7,[0.,0.,0.2,0.5],[0.3,-0.4],4),true);let p=&frames[0].payload;
    assert_eq!(p[13],0xfc);assert_eq!(i16::from_le_bytes(p[18..20].try_into().unwrap()),300);assert_eq!(i16::from_le_bytes(p[20..22].try_into().unwrap()),-400);
    let clear=parser.push(&manual(7,[0.,0.,0.,0.5],5),true);assert_eq!(clear[0].payload[13],0xfc);assert!(clear[0].payload[18..30].iter().all(|x|*x==0));
    let now=Instant::now();let mut t=Telemetry::default();t.ingest(&Frame{id:0,system:7,component:1,payload:vec![0,0,3,0,2,12,160,4,3],signed:false},now);
    let mut p=vec![0;48];for (i,x) in [0.5f32,0.,0.8660254,0.,0.,0.1,0.].iter().enumerate(){p[4+i*4..8+i*4].copy_from_slice(&x.to_le_bytes());}
    let wire=encode(31,&p,0);let mut f=parser.push(&wire,true).remove(0);f.system=7;f.component=1;t.ingest(&f,now);
    assert!((t.values(now)["test/fc/q3"]-0.8660254).abs()<1e-6);assert!((t.values(now)["test/fc/pitch-rate-rad-s"]-0.1).abs()<1e-6);
    assert!(!t.values(now+std::time::Duration::from_millis(251)).contains_key("test/fc/q1"));
    assert!(t.params.is_empty());
    t.ingest(&Frame{id:32,system:7,component:1,payload:vec![0;28],signed:false},now);
    flight_test::preflight_feedback(&t,now).unwrap();
    assert!(flight_test::preflight_feedback(&t,now+std::time::Duration::from_millis(251)).unwrap_err().contains("ATTITUDE_QUATERNION"));
    let names=flight_test::preflight_parameter_names(true);
    assert!(!names.contains(&"VEC_HIL_TEST")&&!names.contains(&"GAC_Q_REF_EN"));
    assert!(!names.contains(&"COM_RC_IN_MODE"));
    assert!(flight_test::preflight_parameter_names(false).is_empty());
    for (name,value) in [("MPC_MAN_TILT_MAX",45.),("VEC_REF_EN",0.),("VEC_ATT_MAX",120.)]{
        let mut p=vec![0;25];p[..4].copy_from_slice(&(value as f32).to_le_bytes());p[6..8].copy_from_slice(&1u16.to_le_bytes());p[8..8+name.len()].copy_from_slice(name.as_bytes());p[24]=9;
        t.ingest(&Frame{id:22,system:7,component:1,payload:p,signed:false},now);
    }
    assert_eq!(t.params["VEC_REF_EN"].0,0.);
    flight_test::preflight_feedback(&t,now).unwrap();
    assert!(!flight_test::xml::writable("test/attitude/b1/status"));assert!(!flight_test::xml::writable("test/fc/q1"));
}

#[test]
fn generated_morphquad_suite_is_importable_and_continuously_controls_height(){
    let dir=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/flight-tests/morphquad-attitude");
    let manifest:serde_json::Value=serde_json::from_str(&std::fs::read_to_string(dir.join("suite.json")).unwrap()).unwrap();
    assert_eq!(manifest["model"],"MorphQuad");
    for f in manifest["files"].as_array().unwrap(){
        let script=flight_test::xml::parse(&std::fs::read_to_string(dir.join(f["file"].as_str().unwrap())).unwrap()).unwrap();
        let angles:Vec<_>=script.properties.keys().filter(|k|k.ends_with("/angle-roll-deg")).collect();
        let recoveries=script.properties.keys().filter(|k|k.ends_with("/recover-reference")).count();
        if f["combined"]==true{assert_eq!(angles.len(),246);assert!(script.end>3600.);assert_eq!(script.properties.keys().filter(|k|k.ends_with("/height-target-m")).count(),15);assert_eq!(recoveries,84);}
        if f["mode"].is_string(){
            let motion=f["evaluation"]=="motion-and-braking";
            let vector=f["input"]=="vector";
            assert_eq!(angles.len(),if motion||vector{0}else{37});
            assert_eq!(script.properties.keys().filter(|k|k.ends_with("/height-target-m")).count(),if motion{3}else{1});
            assert_eq!(recoveries,if f["mode"]=="MANUAL"{38}else if motion{3}else if vector{1}else{0});
            if vector {
                let engine=flight_test::engine::Engine::new(script.clone());
                assert!(engine.needs_vector_rates());
                assert_eq!(engine.required_aux(),[false;6]);
                assert!(engine.manual_control_compatible().is_err());
            }
            for (key,value) in &script.properties {if key.ends_with("/angle-hold-s"){assert_eq!(*value,if f["mode"]=="MANUAL"{2.}else{10.});}}
        }
    }
}

#[test]
fn vector_increment_loop_targets_and_manual_altitude_bounds(){
    let mut e=engine("attitude_increment");let mut targets=Vec::new();
    for step in 0..8{
        angle_feedback(&mut e,3.,[1.,0.,0.,0.],[0.;3]);e.tick(step as f64*0.02).unwrap();
        if e.done(){break;}
        let owner=e.inputs().unwrap().into_iter().find(|i|i.mask==7).unwrap().owner;
        targets.push(e.value(&format!("{owner}/angle-pitch-deg")).unwrap());
        e.set(&format!("test/attitude/{}/status",owner.trim_start_matches("test/input/")),1.);
    }
    assert_eq!(targets,vec![0.,10.,20.,10.,0.]);assert!(e.done());assert!(e.inputs().unwrap().is_empty());
    for mode in [1.,2.]{let mut e=engine("attitude");angle_feedback(&mut e,mode,[1.,0.,0.,0.],[0.;3]);assert!(e.tick(0.).unwrap_err().contains("45"));}
}

#[test]
fn complete_suite_sequences_all_stages_and_skips_takeoff_when_airborne(){
    // Mock bridge confirmations exercise the full compiled plan. Controller dwell
    // and quaternion tracking are covered separately with measured feedback.
    let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/flight-tests/morphquad-attitude/morphquad_complete.xml");
    let source=std::fs::read_to_string(path).unwrap();
    for grounded in [true,false]{
        let mut e=flight_test::engine::Engine::new(flight_test::xml::parse(&source).unwrap());e.set("test/runtime/ready",1.);
        let (mut time,mut armed,mut landed,mut mode)=(0.,!grounded,grounded,3.);
        let mut commands=Vec::new();let mut points=std::collections::BTreeSet::new();let mut messages=Vec::new();let mut done=false;
        for _ in 0..2000{
            angle_feedback(&mut e,mode,[1.,0.,0.,0.],[0.;3]);e.set("test/fc/relative-alt-m",10.);e.set("test/fc/armed",armed as u8 as f64);e.set("test/fc/landed",landed as u8 as f64);
            let pulsing=e.inputs().unwrap().iter().any(|input|input.owner.contains("_pulse_"));
            e.set("test/fc/groundspeed-mps",if pulsing{0.8}else{0.});
            e.set("test/fc/roll-abs-deg",if pulsing{2.}else{0.});
            e.set("test/fc/pitch-abs-deg",if pulsing{2.}else{0.});
            e.tick(time).unwrap();messages.extend(e.messages.clone());assert!(!e.failed(),"{messages:?}");
            if e.done(){done=true;break;}
            let active_commands=e.commands().unwrap();assert!(active_commands.is_empty()||e.inputs().unwrap().is_empty(),"mode/state command overlaps input");
            for c in active_commands{commands.push(c.kind);match c.kind{1=>armed=true,3=>mode=c.argument,4=>panic!("automatic takeoff must not be used"),_=>panic!("unexpected command")};e.set(&format!("{}/status",c.owner),1.);}
            let owners:Vec<_>=e.properties.keys().filter_map(|k|k.strip_suffix("/angle-roll-deg")).filter(|base|e.value(&format!("{base}/enabled"))==Some(1.)).map(str::to_owned).collect();
            for owner in owners{points.insert(owner.clone());e.set(&format!("test/attitude/{}/status",owner.trim_start_matches("test/input/")),1.);}
            let recovery:Vec<_>=e.properties.keys().filter_map(|k|k.strip_suffix("/recover-reference")).filter(|base|e.value(&format!("{base}/enabled"))==Some(1.)).map(str::to_owned).collect();
            for owner in recovery{e.set(&format!("test/manual/{}/status",owner.trim_start_matches("test/input/")),1.);}
            if e.properties.iter().any(|(k,v)|k.contains("bprepare_manual_takeoff")&&k.ends_with("/enabled")&&*v==1.){landed=false;}
            time+=0.1;
        }
        assert!(done);assert_eq!(points.len(),246);assert_eq!(commands.iter().filter(|k|**k==1).count(),usize::from(grounded));assert_eq!(commands.iter().filter(|k|**k==4).count(),0);
        assert_eq!(messages.iter().filter(|m|m.contains("阶段 ")&&m.contains("/9")).count(),9);assert!(e.inputs().unwrap().is_empty());assert_eq!(e.aux(),[0.,0.]);
    }
}

#[test]
fn manual_recovery_brakes_and_returns_to_fixed_origin_at_different_headings() {
    for mode in [1.,2.] { for heading in [0., std::f64::consts::FRAC_PI_2, -1.1] {
        let mut e=engine("manual_recover");
        let (mut x,mut y,mut vx,mut vy)=(5f64,-8f64,0f64,0f64);
        let mut tilt=[0f64;2];let mut rates=[0f64;3];let mut kicked=false;let mut finished=false;let mut braking=false;
        for step in 0..3000 {
            let (sh,ch)=(heading/2.).sin_cos();let(sr,cr)=(tilt[0].to_radians()/2.).sin_cos();let(sp,cp)=(tilt[1].to_radians()/2.).sin_cos();
            let q=quat_mul(quat_mul([ch,0.,0.,sh],[cr,sr,0.,0.]),[cp,0.,sp,0.]);
            angle_feedback(&mut e,mode,q,rates);
            for (key,value) in [("local-x-m",x),("local-y-m",y),("local-vx-mps",vx),("local-vy-mps",vy)] {e.set(&format!("test/fc/{key}"),value);}
            e.set("test/profile/manual-tilt-deg",if mode==1.{20.}else{60.});e.set("test/profile/altitude-tilt-deg",35.);e.tick(step as f64*0.02).unwrap();
            assert!(!e.failed(),"heading={heading} x={x} y={y} v={vx},{vy}");
            if e.done(){finished=true;break;}
            let gap=e.properties.iter().any(|(k,v)|k.contains("bgap_")&&k.ends_with("/started")&&*v==1.);
            if gap && !kicked {x+=8.;y-=6.;vx=4.;vy=-3.;kicked=true;}
            if kicked {braking|=e.value("test/manual/phase")==Some(0.);}
            assert!(e.commands().unwrap().is_empty());assert_eq!(e.aux(),[0.,0.]);
            if e.value("test/manual/active")==Some(1.) {
                assert!(e.value("test/manual/target-speed-mps").unwrap()<=3.00001);
                assert!(e.value("test/manual/command-roll-deg").unwrap().hypot(e.value("test/manual/command-pitch-deg").unwrap())<=20.01);
            }
            let rc=e.rc().unwrap();let desired=if mode==1.{[rc[0]*20.,-rc[1]*20.]}else{[(rc[0]*60_f64.to_radians().tan()).atan().to_degrees(),(-rc[1]*60_f64.to_radians().tan()).atan().to_degrees()]};
            for i in 0..2 {let old=tilt[i];tilt[i]+=(desired[i]-tilt[i])*(0.02/0.18);rates[i]=(tilt[i]-old).to_radians()/0.02;}
            // Independent near-hover multicopter dynamics, with attitude lag
            // and drag. All horizontal control is from primary pilot sticks.
            let forward=-9.80665*tilt[1].to_radians().tan();let right=9.80665*tilt[0].to_radians().tan();let(s,c)=heading.sin_cos();
            vx+=(c*forward-s*right-0.12*vx)*0.02;vy+=(s*forward+c*right-0.12*vy)*0.02;x+=vx*0.02;y+=vy*0.02;
        }
        assert!(finished&&kicked&&braking,"h={heading} x={x} y={y} v={vx},{vy}");
        assert!((x-5.).hypot(y+8.)<=0.5);assert!(vx.hypot(vy)<=0.2);
        assert_eq!(e.value("test/manual/origin-x-m"),Some(5.));assert_eq!(e.value("test/manual/origin-y-m"),Some(-8.));
        assert!(e.inputs().unwrap().is_empty());
    }
}
}

#[test]
fn manual_recovery_gates_completion_and_preserves_loop_angle_targets() {
    let mut unstable=engine("manual_recover_capture");angle_feedback(&mut unstable,1.,[1.,0.,0.,0.],[0.,2.2,0.]);
    assert!(unstable.tick(0.).unwrap_err().contains("异常姿态响应"));
    let mut boundary=engine("manual_recover_capture");angle_feedback(&mut boundary,1.,[1.,0.,0.,0.],[0.;3]);
    boundary.set("test/attitude/command-pitch-deg",45.);boundary.tick(0.).unwrap();
    let initial=boundary.value("test/manual/command-pitch-deg").unwrap();
    assert!(initial > 44., "handover preserves the prior stimulus rather than clipping to 12 degrees");
    boundary.tick(0.02).unwrap();
    let next=boundary.value("test/manual/command-pitch-deg").unwrap();
    assert!(next < initial && initial-next <= 0.60001, "handover respects the 30 degrees/s slew");
    for field in ["test/fc/local-vx-mps","test/fc/local-vy-mps"] {
        let mut e=engine("manual_recover_capture");angle_feedback(&mut e,1.,[1.,0.,0.,0.],[0.;3]);e.properties.remove(field);
        assert!(e.tick(0.).unwrap_err().contains("最新"));
    }
    let mut e=engine("manual_recover_capture");angle_feedback(&mut e,2.,[1.,0.,0.,0.],[0.;3]);for (key,value) in &mut e.properties{if key.ends_with("/recover-mode"){*value=1.;}}assert!(e.tick(0.).unwrap_err().contains("模式"));
    let mut e=engine("manual_recover_capture");
    for step in 0..180 {angle_feedback(&mut e,1.,[1.,0.,0.,0.],[0.;3]);if step>0&&step<100{e.set("test/fc/local-x-m",0.8);}
        if step==140{e.set("test/fc/local-vx-mps",0.6);}e.tick(step as f64*0.02).unwrap();assert!(!e.done());}
    assert!(e.value("test/manual/held-s").unwrap()<1.);
    for step in 180..255{angle_feedback(&mut e,1.,[1.,0.,0.,0.],[0.;3]);e.tick(step as f64*0.02).unwrap();}
    assert!(e.done());assert!(!flight_test::xml::writable("test/manual/origin-x-m"));assert!(!flight_test::xml::writable("test/manual/breturn/status"));
    let mut e=engine("manual_recover_increment");let mut targets=Vec::new();let mut observed=std::collections::BTreeSet::new();
    for step in 0..600 {angle_feedback(&mut e,1.,[1.,0.,0.,0.],[0.;3]);e.tick(step as f64*0.02).unwrap();if e.done(){break;}
        let owners:Vec<_>=e.properties.keys().filter_map(|k|k.strip_suffix("/angle-pitch-deg")).filter(|base|e.value(&format!("{base}/enabled"))==Some(1.)).map(str::to_owned).collect();
        for owner in owners {if observed.insert(owner.clone()){targets.push(e.value(&format!("{owner}/angle-pitch-deg")).unwrap());}e.set(&format!("test/attitude/{}/status",owner.trim_start_matches("test/input/")),1.);}
    }
    assert!(e.done());assert_eq!(targets,vec![5.,10.]);assert!(e.inputs().unwrap().is_empty());
}

#[test]
fn manual_local_velocity_uses_ned_samples_and_expires() {
    use flight_test::mavlink::*;use std::time::{Instant,Duration};
    let now=Instant::now();let mut t=Telemetry::default();t.ingest(&Frame{id:0,system:1,component:1,payload:vec![0,0,1,0,2,12,160,4,3],signed:false},now);
    let mut p=vec![0;28];p[16..20].copy_from_slice(&1.25f32.to_le_bytes());p[20..24].copy_from_slice(&(-0.75f32).to_le_bytes());
    t.ingest(&Frame{id:32,system:1,component:1,payload:p,signed:false},now);
    assert_eq!(t.values(now)["test/fc/local-vx-mps"],1.25);assert_eq!(t.values(now)["test/fc/local-vy-mps"],-0.75);
    assert!(!t.values(now+Duration::from_millis(1501)).contains_key("test/fc/local-vx-mps"));
}

#[test]
fn flight_xml_parallel_all_any_and_staggered() {
    let mut e = engine("all");
    e.tick(0.).unwrap();
    assert_eq!(e.rc().unwrap(), [0.2, 0., -0.15, 0.5]);
    assert!(!e.done());
    e.tick(1.5).unwrap();
    assert_eq!(e.rc().unwrap(), [0.2, 0., 0., 0.5]);
    e.tick(3.).unwrap();
    assert!(e.done());
    assert_eq!(e.rc().unwrap(), [0., 0., 0., 0.5]);
    let mut e = engine("any");
    e.tick(0.).unwrap();
    e.tick(1.5).unwrap();
    assert!(e.done());
    assert!(e.inputs().unwrap().is_empty());
    assert!(e.active_blocks().is_empty());
    let mut e = engine("staggered");
    e.tick(0.).unwrap();
    e.tick(1.).unwrap();
    assert_eq!(e.rc().unwrap()[0], 0.);
    e.tick(2.).unwrap();
    assert_eq!(e.rc().unwrap()[0], -0.15);
    e.tick(3.).unwrap();
    assert!(e.done());
    let mut e = engine("conflict");
    e.tick(0.).unwrap();
    assert!(e.rc().unwrap_err().contains("冲突"));
}

#[test]
fn manual_takeoff_ramps_throttle_climbs_and_hands_over_without_nav_takeoff(){
    let mut e=engine("manual_takeoff");e.set("test/rc/throttle-norm",0.);
    let (mut height,mut climb,mut previous,mut peak)=(0f64,0f64,0f64,0f64);let mut complete=false;
    for step in 0..5500{
        altitude_feedback(&mut e,1.,height,climb);e.set("test/fc/landed",if height<0.05{1.}else{0.});
        e.tick(step as f64*0.02).unwrap();assert!(!e.failed());assert!(e.commands().unwrap().is_empty());
        let u=e.rc().unwrap()[3];assert!((0.0..=0.75).contains(&u));
        assert!((u-previous).abs()<=0.002001,"slew {previous} -> {u}");previous=u;
        if e.done(){complete=true;break;}
        let acceleration=(u-0.5)*12.-climb*0.3;climb+=acceleration*0.02;height+=climb*0.02;
        if height<0.{height=0.;climb=0.;}peak=peak.max(climb);
    }
    assert!(complete,"height={height} climb={climb} u={previous}");assert!((height-5.).abs()<=0.31);assert!(climb.abs()<0.16);assert!(peak<0.8);
    assert!(e.value("test/rc/throttle-norm").unwrap()>0.4);assert!(e.inputs().unwrap().is_empty());
}

#[test]
fn explicit_normal_and_vector_paths_drive_all_modes_and_140_degrees(){
    for (mode,vector) in [(1.,false),(2.,false),(3.,false),(3.,true)]{for axis in [0,1]{
        let limit=if vector{140.}else{45.};let mut e=engine(if vector{"vector140"}else{"attitude"});
        for (key,value) in &mut e.properties{if key.ends_with("/angle-roll-deg"){*value=if axis==0{limit}else{0.};}if key.ends_with("/angle-pitch-deg"){*value=if axis==1{limit}else{0.};}}
        e.set("test/rc/input-kind",if vector{2.}else{1.});
        let mut q=[1.,0.,0.,0.];let mut rate=[0.;3];let mut complete=false;
        for step in 0..2000{
            angle_feedback(&mut e,mode,q,rate);e.set("test/profile/aux-angle-deg",140.);e.tick(step as f64*0.02).unwrap();
            if e.done(){complete=true;break;}assert!(!e.failed());
            let rc=e.rc().unwrap();let input=if vector{assert_eq!(&rc[..3],&[0.,0.,0.]);e.aux()[axis]*140.}else{assert_eq!(e.aux(),[0.,0.]);(if axis==0{rc[0]}else{-rc[1]})*45.};
            let current=2.*q[axis+1].atan2(q[0]);rate[axis]+=((2.*(input.to_radians()-current)).clamp(-0.5,0.5)-rate[axis])*0.12;
            let speed=rate[axis];let (s,c)=(speed*0.02/2.).sin_cos();let mut delta=[c,0.,0.,0.];delta[axis+1]=s;q=quat_mul(q,delta);
        }
        assert!(complete,"mode={mode} vector={vector} axis={axis}");assert!((2.*q[axis+1].atan2(q[0]).to_degrees()-limit).abs()<3.);
    }}
}
#[test]
fn flight_xml_nested_cancellation_loops_and_conditions() {
    let mut e = engine("nested");
    e.tick(0.).unwrap();
    assert_eq!(e.rc().unwrap(), [0.2, 0., 0.15, 0.5]);
    e.tick(1.5).unwrap();
    assert!(e.done());
    assert!(e.inputs().unwrap().is_empty());
    e.tick(9.).unwrap();
    assert!(e.inputs().unwrap().is_empty());
    let mut e = engine("loop");
    for t in [0., 0.051, 0.101, 0.152, 0.202] {
        e.tick(t).unwrap();
    }
    assert!(e.done());
    let mut e = engine("branch");
    e.tick(0.).unwrap();
    assert!(
        e.inputs().unwrap().is_empty(),
        "unknown telemetry must not choose the false branch"
    );
    e.set("test/fc/relative-alt-m", 5.);
    e.tick(0.1).unwrap();
    assert_eq!(e.rc().unwrap()[0], 0.2);
    e.set("test/fc/relative-alt-m", 0.);
    e.tick(0.31).unwrap();
    assert!(e.done(), "branch decision is latched");
    let mut e = engine("timeout");
    e.tick(0.).unwrap();
    e.tick(0.11).unwrap();
    assert!(e.failed());
    let mut e = engine("mode");
    e.tick(0.).unwrap();
    assert!(!e.done());
    let c = e.commands().unwrap();
    assert_eq!((c[0].kind, c[0].argument), (3, 3.));
    e.set(&format!("{}/status", c[0].owner), 1.);
    e.tick(0.1).unwrap();
    assert!(e.done());
}
#[test]
fn flight_xml_strict_parser_and_native_transitions() {
    use flight_test::{engine::Engine, xml};
    for source in ["<!DOCTYPE runscript><runscript/>","<runscript><run end='1'><parallel/></run></runscript>","<runscript><run end='1'><event><condition>simulation/sim-time-sec ge 0</condition><set name='fcs/throttle-cmd-norm' value='1'/></event></run></runscript>"]{assert!(xml::parse(source).is_err());}
    let source="<runscript name='ramp'><run end='4'><property value='0'>test/rc/roll-norm</property><event name='ramp'><condition>simulation/sim-time-sec ge 0</condition><set name='test/rc/roll-norm' value='1' action='FG_RAMP' tc='1'/></event></run></runscript>";
    let mut e = Engine::new(xml::parse(source).unwrap());
    e.tick(0.).unwrap();
    e.tick(0.25).unwrap();
    assert_eq!(e.rc().unwrap()[0], 0.25);
    e.tick(1.).unwrap();
    assert_eq!(e.rc().unwrap()[0], 1.);
    let source = source.replace("FG_RAMP", "FG_EXP");
    let mut e = Engine::new(xml::parse(&source).unwrap());
    e.tick(0.).unwrap();
    e.tick(1.).unwrap();
    assert!((e.rc().unwrap()[0] - (1. - (-1f64).exp())).abs() < 1e-10);
    let source="<runscript><run end='4'><property value='0'>test/rc/roll-norm</property><event name='delayed'><condition>simulation/sim-time-sec ge 0</condition><delay>1</delay><set name='test/rc/roll-norm' value='.5'/><notify/></event></run></runscript>";
    let mut e = Engine::new(xml::parse(source).unwrap());
    e.tick(0.).unwrap();
    assert!(e.messages.is_empty());
    e.tick(1.).unwrap();
    assert_eq!(e.rc().unwrap()[0], 0.5);
    assert_eq!(e.messages, ["delayed"]);
    let source=source.replace("<notify/>","<notify><description>杆量确认</description><property caption='roll'>test/rc/roll-norm</property></notify>");
    let mut e = Engine::new(xml::parse(&source).unwrap());
    e.tick(0.).unwrap();
    e.tick(1.).unwrap();
    assert_eq!(e.messages, ["delayed · 杆量确认 · roll=0.5"]);
    let source="<runscript><run end='4'><property value='.1'>test/rc/roll-norm</property><event continuous='true'><condition>simulation/sim-time-sec ge 0</condition><set name='test/rc/roll-norm' type='FG_DELTA'><function><product><value>0.1</value><property>simulation/sim-time-sec</property></product></function></set></event></run></runscript>";
    let mut e = Engine::new(xml::parse(source).unwrap());
    e.tick(0.).unwrap();
    assert_eq!(e.rc().unwrap()[0], 0.);
    e.tick(1.).unwrap();
    assert_eq!(
        e.rc().unwrap()[0],
        0.1,
        "native continuous function values are reevaluated directly, including FG_DELTA"
    );
    let source="<runscript><run end='1'><property value='1'>test/command/x/status</property><event><condition>simulation/sim-time-sec ge 0</condition></event></run></runscript>";
    assert!(
        xml::parse(source).is_err(),
        "command confirmations cannot be supplied by input XML"
    );
    assert!(xml::parse(&fixture("escaped")).is_ok());
}
#[test]
fn flight_mavlink_wire_and_target_filters() {
    use flight_test::mavlink::*;
    use std::time::Instant;
    let bytes = manual(7, [0.2, -0.1, -0.15, 0.5], 9);
    let frames = Parser::default().push(&bytes, true);
    assert_eq!(frames.len(), 1);
    let p = &frames[0].payload;
    assert_eq!(i16::from_le_bytes(p[0..2].try_into().unwrap()), -100);
    assert_eq!(i16::from_le_bytes(p[2..4].try_into().unwrap()), 200);
    assert_eq!(i16::from_le_bytes(p[4..6].try_into().unwrap()), 500);
    assert_eq!(i16::from_le_bytes(p[6..8].try_into().unwrap()), -150);
    assert_eq!(p[10], 7);
    let mut bad = bytes.clone();
    bad[11] ^= 1;
    assert!(Parser::default().push(&bad, true).is_empty());
    let mut parser = Parser::default();
    assert!(parser.push(&bytes[..7], false).is_empty());
    assert_eq!(parser.push(&bytes[7..], false).len(), 1);
    let mut t = Telemetry::default();
    let now = Instant::now();
    let mut hb = Frame {
        id: 0,
        system: 7,
        component: 1,
        payload: vec![0, 0, 3, 0, 2, 12, 160, 4, 3],
        signed: false,
    };
    t.ingest(&hb, now);
    assert!(t.fresh(now));
    assert_eq!(t.target, Some((7, 1)));
    hb.system = 8;
    hb.payload[6] = 0;
    t.ingest(&hb, now);
    assert!(t.hil);
    hb.system = 7;
    hb.signed = true;
    t.ingest(&hb, now);
    assert!(!t.fresh(now));
}

#[test]
fn flight_udp_runner_commands_timing_and_failures() {
    use flight_test::{mavlink as m, Options};
    use serial_assistant::{NetworkConfig, NetworkMode, SerialEvent};
    use std::{
        net::UdpSocket,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };
    #[derive(Default)]
    struct State {
        hil: bool,
        armed: bool,
        landed: bool,
        land_at: Option<Instant>,
        mode: u8,
        rc_mode: Option<i32>,
        uid: u64,
        ignore_posctl: bool,
        reject_posctl: bool,
        silent: bool,
        receiver_unhealthy: bool,
        source_writes: Vec<u8>,
        reject_source: bool,
        manual: Vec<(Instant, [i16; 4])>,
        last_input_change: Option<Instant>,
        commands: Vec<u16>,
        parameter_reads: Vec<String>,
        streams: Vec<(f32, f32)>,
        rc_frames: Vec<(Instant, [u16; 18])>,
        aux6: Vec<i16>,
        buttons: Vec<u16>,
    }
    fn packet(id: u32, p: &[u8]) -> Vec<u8> {
        let mut b = m::encode(id, p, 0);
        b[5] = 7;
        b[6] = 1;
        let len = b[1] as usize;
        let crc = m::crc(&b[1..10 + len], m::spec(id).unwrap().0);
        b[10 + len..12 + len].copy_from_slice(&crc.to_le_bytes());
        b
    }
    fn heartbeat(state: &State) -> Vec<u8> {
        let (main, sub) = if state.mode == 4 {
            (4u32, 3u32)
        } else if state.mode == 8 {
            (4u32, 6u32)
        } else {
            (u32::from(state.mode), 0)
        };
        let mut p = vec![0; 9];
        p[..4].copy_from_slice(&((main << 16) | (sub << 24)).to_le_bytes());
        p[4] = 2;
        p[5] = 12;
        p[6] = (if state.hil { 32 } else { 0 }) | (if state.armed { 128 } else { 0 });
        p[7] = 4;
        p[8] = 3;
        packet(0, &p)
    }
    fn ack(command: u16, result: u8) -> Vec<u8> {
        let mut p = vec![0; 10];
        p[..2].copy_from_slice(&command.to_le_bytes());
        p[2] = result;
        p[8] = m::SYSTEM;
        p[9] = m::COMPONENT;
        packet(77, &p)
    }
    fn rc_mode_parameter(value: i32) -> Vec<u8> {
        let mut p = vec![0; 25];
        p[..4].copy_from_slice(&value.to_le_bytes());
        p[8..22].copy_from_slice(b"COM_RC_IN_MODE");
        p[24] = 6;
        packet(22, &p)
    }
    let state = Arc::new(Mutex::new(State {
        hil: true,
        armed: true,
        mode: 3,
        rc_mode: Some(1),
        parameter_reads: Vec::new(),
        uid: 0xabcd,
        ..State::default()
    }));
    let (tx, rx) = mpsc::channel();
    let channel = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(source) = body {
            let e: SerialEvent = serde_json::from_str(&source).unwrap();
            flight_test::observe(&e);
            let _ = tx.send(serde_json::from_str::<serde_json::Value>(&source).unwrap());
        }
        Ok(())
    });
    let info = tool_transport::manager()
        .open_network(
            NetworkConfig {
                mode: NetworkMode::Udp,
                host: String::new(),
                port: 0,
                local_host: "127.0.0.1".into(),
                local_port: 0,
            },
            channel,
        )
        .unwrap();
    let endpoint = loop {
        let e = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        if e["kind"] == "endpoint" {
            break e;
        }
    };
    let target = endpoint["localAddr"]
        .as_str()
        .unwrap()
        .parse::<std::net::SocketAddr>()
        .unwrap();
    let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
    socket
        .set_read_timeout(Some(Duration::from_millis(5)))
        .unwrap();
    tool_transport::manager()
        .pin_peer(info.session_id, socket.local_addr().unwrap())
        .unwrap();
    flight_test::bind_session(info.session_id, Some("127.0.0.1".parse().unwrap()), true);
    flight_test::pin(info.session_id, socket.local_addr().unwrap());
    let alive = Arc::new(AtomicBool::new(true));
    let remote_alive = alive.clone();
    let shared = state.clone();
    let server = thread::spawn(move || {
        let begin = Instant::now();
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut parser = m::Parser::default();
        let mut buf = [0; 2048];
        while remote_alive.load(Ordering::Relaxed) {
            if last.elapsed() >= Duration::from_millis(50) {
                let mut s = shared.lock().unwrap();
                if s.land_at.is_some_and(|at| Instant::now() >= at) { s.landed=true; }
                if !s.silent {
                    let _ = socket.send_to(&heartbeat(&s), target);
                    let mut health=vec![0;43];
                    if !s.receiver_unhealthy && (s.rc_mode==Some(0)||!s.rc_frames.is_empty()) {health[..4].copy_from_slice(&(1u32<<16).to_le_bytes());health[8..12].copy_from_slice(&(1u32<<16).to_le_bytes());}
                    let _=socket.send_to(&packet(1,&health),target);
                    if let Some(mode) = s.rc_mode {
                        let _ = socket.send_to(&rc_mode_parameter(mode), target);
                    }
                    let mut p = vec![0; 28];
                    p[..4].copy_from_slice(
                        &(10000 + begin.elapsed().as_millis() as u32).to_le_bytes(),
                    );
                    p[4..8].copy_from_slice(&0.02f32.to_le_bytes());
                    let _ = socket.send_to(&packet(30, &p), target);
                    let mut q=vec![0;48];q[..4].copy_from_slice(&p[..4]);q[4..8].copy_from_slice(&1f32.to_le_bytes());
                    let _=socket.send_to(&packet(31,&q),target);let _=socket.send_to(&packet(32,&vec![0;28]),target);
                    let mut g = vec![0; 28];
                    g[12..16].copy_from_slice(&100000i32.to_le_bytes());
                    g[16..20].copy_from_slice(&5000i32.to_le_bytes());
                    let _ = socket.send_to(&packet(33, &g), target);
                    let _ = socket.send_to(&packet(245, &[0, if s.landed {1} else {2}]), target);
                    let mut version = vec![0; 78];
                    version[..8].copy_from_slice(&16u64.to_le_bytes());
                    version[8..16].copy_from_slice(&s.uid.to_le_bytes());
                    let _ = socket.send_to(&packet(148, &version), target);
                }
                last = Instant::now();
            }
            if let Ok((n, source)) = socket.recv_from(&mut buf) {
                assert_eq!(
                    source, target,
                    "runner must retain the toolbox UDP source port"
                );
                for f in parser.push(&buf[..n], true) {
                    let mut s = shared.lock().unwrap();
                    if s.silent {
                        continue;
                    }
                    if f.id == 23 {
                        assert_eq!(&f.payload[6..20], b"COM_RC_IN_MODE", "source switch only writes the existing input selector");
                        let value=i32::from_le_bytes(f.payload[..4].try_into().unwrap()) as u8;
                        s.source_writes.push(value);if !s.reject_source{s.rc_mode=Some(value as i32);}
                    } else if f.id == 20 {
                        let name=String::from_utf8_lossy(&f.payload[4..20]).trim_end_matches('\0').to_string();s.parameter_reads.push(name.clone());
                        if name=="COM_RC_IN_MODE" { if let Some(mode) = s.rc_mode {
                            socket.send_to(&rc_mode_parameter(mode), target).unwrap();
                        }} else if flight_test::channels::is_parameter(&name)||["RC_MAP_ARM_SW","RC_ARMSWITCH_TH"].contains(&name.as_str()) {
                            let mut p = vec![0;25];
                            let value: f32 = match name.as_str() {
                                "RC_MAP_VECTOR_SW" => 8., "RC_CHAN_CNT" => 18., "RC_MAP_ROLL" => 3., "RC_MAP_PITCH" => 1.,
                                "RC_MAP_YAW" => 4., "RC_MAP_THROTTLE" => 2., "RC_MAP_AUX1" => 9., "RC_MAP_AUX2" => 12., "RC_MAP_AUX6" => 18.,
                                "RC_ARMSWITCH_TH" => 0.75,
                                n if n.starts_with("RC_MAP_") => 0., n if n.ends_with("_MIN") => 1000., n if n.ends_with("_MAX") => 2000., n if n.ends_with("_REV") => 1., _ => 1500.,
                            };
                            if name.starts_with("RC_MAP_") || name=="RC_CHAN_CNT" { p[..4].copy_from_slice(&(value as i32).to_le_bytes()); p[24]=6; }
                            else { p[..4].copy_from_slice(&value.to_le_bytes()); p[24]=9; }
                            p[8..8+name.len()].copy_from_slice(name.as_bytes());
                            socket.send_to(&packet(22,&p),target).unwrap();
                        }
                    } else if f.id == 69 {
                        let p = &f.payload;
                        assert_eq!(p[10], 7);
                        let input = std::array::from_fn(|i| i16::from_le_bytes(p[i * 2..i * 2 + 2].try_into().unwrap()));
                        if s.manual.last().is_none_or(|(_,previous)| *previous!=input) {s.last_input_change=Some(Instant::now());}
                        s.manual.push((
                            Instant::now(),
                            input,
                        ));
                        s.aux6.push(i16::from_le_bytes(p[28..30].try_into().unwrap()));
                        s.buttons.push(u16::from_le_bytes(p[8..10].try_into().unwrap()));
                        socket.send_to(&packet(69,p),target).unwrap();
                    } else if f.id == 70 {
                        let p = &f.payload;
                        let raw = std::array::from_fn(|i| { let o = if i<8 {i*2} else {18+(i-8)*2}; u16::from_le_bytes(p[o..o+2].try_into().unwrap()) });
                        assert_eq!(&p[16..18], &[7,1]);
                        if s.rc_frames.last().is_none_or(|(_,previous)| *previous != raw) { s.last_input_change = Some(Instant::now()); }
                        s.rc_frames.push((Instant::now(), raw));
                        let mut echo=vec![0;42];for (i,v) in raw.iter().enumerate(){echo[4+i*2..6+i*2].copy_from_slice(&v.to_le_bytes());}
                        echo[40]=18;echo[41]=100;socket.send_to(&packet(65,&echo),target).unwrap();
                    } else if f.id == 76 {
                        let id = u16::from_le_bytes(f.payload[28..30].try_into().unwrap());
                        if id == 512 {
                            if f32::from_le_bytes(f.payload[..4].try_into().unwrap()) == 65. {
                                let mut p = vec![0; 42]; for i in 0..18 { p[4+i*2..6+i*2].copy_from_slice(&(if i == 5 {1900u16} else {1500u16}).to_le_bytes()); }
                                p[40] = 18; p[41] = 255; socket.send_to(&packet(65, &p), target).unwrap();
                            }
                            continue;
                        }
                        if id == 511 {
                            s.streams.push((f32::from_le_bytes(f.payload[..4].try_into().unwrap()),
                                f32::from_le_bytes(f.payload[4..8].try_into().unwrap())));
                            continue;
                        }
                        s.commands.push(id);
                        let arg = f32::from_le_bytes(f.payload[4..8].try_into().unwrap()) as u8;
                        if id == 176 && arg == 3 && s.reject_posctl {
                            socket.send_to(&ack(id, 2), target).unwrap();
                            continue;
                        }
                        socket.send_to(&ack(id, 0), target).unwrap();
                        if id == 176 && !(arg == 3 && s.ignore_posctl) {
                            s.mode = if arg == 4 { 4 } else { arg };
                        }
                        if id == 21 {
                            assert!(s.last_input_change.is_some_and(|at|at.elapsed()>=Duration::from_millis(650)),"centered inputs must settle before LAND to avoid pilot takeover");
                            if let Some((_, manual)) = s.manual.last() { assert_eq!(*manual,[0,0,500,0]); }
                            else { let p = &s.rc_frames.last().unwrap().1; assert_eq!([p[2],p[0],p[3],p[1]], [1500; 4]); }
                            s.mode=8; s.land_at=Some(Instant::now()+Duration::from_millis(250));
                        }
                        if id == 400 {
                            let arm = f32::from_le_bytes(f.payload[..4].try_into().unwrap()) == 1.;
                            if !arm { assert!(s.landed, "disarm only after a fresh landed observation"); assert_eq!(f32::from_le_bytes(f.payload[4..8].try_into().unwrap()),0., "never force disarm"); }
                            s.armed = arm;
                        }
                        socket.send_to(&heartbeat(&s), target).unwrap();
                    }
                }
            }
        }
    });
    let options = Options {
        dry_run: false,
        rc_emulation: false,
        session_id: Some(info.session_id),
        system: 7,
        component: 1,
        instance: 1,
        rate_hz: 50,
        clock: "realtime".into(),
        on_finish: "hold".into(),
        on_abort: "hold".into(),
    };
    let wait_done = |id| {
        let deadline = Instant::now() + Duration::from_secs(9);
        loop {
            let s = flight_test::status();
            if s.id == id && !flight_test::running() {
                return s;
            }
            assert!(
                Instant::now() < deadline,
                "runner did not finish: {}",
                s.status
            );
            thread::sleep(Duration::from_millis(10));
        }
    };
    let archive_dir = std::env::temp_dir().join(format!("px4-test-report-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let archive = || Some((Ok(archive_dir.clone()), flight_test::report::Metadata {
        stage_labels: vec!["切换定点".into(), "测试 & <杆量>".into()],
        aircraft_label: Some("示例机型".into()),
    }));
    let check_archive = |id: &str, status: &str, exit_state: &str| {
        flight_test::report::wait_for_writes();
        let html = flight_test::report::html_path(&archive_dir, id).unwrap();
        let record: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(html.with_extension("json")).unwrap()).unwrap();
        assert_eq!(record["archiveId"], id);
        assert_eq!(record["result"]["status"], status);
        assert_eq!(record["result"]["outcome"]["exitState"], exit_state);
        assert!(record["sourceXml"].as_str().unwrap().contains("<runscript"));
        std::fs::read_to_string(html).unwrap()
    };
    thread::sleep(Duration::from_millis(120));
    let run = flight_test::start_run(
        fixture("live"),
        options.clone(),
        Some(vec!["b1_2".into(), "b2_3".into()]),
        archive(),
    ).unwrap();
    // No frontend polling or timing drives this run.
    thread::sleep(Duration::from_millis(650));
    let done = wait_done(run.id);
    assert_eq!(
        done.status,
        "passed",
        "{:?}",
        done.logs.iter().map(|l| &l.message).collect::<Vec<_>>()
    );
    assert!(done.exit_result.contains("已确认"));
    let progress = done.progress.as_ref().expect("structured progress");
    assert_eq!(progress.total, 2);
    assert_eq!(progress.completed_at.len(), 2);
    let script_start = progress.script_started_at.unwrap();
    let script_finish = progress.script_finished_at.unwrap();
    assert!(script_start > 0.);
    assert!(script_start <= progress.completed_at[0] && progress.completed_at[0] < progress.completed_at[1]);
    assert!(progress.completed_at[1] <= script_finish && script_finish < done.run_elapsed);
    assert!(progress.active_nodes.is_empty());
    assert_eq!(flight_test::status().run_elapsed, done.run_elapsed, "terminal time must stop advancing");
    {
        let s = state.lock().unwrap();
        let active: Vec<_> = s.manual.iter().filter(|(_, rc)| rc[1] == 200).collect();
        assert!(
            active.len() >= 14,
            "too few control frames: {}",
            active.len()
        );
        assert!(active.iter().any(|(_, rc)| rc[3] == -150));
        assert!(active.iter().any(|(_, rc)| rc[3] == 0));
        let mut gaps: Vec<_> = active
            .windows(2)
            .map(|w| w[1].0.duration_since(w[0].0).as_secs_f64())
            .collect();
        gaps.sort_by(f64::total_cmp);
        assert!(
            gaps[gaps.len() / 2] < 0.03,
            "control scheduler blocked on reads"
        );
        assert!(s.streams.is_empty(), "reuse fresh default telemetry without changing stream rates");
        assert!(s.commands.contains(&176));
        assert!(!s.commands.contains(&400), "no unsolicited arm/disarm");
        assert_eq!(s.manual.last().unwrap().1, [0, 0, 500, 0]);
    }
    let record = flight_test::flight_test_report().unwrap();
    assert!(record["trace"].as_array().unwrap().len() > 2);
    assert!(record["sourceXml"].as_str().unwrap().contains("runscript"));
    assert!(record["result"]["startedAtUnixMs"].as_u64().unwrap() > 0);
    assert_eq!(record["result"]["binding"]["system"], 7);
    assert_eq!(record["result"]["binding"]["model"], "ball");
    let first_archive = record["archiveId"].as_str().unwrap().to_owned();
    let html = check_archive(&first_archive, "passed", "confirmed");
    assert!(html.contains("测试 &amp; &lt;杆量&gt;"));
    assert!(html.contains("HIL 仿真"));
    // Receiver emulation sends the complete sticks/AUX/switch sample through
    // RC_CHANNELS_OVERRIDE for the run and Hold cleanup, without a joystick stream.
    { let mut s = state.lock().unwrap(); s.manual.clear(); s.rc_frames.clear(); s.parameter_reads.clear(); }
    let mut receiver_options = options.clone(); receiver_options.rc_emulation = true;
    state.lock().unwrap().rc_mode=Some(0);
    let done = wait_done(flight_test::start(fixture("receiver_live"), receiver_options.clone()).unwrap().id);
    assert_eq!(done.status, "passed", "{:?}", done.logs.iter().map(|l| &l.message).collect::<Vec<_>>());
    assert_eq!(done.values.get("test/receiver/ready"), Some(&1.), "readiness remains visible in runtime snapshots and reports");
    {
        let s = state.lock().unwrap();
        assert!(s.manual.is_empty(), "never mix MANUAL_CONTROL with emulated receiver input");
        assert!(s.rc_frames.iter().any(|(_, p)| [p[2], p[0], p[3], p[1], p[8], p[11], p[7]] == [1600,1450,1575,1700,1750,1375,2000]));
        let p = &s.rc_frames.last().unwrap().1;
        assert_eq!([p[2],p[0],p[3],p[1],p[8],p[11]], [1500; 6], "exit centers mapped sticks and AUX");
        assert!(s.rc_frames.iter().all(|(_,p)| p[5] == 1900), "preserve unowned switch throughout run and exit");
        assert!(s.parameter_reads.iter().any(|n| n == "RC_MAP_AUX1"));
        assert!(!s.parameter_reads.iter().any(|n| n == "COM_RC_IN_MODE" || n == "VEC_HIL_TEST"));
    }
    let mut receiver_land = receiver_options.clone(); receiver_land.on_finish = "land".into();
    let landed = wait_done(flight_test::start(fixture("receiver_live"), receiver_land).unwrap().id);
    assert_eq!(landed.status, "passed", "{:?}", landed.logs.iter().map(|l| &l.message).collect::<Vec<_>>());
    assert!(landed.exit_result.contains("着陆并上锁"));
    {
        let mut s = state.lock().unwrap(); assert!(s.manual.is_empty());
        let p = &s.rc_frames.last().unwrap().1;
        assert_eq!([p[2],p[0],p[3],p[8],p[11]], [1500; 5], "landing retains centered receiver input until confirmed disarm");
        s.mode=3;s.armed=true;s.landed=false;s.land_at=None;
    }
    thread::sleep(Duration::from_millis(100)); // publish the new armed state before binding preparation
    let mut receiver_stop = receiver_options.clone(); receiver_stop.on_abort = "release".into();
    let run = flight_test::start(fixture("long"), receiver_stop).unwrap();
    thread::sleep(Duration::from_millis(600));
    assert_eq!(flight_test::stop(Some(run.id)).unwrap().status, "stopped");
    let count = state.lock().unwrap().rc_frames.len(); thread::sleep(Duration::from_millis(100));
    assert_eq!(state.lock().unwrap().rc_frames.len(), count, "receiver output stops after release");
    {
        let mut s=state.lock().unwrap();s.receiver_unhealthy=true;s.commands.clear();s.manual.clear();s.rc_frames.clear();
    }
    let mut not_ready=receiver_options.clone();not_ready.on_abort="release".into();
    let failed=wait_done(flight_test::start(fixture("receiver_live"),not_ready).unwrap().id);
    assert_eq!(failed.status,"failed");
    assert!(failed.logs.iter().any(|l|l.message.contains("模拟遥控器未就绪")));
    {let mut s=state.lock().unwrap();assert!(s.commands.is_empty(),"no mode/arm/takeoff script commands before receiver readiness");assert!(s.manual.is_empty());s.receiver_unhealthy=false;}
    {let mut s = state.lock().unwrap();s.manual.clear();s.last_input_change=Some(Instant::now());}
    state.lock().unwrap().rc_mode=Some(1);
    let mut landing_options=options.clone();landing_options.on_finish="land".into();
    let landed=wait_done(flight_test::start(fixture("live"),landing_options).unwrap().id);
    assert_eq!(landed.status,"passed");assert!(landed.exit_result.contains("着陆并上锁"));
    { let s=state.lock().unwrap();assert!(s.landed && !s.armed);assert!(s.commands.contains(&21) && s.commands.contains(&400)); }
    {
        let mut s=state.lock().unwrap();s.mode=3;s.armed=true;s.landed=false;s.land_at=None;s.manual.clear();s.commands.clear();
    }
    thread::sleep(Duration::from_millis(80));
    let done=wait_done(flight_test::start(fixture("altitude_live"),options.clone()).unwrap().id);
    assert_eq!(done.status,"passed","{:?}",done.logs.iter().map(|l|&l.message).collect::<Vec<_>>());
    {
        let s=state.lock().unwrap();
        assert!(s.manual.iter().any(|(_,rc)|rc[2]>550),"feedback correction must reach the MANUAL_CONTROL throttle channel");
        assert!(s.manual.iter().all(|(_,rc)|rc[0]==0&&rc[1]==0&&rc[3]==0),"height controller owns only throttle");
        assert!(!s.commands.contains(&22),"pilot simulation never substitutes a takeoff or altitude-target command");
    }
    let controlled=flight_test::flight_test_report().unwrap();
    assert!(controlled["trace"].as_array().unwrap().iter().any(|p|p["values"]["test/altitude/target-m"]==6.&&p["values"]["test/altitude/error-m"]==1.));
    // Receiving another sender must not change the locked target or HIL state.
    let spoof = UdpSocket::bind("127.0.0.1:0").unwrap();
    let mut spoof_state = State::default();
    spoof_state.mode = 3;
    spoof.send_to(&heartbeat(&spoof_state), target).unwrap();
    scene_telemetry::MORPHQUAD.store(true,Ordering::Relaxed);
    {let mut s=state.lock().unwrap();s.mode=3;s.parameter_reads.clear();}
    thread::sleep(Duration::from_millis(80));
    let done=wait_done(flight_test::start(fixture("attitude_live"),options.clone()).unwrap().id);
    assert_eq!(done.status,"passed","{:?}",done.logs.iter().map(|l|&l.message).collect::<Vec<_>>());
    {let s=state.lock().unwrap();assert!(!s.parameter_reads.iter().any(|n|n=="VEC_HIL_TEST"));assert!(s.parameter_reads.iter().any(|n|n=="COM_RC_IN_MODE"));}
    scene_telemetry::MORPHQUAD.store(false,Ordering::Relaxed);
    // The MANUAL_CONTROL path requires an explicit MAVLink-only selection.
    for rc_mode in [Some(0),Some(1),Some(3),None] {
        {let mut s=state.lock().unwrap();s.manual.clear();s.commands.clear();s.parameter_reads.clear();s.rc_mode=rc_mode;}
        thread::sleep(Duration::from_millis(80));
        let done=wait_done(flight_test::start(fixture("live"),options.clone()).unwrap().id);
        let s=state.lock().unwrap();
        if rc_mode==Some(1){assert_eq!(done.status,"passed");assert!(!s.manual.is_empty());}
        else{assert_eq!(done.status,"failed");assert!(s.manual.is_empty()&&s.commands.is_empty(),"no controls before selecting MAVLink");}
        assert!(s.parameter_reads.iter().any(|n|n=="COM_RC_IN_MODE"));
    }
    let mut channel_options=options.clone();channel_options.on_finish="release".into();channel_options.on_abort="release".into();
    {let mut s=state.lock().unwrap();s.rc_mode=Some(1);s.manual.clear();s.rc_frames.clear();s.aux6.clear();s.buttons.clear();}
    thread::sleep(Duration::from_millis(80));
    let done=wait_done(flight_test::start(fixture("channels_live"),channel_options.clone()).unwrap().id);
    assert_eq!(done.status,"passed","{:?}",done.logs.iter().map(|l|&l.message).collect::<Vec<_>>());
    {let s=state.lock().unwrap();assert!(s.rc_frames.is_empty(),"MAVLink path never emits raw RC overrides");assert!(s.buttons.contains(&1)&&s.buttons.contains(&0));assert!(s.aux6.contains(&250));}
    let report=flight_test::flight_test_report().unwrap();
    assert!(report["trace"].as_array().unwrap().iter().any(|p|p["values"]["test/output/vector-enabled"]==1.));
    {let mut s=state.lock().unwrap();s.manual.clear();s.commands.clear();}
    let raw=wait_done(flight_test::start(fixture("channels").replace("test/channel/vector-switch/","test/channel/rc18/"),channel_options.clone()).unwrap().id);
    assert_eq!(raw.status,"failed");assert!(raw.logs.iter().any(|l|l.message.contains("原始 RC1")));
    assert!(state.lock().unwrap().manual.is_empty(),"unsupported raw channels fail before input preparation");
    let run=flight_test::start(fixture("long"),channel_options).unwrap();
    let deadline=Instant::now()+Duration::from_secs(4);
    while flight_test::status().status!="running" {assert!(Instant::now()<deadline);thread::sleep(Duration::from_millis(10));}
    state.lock().unwrap().rc_mode=Some(3);
    let changed=wait_done(run.id);assert_eq!(changed.status,"failed");
    assert!(changed.logs.iter().any(|l|l.message.contains("COM_RC_IN_MODE")));
    {
        let mut s = state.lock().unwrap();
        s.manual.clear();
        s.commands.clear();
        s.rc_mode = Some(1);
        s.hil = false;
    }
    thread::sleep(Duration::from_millis(80));
    let done = wait_done(
        flight_test::start(fixture("live"), options.clone())
            .unwrap()
            .id,
    );
    assert_eq!(done.status, "failed");
    assert!(state.lock().unwrap().manual.is_empty());
    {
        let mut s = state.lock().unwrap();
        s.hil = true;
        s.ignore_posctl = true;
        s.mode = 4;
    }
    thread::sleep(Duration::from_millis(80));
    let done = wait_done(
        flight_test::start(fixture("mode"), options.clone())
            .unwrap()
            .id,
    );
    assert_eq!(
        done.status, "failed",
        "ACK alone cannot complete a mode change"
    );
    assert!(done.logs.iter().any(|l| l.message.contains("timeout")));
    let source=fixture("mode").replace("end=\"60\"","end=\"0.15\"").replace("<set name=\"test/command/b1_2/request\" value=\"1\"/>","<set name=\"test/command/b1_2/request\" value=\"1\"/><set name=\"test/runtime/complete\" value=\"1\"/>");
    assert!(source.contains("end=\"0.15\""));
    let done = wait_done(flight_test::start(source, options.clone()).unwrap().id);
    assert_eq!(
        done.status, "failed",
        "raw XML complete cannot bypass command state confirmation"
    );
    assert!(done.logs.iter().any(|l| l.message.contains("双确认")));
    let source="<runscript><run end='1'><property value='3'>test/command/q/kind</property><property value='3'>test/command/q/argument</property><property value='1'>test/command/q/request</property><property value='0'>test/input/p/enabled</property><property value='1'>test/input/p/mask</property><event><condition>simulation/sim-time-sec ge .05</condition><set name='test/input/p/enabled' value='1'/></event></run></runscript>";
    let done = wait_done(
        flight_test::start(source.into(), options.clone())
            .unwrap()
            .id,
    );
    assert_eq!(done.status, "failed");
    assert!(
        done.logs.iter().any(|l| l.message.contains("重叠")),
        "delayed input cannot overlap an in-flight state command"
    );
    {
        let mut s = state.lock().unwrap();
        s.ignore_posctl = false;
        s.reject_posctl = true;
        s.mode = 4;
    }
    thread::sleep(Duration::from_millis(80));
    let done = wait_done(
        flight_test::start(fixture("mode"), options.clone())
            .unwrap()
            .id,
    );
    assert_eq!(done.status, "failed");
    assert!(done.logs.iter().any(|l| l.message.contains("拒绝")));
    {
        let mut s = state.lock().unwrap();
        s.reject_posctl = false;
        s.mode = 3;
    }
    thread::sleep(Duration::from_millis(80));
    let run = flight_test::start(fixture("long"), options.clone()).unwrap();
    thread::sleep(Duration::from_millis(150));
    let done = flight_test::stop(Some(run.id)).unwrap();
    assert_eq!(done.status, "stopped");
    let count = state.lock().unwrap().manual.len();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        state.lock().unwrap().manual.len(),
        count,
        "no old control frames after stop"
    );
    let run = flight_test::start(fixture("long"), options.clone()).unwrap();
    // Pause after preparation, so this exercises the executing runner rather
    // than whichever receiver-preparation check happens to observe the pause.
    let active_deadline = Instant::now() + Duration::from_secs(4);
    while flight_test::status().status != "running" {
        assert!(Instant::now() < active_deadline, "wait for running before pausing the simulator");
        thread::sleep(Duration::from_millis(10));
    }
    scene_telemetry::PAUSED.store(true, Ordering::Relaxed);
    let done = wait_done(run.id);
    assert_eq!(done.status, "failed");
    assert!(done.logs.iter().any(|l| l.message.contains("仿真实例")));
    scene_telemetry::PAUSED.store(false, Ordering::Relaxed);
    {
        let mut s = state.lock().unwrap();
        s.manual.clear();
        s.commands.clear();
    }
    let run = flight_test::start(fixture("long"), options.clone()).unwrap();
    let active_deadline=Instant::now()+Duration::from_secs(4);
    while !state.lock().unwrap().manual.last().is_some_and(|(_,v)|v[1]==200) {
        assert!(Instant::now()<active_deadline,"wait for active input before changing identity");thread::sleep(Duration::from_millis(10));
    }
    let streams_before_identity_change = state.lock().unwrap().streams.len();
    state.lock().unwrap().uid = 0xbcde;
    let done = wait_done(run.id);
    assert_eq!(done.status, "failed");
    assert!(done.exit_result.contains("未确认"));
    assert!(
        state.lock().unwrap().commands.is_empty(),
        "never send an exit command to a different FC identity"
    );
    assert_eq!(state.lock().unwrap().streams.len(), streams_before_identity_change, "identity change also inhibits stream cleanup commands");
    assert_eq!(
        state.lock().unwrap().manual.last().unwrap().1[1],
        200,
        "identity change stops even neutral control frames"
    );
    // Source changes are explicit, mutually exclusive, and never retried as writes.
    assert!(flight_test::receiver::select(options.clone(),0).unwrap_err().contains("上锁"));
    assert!(state.lock().unwrap().source_writes.is_empty());
    {let mut s=state.lock().unwrap();s.armed=false;s.landed=true;s.land_at=None;}
    thread::sleep(Duration::from_millis(100));
    let physical=flight_test::receiver::select(options.clone(),0).unwrap();
    assert!(physical.ready&&physical.actual==Some(0));
    let switching_options=options.clone();
    let switching=thread::spawn(move||flight_test::receiver::select(switching_options,1));
    for _ in 0..100 {if flight_test::receiver::busy(){break;}thread::sleep(Duration::from_millis(5));}
    assert!(flight_test::start(fixture("live"),options.clone()).err().unwrap().contains("切换"));
    assert!(flight_test::receiver::select(options.clone(),0).unwrap_err().contains("切换"));
    let simulated=switching.join().unwrap().unwrap();
    assert!(simulated.ready&&simulated.actual==Some(1)&&simulated.idle_sending);
    assert!(flight_test::guard_pin(info.session_id,"127.0.0.1:9".parse().unwrap()).is_err(),"an idle receiver cannot be silently redirected to another peer");
    let idle_frames=state.lock().unwrap().manual.len();thread::sleep(Duration::from_millis(120));
    assert!(state.lock().unwrap().manual.len()>=idle_frames+3,"idle input continues without UI polling");
    assert_eq!(state.lock().unwrap().source_writes,vec![0,1]);
    let mut preview=options.clone();preview.dry_run=true;
    let before_preview=state.lock().unwrap().manual.len();
    let preview_run=flight_test::start(fixture("long"),preview).unwrap();
    thread::sleep(Duration::from_millis(160));
    assert!(state.lock().unwrap().manual.len()>=before_preview+3,"offline preview keeps the existing idle receiver alive");
    flight_test::stop(Some(preview_run.id)).unwrap();
    let mut handover=options.clone();handover.on_finish="release".into();
    let completed=wait_done(flight_test::start(fixture("live"),handover).unwrap().id);
    assert_eq!(completed.status,"passed","{:?}",completed.logs.iter().map(|l|&l.message).collect::<Vec<_>>());
    thread::sleep(Duration::from_millis(100));
    assert!(flight_test::receiver::status(options.clone()).unwrap().idle_sending);
    flight_test::receiver::select(options.clone(),0).unwrap();
    let stopped_frames=state.lock().unwrap().manual.len();thread::sleep(Duration::from_millis(100));
    assert_eq!(state.lock().unwrap().manual.len(),stopped_frames,"physical selection stops idle simulation output");
    state.lock().unwrap().reject_source=true;
    let before=state.lock().unwrap().source_writes.len();
    assert!(flight_test::receiver::select(options.clone(),1).unwrap_err().contains("未确认"));
    assert_eq!(state.lock().unwrap().source_writes.len(),before+1,"a rejected write must never be retried");
    state.lock().unwrap().reject_source=false;
    assert!(!flight_test::receiver::status(options.clone()).unwrap().idle_sending);
    state.lock().unwrap().rc_mode=Some(1);thread::sleep(Duration::from_millis(80));
    let run = flight_test::start_run(fixture("long"), options.clone(), None, archive()).unwrap();
    thread::sleep(Duration::from_millis(150));
    state.lock().unwrap().silent = true;
    let done = wait_done(run.id);
    assert_eq!(done.status, "failed");
    assert!(done.exit_result.contains("未确认"));
    alive.store(false, Ordering::Relaxed);
    server.join().unwrap();
    let lost_id = flight_test::flight_test_report().unwrap()["archiveId"].as_str().unwrap().to_owned();
    let lost_html = check_archive(&lost_id, "failed", "unconfirmed");
    assert!(lost_html.contains("失败定位"));
    tool_transport::manager().close(info.session_id).unwrap();

    let preflight = flight_test::start_run(fixture("live"), options.clone(), None, archive()).unwrap();
    assert_eq!(wait_done(preflight.id).status, "failed");
    let preflight_id = flight_test::flight_test_report().unwrap()["archiveId"].as_str().unwrap().to_owned();
    assert!(check_archive(&preflight_id, "failed", "notRequired").contains("本次运行未采集到轨迹"));

    // Preserve a terminal capture when the archive directory cannot be created.
    let blocked = archive_dir.join("blocked");
    std::fs::write(&blocked, b"existing file").unwrap();
    let mut dry = options;
    dry.dry_run = true;
    let stopped = flight_test::start_run(fixture("long"), dry.clone(), None,
        Some((Ok(blocked), flight_test::report::Metadata::default()))).unwrap();
    assert_eq!(flight_test::stop(Some(stopped.id)).unwrap().status, "stopped");
    let stopped_id = flight_test::flight_test_report().unwrap()["archiveId"].as_str().unwrap().to_owned();
    let next = flight_test::start_run(fixture("live"), dry.clone(), None, archive()).unwrap();
    assert_eq!(wait_done(next.id).status, "passed");
    let timed_out = flight_test::start_run(fixture("timeout"), dry, None, archive()).unwrap();
    assert_eq!(wait_done(timed_out.id).status, "failed");
    let timeout_id = flight_test::flight_test_report().unwrap()["archiveId"].as_str().unwrap().to_owned();
    let timeout_html = check_archive(&timeout_id, "failed", "simulated");
    assert!(timeout_html.contains("失败定位") && timeout_html.contains("timeout"));
    assert!(timeout_html.contains("<canvas"));
    flight_test::report::wait_for_writes();

    let history = serde_json::to_value(flight_test::report::list(&archive_dir).unwrap()).unwrap();
    assert!(history.as_array().unwrap().iter().any(|entry| entry["id"] == stopped_id && entry["state"] == "failed"));
    flight_test::report::retry(archive_dir.clone(), stopped_id.clone()).unwrap();
    assert!(check_archive(&stopped_id, "stopped", "simulated").contains("离线预演"));
    assert_eq!(flight_test::report::list(&archive_dir).unwrap().len(), 6);
    let first_html = flight_test::report::html_path(&archive_dir, &first_archive).unwrap();
    let mut legacy: serde_json::Value = serde_json::from_slice(&std::fs::read(first_html.with_extension("json")).unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("archiveId");
    let legacy_result = legacy["result"].as_object_mut().unwrap();
    for field in ["outcome", "reportStages", "aircraftLabel"] { legacy_result.remove(field); }
    std::fs::write(archive_dir.join("test-123-7.json"), serde_json::to_vec(&legacy).unwrap()).unwrap();
    let history = serde_json::to_value(flight_test::report::list(&archive_dir).unwrap()).unwrap();
    assert!(history.as_array().unwrap().iter().any(|entry| entry["id"] == "test-123-7" && entry["state"] == "recorded"));
    flight_test::report::retry(archive_dir.clone(), "test-123-7".into()).unwrap();
    flight_test::report::wait_for_writes();
    assert!(flight_test::report::html_path(&archive_dir, "test-123-7").is_ok());
    assert!(flight_test::report::html_path(&archive_dir, "../outside").is_err());
    std::fs::remove_dir_all(&archive_dir).unwrap();
}

#[test]
fn manual_attitude_excitation_stops_on_diverging_rate_before_next_command() {
    let mut e = engine("attitude_hold");
    e.set("test/rc/input-kind", 1.);
    angle_feedback(&mut e, 1., [1., 0., 0., 0.], [0., 2.2, 0.]);
    assert!(e.tick(0.).unwrap_err().contains("手动姿态激励异常"));
    let mut e = engine("attitude_hold");
    e.set("test/rc/input-kind", 1.);
    let q = [35_f64.to_radians().cos(), 35_f64.to_radians().sin(), 0., 0.];
    angle_feedback(&mut e, 1., q, [0.; 3]);
    assert!(e.tick(0.).unwrap_err().contains("手动姿态激励异常"));
}

#[test]
fn f450_joint_hover_profile_parses_with_production_engine() {
    let source=include_str!("../../examples/flight-tests/f450-hover/hover.xml");
    let script=flight_test::xml::parse(source).unwrap();
    assert!(script.name.contains("F450"));
    assert_eq!(script.end,180.0);
    assert!(script.events.iter().any(|event|event.name.contains("::HOVER_BEGIN")));
    assert!(script.events.iter().any(|event|event.name.contains("::HOVER_END")));
    assert!(source.contains("<use aircraft=\"F450_PX4\" initialize=\"current-instance\""));
}
mod px4_firmware {
    thread_local! { pub static BUSY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
    pub fn busy()->bool {BUSY.with(|v|v.get())}
    #[derive(serde::Serialize)] pub struct Target {pub path:String,pub simulator:String}
    pub fn ports()->Result<Vec<Target>,String>{Err("offline test".into())}
    pub fn library_list()->Result<serde_json::Value,String>{Err("offline test".into())}
    pub fn library_select(_:String,_:String)->Result<serde_json::Value,String>{Err("offline test".into())}
    pub fn status()->Result<serde_json::Value,String>{Ok(serde_json::json!({}))}
    pub fn local(_:&std::path::Path)->Result<serde_json::Value,String>{Err("offline test".into())}
    pub fn remote_file(_:String)->Result<serde_json::Value,String>{Err("offline test".into())}
    pub fn start(_:u64,_:Target)->Result<serde_json::Value,String>{Err("offline test".into())}
    pub fn cancel(_:u64)->Result<serde_json::Value,String>{Err("offline test".into())}
}

#[test]
fn firmware_upgrade_keeps_heartbeat_but_refuses_other_toolbox_commands() {
    px4_firmware::BUSY.with(|v| v.set(true));
    let heartbeat = flight_test::mavlink::encode(0, &[0,0,0,0,6,8,0,4,3], 0);
    assert!(flight_test::guard_write(&heartbeat).is_ok());
    for command in [246,400,512] {
        let frame=flight_test::mavlink::command((1,1),command,[1.,0.,0.,0.,0.,0.,0.],0);
        assert!(flight_test::guard_write(&frame).unwrap_err().contains("固件升级"));
    }
    px4_firmware::BUSY.with(|v| v.set(false));
}
