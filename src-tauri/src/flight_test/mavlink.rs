//! Minimal common.xml wire codec. Accept only checked, unsigned telemetry.
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
pub const SYSTEM: u8 = 254;
pub const COMPONENT: u8 = 191;
pub fn spec(id: u32) -> Option<(u8, usize)> {
    Some(match id {
        0 => (50, 9),
        1 => (124, 43),
        20 => (214, 20),
        22 => (220, 25),
        23 => (168, 23),
        30 => (39, 28),
        31 => (246, 48),
        32 => (185, 28),
        33 => (104, 28),
        65 => (118, 42),
        69 => (243, 30),
        70 => (124, 38),
        76 => (152, 33),
        77 => (143, 10),
        148 => (178, 78),
        245 => (130, 2),
        _ => return None,
    })
}
pub fn crc(bytes: &[u8], extra: u8) -> u16 {
    let mut c = 0xffffu16;
    for b in bytes.iter().chain(std::iter::once(&extra)) {
        let mut t = *b ^ (c as u8);
        t ^= t << 4;
        c = (c >> 8) ^ ((t as u16) << 8) ^ ((t as u16) << 3) ^ ((t as u16) >> 4);
    }
    c
}
pub fn encode(id: u32, payload: &[u8], sequence: u8) -> Vec<u8> {
    let (extra, max) = spec(id).expect("known outgoing message");
    assert!(payload.len() <= max);
    let mut length = payload.len();
    while length > 1 && payload[length - 1] == 0 {
        length -= 1;
    }
    let mut bytes = vec![
        253,
        length as u8,
        0,
        0,
        sequence,
        SYSTEM,
        COMPONENT,
        id as u8,
        (id >> 8) as u8,
        (id >> 16) as u8,
    ];
    bytes.extend_from_slice(&payload[..length]);
    let sum = crc(&bytes[1..], extra);
    bytes.extend_from_slice(&sum.to_le_bytes());
    bytes
}
#[derive(Clone, Debug)]
pub struct Frame {
    pub id: u32,
    pub system: u8,
    pub component: u8,
    pub payload: Vec<u8>,
    pub signed: bool,
}
#[derive(Default)]
pub struct Parser {
    buffer: Vec<u8>,
}
impl Parser {
    pub fn push(&mut self, data: &[u8], datagram: bool) -> Vec<Frame> {
        if datagram {
            self.buffer.clear();
        }
        if self.buffer.len() + data.len() > 131072 {
            self.buffer.clear();
        }
        self.buffer.extend_from_slice(data);
        let mut offset = 0;
        let mut result = Vec::new();
        while self.buffer.len().saturating_sub(offset) >= 8 {
            let b = &self.buffer[offset..];
            let v2 = b[0] == 253;
            if !v2 && b[0] != 254 {
                offset += 1;
                continue;
            }
            let header = if v2 { 10 } else { 6 };
            if b.len() < header {
                break;
            }
            if v2 && b[2] & !1 != 0 {
                offset += 1;
                continue;
            }
            let len = b[1] as usize;
            let signed = v2 && b[2] & 1 != 0;
            let total = header + len + 2 + if signed { 13 } else { 0 };
            let id = if v2 {
                u32::from(b[7]) | (u32::from(b[8]) << 8) | (u32::from(b[9]) << 16)
            } else {
                u32::from(b[5])
            };
            if b.len() < total {
                break;
            }
            if let Some((extra, max)) = spec(id) {
                if len <= max
                    && crc(&b[1..header + len], extra)
                        == u16::from_le_bytes([b[header + len], b[header + len + 1]])
                {
                    let mut payload = vec![0; max];
                    payload[..len].copy_from_slice(&b[header..header + len]);
                    result.push(Frame {
                        id,
                        system: b[if v2 { 5 } else { 3 }],
                        component: b[if v2 { 6 } else { 4 }],
                        payload,
                        signed,
                    });
                    offset += total;
                    continue;
                }
            }
            offset += 1;
        }
        self.buffer.drain(..offset);
        if datagram {
            self.buffer.clear();
        }
        result
    }
}
#[derive(Clone, Debug)]
pub struct Ack {
    pub command: u16,
    pub result: u8,
    pub at: Instant,
}
#[derive(Clone, Default)]
pub struct Telemetry {
    pub target: Option<(u8, u8)>,
    pub heartbeat: Option<Instant>,
    pub hil: bool,
    pub armed: bool,
    pub mode: u8,
    pub generation: u64,
    pub uid: Option<u64>,
    pub flight_sw_version: Option<u32>,
    pub samples: BTreeMap<String, (f64, Instant)>,
    pub acks: BTreeMap<u16, Ack>,
    pub params: BTreeMap<String, (f64, u16, Instant)>,
    pub signed: bool,
    pub boot_ms: Option<u32>,
    pub param_bytewise: bool,
    pub rc_channels: Option<([u16; 18], Instant)>,
    pub rc_health: Option<(bool, Instant)>,
    pub manual_control: Option<([i16; 4], Instant)>,
}
fn u32_at(p: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(p[i..i + 4].try_into().unwrap())
}
fn f32_at(p: &[u8], i: usize) -> f64 {
    f32::from_le_bytes(p[i..i + 4].try_into().unwrap()) as f64
}
impl Telemetry {
    pub fn ingest(&mut self, frame: &Frame, now: Instant) {
        if frame.component != 1 {
            return;
        }
        let p = &frame.payload;
        if self.target.is_none() && frame.id == 0 && p[5] == 12 {
            self.target = Some((frame.system, frame.component));
            self.param_bytewise = true;
        }
        if self.target != Some((frame.system, frame.component)) {
            return;
        }
        if frame.signed {
            self.signed = true;
            return;
        }
        let mut values = Vec::new();
        match frame.id {
            0 => {
                if p[5] != 12 {
                    return;
                }
                let custom = u32_at(p, 0);
                let main = (custom >> 16) as u8;
                let sub = (custom >> 24) as u8;
                self.mode = match (main, sub) {
                    (4, 3) => 4,
                    (4, 6) => 8,
                    (4, 2) => 9,
                    (1, _) => 1,
                    (2, _) => 2,
                    (3, _) => 3,
                    (5, _) => 5,
                    (6, _) => 6,
                    (7, _) => 7,
                    _ => 0,
                };
                self.hil = p[6] & 32 != 0;
                self.armed = p[6] & 128 != 0;
                self.heartbeat = Some(now);
                values.extend([
                    ("armed", self.armed as u8 as f64),
                    ("hil", self.hil as u8 as f64),
                    ("mode", self.mode as f64),
                ]);
            }
            30 | 31 => {
                let boot = u32_at(p, 0);
                if self
                    .boot_ms
                    .is_some_and(|old| boot.saturating_add(1000) < old && old - boot < 0xffff0000)
                {
                    self.generation += 1;
                    self.flight_sw_version = None;
                }
                self.boot_ms = Some(boot);
                if frame.id == 31 {
                    for (i, name) in [
                        "q1",
                        "q2",
                        "q3",
                        "q4",
                        "roll-rate-rad-s",
                        "pitch-rate-rad-s",
                        "yaw-rate-rad-s",
                    ]
                    .iter()
                    .enumerate()
                    {
                        values.push((*name, f32_at(p, 4 + i * 4)));
                    }
                } else {
                    let roll = f32_at(p, 4).to_degrees();
                    let pitch = f32_at(p, 8).to_degrees();
                    values.extend([
                        ("roll-deg", roll),
                        ("roll-abs-deg", roll.abs()),
                        ("pitch-deg", pitch),
                        ("pitch-abs-deg", pitch.abs()),
                        ("yaw-deg", f32_at(p, 12).to_degrees()),
                    ]);
                }
            }
            32 => {
                values.extend([
                    ("local-x-m", f32_at(p, 4)),
                    ("local-y-m", f32_at(p, 8)),
                    ("local-z-m", f32_at(p, 12)),
                    ("local-vx-mps", f32_at(p, 16)),
                    ("local-vy-mps", f32_at(p, 20)),
                ]);
            }
            33 => {
                let alt = i32::from_le_bytes(p[12..16].try_into().unwrap()) as f64 / 1000.;
                let relative = i32::from_le_bytes(p[16..20].try_into().unwrap()) as f64 / 1000.;
                let vx = i16::from_le_bytes(p[20..22].try_into().unwrap()) as f64 / 100.;
                let vy = i16::from_le_bytes(p[22..24].try_into().unwrap()) as f64 / 100.;
                let climb = -(i16::from_le_bytes(p[24..26].try_into().unwrap()) as f64) / 100.;
                values.extend([
                    ("altitude-msl-m", alt),
                    ("relative-alt-m", relative),
                    ("groundspeed-mps", vx.hypot(vy)),
                    ("climb-rate-mps", climb),
                ]);
            }
            1 => {
                const RC: u32 = 1 << 16;
                self.rc_health = Some((u32_at(p, 0) & RC != 0 && u32_at(p, 8) & RC != 0, now));
            }
            65 => {
                if p[40] >= 4 && p[41] != 0 {
                    let raw = std::array::from_fn(|i| if i < p[40] as usize {
                        u16::from_le_bytes(p[4 + i * 2..6 + i * 2].try_into().unwrap())
                    } else { u16::MAX });
                    self.rc_channels = Some((raw, now));
                } else { self.rc_channels = None; }
            }
            69 => {
                if p[10] == frame.system {
                    let axes = std::array::from_fn(|i| i16::from_le_bytes(p[i*2..i*2+2].try_into().unwrap()));
                    if (-1000..=1000).contains(&axes[0]) && (-1000..=1000).contains(&axes[1])
                        && (0..=1000).contains(&axes[2]) && (-1000..=1000).contains(&axes[3]) {
                        self.manual_control = Some((axes, now));
                    }
                }
            }
            245 => {
                if p[1] != 0 {
                    values.push(("landed", if p[1] == 1 { 1. } else { 0. }));
                }
            }
            148 => {
                let uid = u64::from_le_bytes(p[8..16].try_into().unwrap());
                if self.uid.is_some_and(|old| old != uid && uid != 0) {
                    self.generation += 1;
                }
                if uid != 0 {
                    self.uid = Some(uid);
                }
                let version = u32_at(p, 16);
                self.flight_sw_version = (version != 0).then_some(version);
                let flags = u64::from_le_bytes(p[0..8].try_into().unwrap());
                self.param_bytewise = flags & 16 != 0 || flags & 131072 == 0;
            }
            22 => {
                let name = std::str::from_utf8(&p[8..24])
                    .unwrap_or("")
                    .trim_end_matches('\0');
                if [
                    "MPC_MAN_TILT_MAX",
                    "MPC_TILTMAX_AIR",
                    "MPC_MAN_Y_MAX",
                    "MAN_DEADZONE",
                    "VEC_HEAD_RATE",
                    "VEC_REF_EN",
                    "VEC_ATT_MAX",
                    "VEC_ATT_RATE",
                    "CA_MQ_ARANGE",
                    "CA_MQ_BRANGE",
                    "COM_RC_IN_MODE",
                ]
                .contains(&name)
                    || super::channels::is_parameter(name) || super::xcd20::is_parameter(name)
                {
                    if ![6, 9].contains(&p[24]) { return; }
                    let value = if p[24] == 6 && self.param_bytewise {
                        i32::from_le_bytes(p[0..4].try_into().unwrap()) as f64
                    } else {
                        f32_at(p, 0)
                    };
                    if value.is_finite() {
                        self.params
                            .insert(name.into(), (value, u16::from_le_bytes([p[6], p[7]]), now));
                    }
                }
            }
            77 => {
                let command = u16::from_le_bytes([p[0], p[1]]);
                if [176, 400, 22, 21, 511].contains(&command)
                    && (p[8] == 0 || p[8] == SYSTEM)
                    && (p[9] == 0 || p[9] == COMPONENT)
                {
                    self.acks.insert(
                        command,
                        Ack {
                            command,
                            result: p[2],
                            at: now,
                        },
                    );
                }
            }
            _ => {}
        }
        for (name, value) in values {
            if value.is_finite() {
                self.samples.insert(format!("test/fc/{name}"), (value, now));
            }
        }
    }
    pub fn fresh(&self, now: Instant) -> bool {
        self.heartbeat
            .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_millis(2000))
            && !self.signed
    }
    pub fn values(&self, now: Instant) -> BTreeMap<String, f64> {
        self.samples
            .iter()
            .filter(|(key, (_, at))| {
                let fast = matches!(
                    key.as_str(),
                    "test/fc/q1"
                        | "test/fc/q2"
                        | "test/fc/q3"
                        | "test/fc/q4"
                        | "test/fc/roll-rate-rad-s"
                        | "test/fc/pitch-rate-rad-s"
                        | "test/fc/yaw-rate-rad-s"
                );
                now.saturating_duration_since(*at)
                    < Duration::from_millis(if fast { 250 } else { 1500 })
            })
            .map(|(key, (value, _))| (key.clone(), *value))
            .collect()
    }
}
pub fn manual(target: u8, values: [f64; 4], sequence: u8) -> Vec<u8> {
    manual_with_aux(target, values, [0.; 2], sequence)
}
pub fn manual_with_aux(target: u8, values: [f64; 4], aux: [f64; 2], sequence: u8) -> Vec<u8> {
    manual_with_channels(target, values, [aux[0], aux[1], 0., 0., 0., 0.], sequence)
}
pub fn manual_with_channels(target: u8, values: [f64; 4], aux: [f64; 6], sequence: u8) -> Vec<u8> {
    manual_with_buttons(target, values, aux, 0, sequence)
}
pub fn manual_with_buttons(target: u8, values: [f64; 4], aux: [f64; 6], buttons: u16, sequence: u8) -> Vec<u8> {
    let mut p = vec![0; 30];
    for (i, value) in [values[1], values[0], values[3], values[2]]
        .iter()
        .enumerate()
    {
        p[i * 2..i * 2 + 2].copy_from_slice(&((*value * 1000.).round() as i16).to_le_bytes());
    }
    p[10] = target;
    p[8..10].copy_from_slice(&buttons.to_le_bytes());
    // All six AUX extensions are explicit, including neutral/exit zeroes.
    p[13] = 0xfc;
    for (i, value) in aux.iter().enumerate() {
        p[18 + i * 2..20 + i * 2].copy_from_slice(&((*value * 1000.).round() as i16).to_le_bytes());
    }
    encode(69, &p, sequence)
}
pub fn rc_channels(target: (u8, u8), channels: [u16; 18], sequence: u8) -> Vec<u8> {
    let mut p = vec![0; 38];
    for (i, value) in channels.iter().enumerate() {
        let offset = if i < 8 { i * 2 } else { 18 + (i - 8) * 2 };
        p[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }
    p[16] = target.0;
    p[17] = target.1;
    encode(70, &p, sequence)
}
pub fn command(target: (u8, u8), id: u16, args: [f32; 7], sequence: u8) -> Vec<u8> {
    let mut p = vec![0; 33];
    for (i, v) in args.iter().enumerate() {
        p[4 * i..4 * i + 4].copy_from_slice(&v.to_le_bytes());
    }
    p[28..30].copy_from_slice(&id.to_le_bytes());
    p[30] = target.0;
    p[31] = target.1;
    encode(76, &p, sequence)
}
pub fn request_param_named(target: (u8, u8), name: &str, sequence: u8) -> Vec<u8> {
    assert!(name.len() <= 16);
    let mut p = vec![0; 20];
    p[0..2].copy_from_slice(&(-1i16).to_le_bytes());
    p[2] = target.0;
    p[3] = target.1;
    p[4..4 + name.len()].copy_from_slice(name.as_bytes());
    encode(20, &p, sequence)
}
pub fn set_int_parameter(target: (u8,u8), name: &str, value: i32, bytewise: bool, sequence: u8) -> Vec<u8> {
    assert!(name.len() <= 16);
    let mut p=vec![0;23];p[..4].copy_from_slice(&if bytewise{value.to_le_bytes()}else{(value as f32).to_le_bytes()});
    p[4]=target.0;p[5]=target.1;p[6..6+name.len()].copy_from_slice(name.as_bytes());p[22]=6;encode(23,&p,sequence)
}
pub fn mode_args(mode: u8) -> Result<[f32; 7], String> {
    let (main, sub) = match mode {
        1 => (1, 0),
        2 => (2, 0),
        3 => (3, 0),
        4 => (4, 3),
        5 => (5, 0),
        6 => (6, 0),
        7 => (7, 0),
        _ => return Err("模式代码无效".into()),
    };
    Ok([1., main as f32, sub as f32, 0., 0., 0., 0.])
}

#[cfg(test)]
mod manual_source_codec_tests {
    use super::*;
    #[test]
    fn existing_input_parameter_and_logical_switch_use_standard_messages(){
        for source in [0,1]{for bytewise in [false,true]{
            let frames=Parser::default().push(&set_int_parameter((7,1),"COM_RC_IN_MODE",source,bytewise,0),true);
            let f=&frames[0];assert_eq!(f.id,23);assert_eq!(&f.payload[4..6],&[7,1]);assert_eq!(&f.payload[6..20],b"COM_RC_IN_MODE");
            assert_eq!(&f.payload[..4],&if bytewise{source.to_le_bytes()}else{(source as f32).to_le_bytes()});
        }}
        let frame=Parser::default().push(&manual_with_buttons(7,[0.;4],[0.5,-0.5,0.,0.,0.,0.],1,0),true).remove(0);
        assert_eq!(frame.id,69);assert_eq!(&frame.payload[8..10],&[1,0]);assert_eq!(i16::from_le_bytes(frame.payload[18..20].try_into().unwrap()),500);
    }
    #[test]
    fn manual_feedback_requires_the_current_flight_controller(){
        let now=Instant::now();let mut t=Telemetry{target:Some((7,1)),..Default::default()};
        let mut frame=Parser::default().push(&manual(7,[0.1,-0.2,0.3,0.4],0),true).remove(0);
        frame.system=8;frame.component=1;t.ingest(&frame,now);assert!(t.manual_control.is_none());
        frame.system=7;t.ingest(&frame,now);assert_eq!(t.manual_control,Some(([-200,100,400,300],now)));
    }
}
