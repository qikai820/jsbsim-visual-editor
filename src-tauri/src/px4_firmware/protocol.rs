//! PX4 serial bootloader protocol, following PX4's Tools/px_uploader.py.
//! CRC starts at zero, has no final XOR, and covers the entire application flash.
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::time::Duration;
#[cfg(test)]
use std::{
    io::{Read, Write},
    time::Instant,
};

pub const MAX_PACKAGE: usize = 32 * 1024 * 1024;
pub const MAX_IMAGE: usize = 16 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub name: String,
    pub source: String,
    pub board_id: u32,
    pub board_revision: u32,
    pub image_size: usize,
    pub description: String,
    pub git_identity: String,
}
pub struct Firmware {
    pub info: ImageInfo,
    pub image: Vec<u8>,
}
#[derive(Deserialize)]
struct Package {
    magic: String,
    board_id: u32,
    image_size: usize,
    image: String,
    #[serde(default)]
    board_revision: u32,
    #[serde(default)]
    description: String,
    #[serde(default)]
    git_identity: String,
}
impl Firmware {
    pub fn parse(name: String, source: String, bytes: &[u8]) -> Result<Self, String> {
        if !name.to_ascii_lowercase().ends_with(".px4") {
            return Err("请选择包含板型信息的 .px4 固件包".into());
        }
        if bytes.len() > MAX_PACKAGE {
            return Err("固件包超过 32 MiB".into());
        }
        let package: Package =
            serde_json::from_slice(bytes).map_err(|e| format!("无效 PX4 固件包：{e}"))?;
        if package.magic != "PX4FWv1"
            || package.board_id == 0
            || !(4..=MAX_IMAGE).contains(&package.image_size)
        {
            return Err("固件包标识、板型或镜像大小无效".into());
        }
        let compressed = base64::engine::general_purpose::STANDARD
            .decode(&package.image)
            .map_err(|e| format!("固件 Base64 解码失败：{e}"))?;
        let mut image = Vec::with_capacity(package.image_size + 1);
        let mut decoder = flate2::Decompress::new(true);
        let result = decoder
            .decompress_vec(&compressed, &mut image, flate2::FlushDecompress::Finish)
            .map_err(|e| format!("固件解压失败：{e}"))?;
        if result != flate2::Status::StreamEnd
            || decoder.total_in() != compressed.len() as u64
            || image.len() != package.image_size
        {
            return Err("固件压缩流不完整或解压长度与 image_size 不一致".into());
        }
        while image.len() % 4 != 0 {
            image.push(0xff);
        }
        Ok(Self {
            info: ImageInfo {
                name,
                source,
                board_id: package.board_id,
                board_revision: package.board_revision,
                image_size: package.image_size,
                description: package.description,
                git_identity: package.git_identity,
            },
            image,
        })
    }
    pub fn crc(&self, flash_size: usize) -> u32 {
        let mut crc = 0u32;
        for byte in self
            .image
            .iter()
            .copied()
            .chain(std::iter::repeat(0xff).take(flash_size.saturating_sub(self.image.len())))
        {
            crc ^= byte as u32;
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320u32 & 0u32.wrapping_sub(crc & 1));
            }
        }
        crc
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub protocol: u32,
    pub board_id: u32,
    pub board_revision: u32,
    pub flash_size: usize,
}
pub trait Wire {
    fn exchange(
        &mut self,
        command: &[u8],
        response_size: usize,
        timeout: Duration,
    ) -> Result<Vec<u8>, String>;
    fn reboot(&mut self, acknowledge: bool) -> Result<(), String> {
        let _ = acknowledge;
        self.exchange(&[0x30], 0, Duration::from_secs(3))
            .map(|_| ())
    }
}
#[cfg(test)]
pub struct SerialWire(pub Box<dyn serialport::SerialPort>);
#[cfg(test)]
impl Wire for SerialWire {
    fn reboot(&mut self, acknowledge: bool) -> Result<(), String> {
        if acknowledge {
            self.exchange(&[0x30], 0, Duration::from_secs(3))
                .map(|_| ())
        } else {
            self.0
                .write_all(&[0x30, 0x20])
                .map_err(|e| format!("发送重启失败：{e}"))
        }
    }
    fn exchange(
        &mut self,
        command: &[u8],
        response_size: usize,
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        self.0
            .set_timeout(Duration::from_millis(100))
            .map_err(|e| e.to_string())?;
        let mut packet = command.to_vec();
        packet.push(0x20);
        self.0
            .write_all(&packet)
            .map_err(|e| format!("USB 写入失败：{e}"))?;
        let deadline = Instant::now() + timeout;
        let mut response = vec![0; response_size + 2];
        let mut offset = 0;
        while offset < response.len() {
            if Instant::now() >= deadline {
                return Err("Bootloader 响应超时，请检查 USB 连接".into());
            }
            match self.0.read(&mut response[offset..]) {
                Ok(0) => return Err("USB 连接已断开".into()),
                Ok(n) => offset += n,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                            | std::io::ErrorKind::WouldBlock
                    ) => {}
                Err(e) => return Err(format!("USB 读取失败：{e}")),
            }
        }
        ack_response(response, response_size)
    }
}
pub fn ack_response(mut response: Vec<u8>, response_size: usize) -> Result<Vec<u8>, String> {
    if response.len() != response_size + 2 {
        return Err("Bootloader 响应长度错误".into());
    }
    match response[response_size..] {
        [0x12, 0x10] => {
            response.truncate(response_size);
            Ok(response)
        }
        [0x12, 0x14] => Err("Bootloader 拒绝刷写：不支持当前芯片版本".into()),
        [0x12, code] => Err(format!("Bootloader 操作失败，状态 0x{code:02x}")),
        _ => Err("Bootloader 响应不同步".into()),
    }
}

pub fn identify(wire: &mut impl Wire) -> Result<Board, String> {
    let timeout = Duration::from_millis(600);
    wire.exchange(&[0x21], 0, timeout)?;
    let mut info = |field| -> Result<u32, String> {
        let value = wire.exchange(&[0x22, field], 4, timeout)?;
        Ok(u32::from_le_bytes(
            value.try_into().map_err(|_| "Bootloader 信息长度错误")?,
        ))
    };
    let protocol = info(1)?;
    if !(2..=5).contains(&protocol) {
        return Err(format!("不支持 Bootloader 协议版本 {protocol}（支持 2–5）"));
    }
    let board_id = info(2)?;
    let board_revision = info(3)?;
    let flash_size = info(4)? as usize;
    if !(4..=MAX_IMAGE).contains(&flash_size) || flash_size % 4 != 0 {
        return Err("Bootloader 返回了无效 Flash 容量".into());
    }
    Ok(Board {
        protocol,
        board_id,
        board_revision,
        flash_size,
    })
}
pub fn compatible(firmware: &Firmware, board: &Board) -> Result<(), String> {
    if firmware.info.board_id != board.board_id {
        return Err(format!(
            "板型不匹配：固件 Board ID {}，飞控 Board ID {}；未擦除",
            firmware.info.board_id, board.board_id
        ));
    }
    // PX4's board_revision package field is informational; only board_id is authoritative.
    if firmware.image.len() > board.flash_size {
        return Err("固件超过飞控可用 Flash 容量；未擦除".into());
    }
    Ok(())
}
pub fn flash(
    wire: &mut impl Wire,
    firmware: &Firmware,
    board: &Board,
    progress: &mut impl FnMut(&str, usize, usize),
) -> Result<(), String> {
    compatible(firmware, board)?;
    progress("erase", 0, 0);
    wire.exchange(&[0x23], 0, Duration::from_secs(30))?;
    for (index, chunk) in firmware.image.chunks(252).enumerate() {
        let mut command = vec![0x27, chunk.len() as u8];
        command.extend_from_slice(chunk);
        wire.exchange(&command, 0, Duration::from_secs(2))?;
        progress(
            "program",
            (index * 252 + chunk.len()).min(firmware.image.len()),
            firmware.image.len(),
        );
    }
    progress("verify", 0, firmware.image.len());
    if board.protocol >= 3 {
        let value = wire.exchange(&[0x29], 4, Duration::from_secs(10))?;
        let actual = u32::from_le_bytes(value.try_into().map_err(|_| "CRC 响应长度错误")?);
        let expected = firmware.crc(board.flash_size);
        if actual != expected {
            return Err(format!(
                "CRC 校验失败：期望 {expected:08x}，实际 {actual:08x}；未启动固件，请重新升级"
            ));
        }
    } else {
        wire.exchange(&[0x24], 0, Duration::from_secs(2))?;
        for (index, chunk) in firmware.image.chunks(252).enumerate() {
            if wire.exchange(
                &[0x28, chunk.len() as u8],
                chunk.len(),
                Duration::from_secs(2),
            )? != chunk
            {
                return Err("Flash 回读校验失败；未启动固件，请重新升级".into());
            }
            progress("verify", index * 252 + chunk.len(), firmware.image.len());
        }
    }
    progress("verify", firmware.image.len(), firmware.image.len());
    progress("reboot", 0, 0);
    wire.reboot(board.protocol >= 3).map_err(|e| {
        format!("固件已写入并校验通过，但重启未确认：{e}。请重新连接并检查飞控启动状态")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn package(image: &[u8]) -> serde_json::Value {
        let mut compressed =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        compressed.write_all(image).unwrap();
        serde_json::json!({"magic":"PX4FWv1","board_id":7000,"board_revision":0,"image_size":image.len(),"image":base64::engine::general_purpose::STANDARD.encode(compressed.finish().unwrap())})
    }
    fn firmware() -> Firmware {
        let p = package(&(0..17).collect::<Vec<u8>>());
        Firmware::parse(
            "test.px4".into(),
            "test".into(),
            &serde_json::to_vec(&p).unwrap(),
        )
        .unwrap()
    }
    fn board(protocol: u32) -> Board {
        Board {
            protocol,
            board_id: 7000,
            board_revision: 1,
            flash_size: 1024,
        }
    }
    #[test]
    fn package_and_crc_match_independent_python_zlib_vector() {
        let f = firmware();
        assert_eq!(f.image.len(), 20);
        assert_eq!(&f.image[17..], &[255; 3]);
        // Python: zlib.crc32(bytes(range(17))+b'\xff'*1007, 0xffffffff)^0xffffffff
        assert_eq!(f.crc(1024), 0x9a78ec33);
        let real = Firmware::parse(
            "cuav.px4".into(),
            "bundled".into(),
            include_bytes!(
                "../../../firmware/px4-vector-hil/cuav_7-nano_morphquad_vector_hil_20261117.px4"
            ),
        )
        .unwrap();
        assert_eq!(real.info.board_id, 7000);
        assert_eq!(real.image.len(), 1780848);
    }
    #[test]
    fn rejects_invalid_truncated_and_mis_sized_packages() {
        for patch in [
            serde_json::json!({"magic":"other"}),
            serde_json::json!({"board_id":0}),
            serde_json::json!({"image_size":10}),
            serde_json::json!({"image_size":MAX_IMAGE+1}),
            serde_json::json!({"image":"bad!"}),
        ] {
            let mut p = package(&[1; 16]);
            p.as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(
                Firmware::parse("a.px4".into(), "".into(), &serde_json::to_vec(&p).unwrap())
                    .is_err()
            );
        }
        let mut p = package(&[1; 16]);
        let mut data = base64::engine::general_purpose::STANDARD
            .decode(p["image"].as_str().unwrap())
            .unwrap();
        data.pop();
        p["image"] = base64::engine::general_purpose::STANDARD
            .encode(data)
            .into();
        assert!(
            Firmware::parse("a.px4".into(), "".into(), &serde_json::to_vec(&p).unwrap()).is_err()
        );
        assert!(Firmware::parse("a.bin".into(), "".into(), b"raw").is_err());
    }
    struct Model {
        commands: Vec<Vec<u8>>,
        memory: Vec<u8>,
        offset: usize,
        crc: u32,
        fail: Option<u8>,
        protocol: u32,
    }
    impl Model {
        fn new(protocol: u32) -> Self {
            Self {
                commands: Vec::new(),
                memory: vec![255; 1024],
                offset: 0,
                crc: 0x9a78ec33,
                fail: None,
                protocol,
            }
        }
    }
    impl Wire for Model {
        fn exchange(
            &mut self,
            command: &[u8],
            count: usize,
            _: Duration,
        ) -> Result<Vec<u8>, String> {
            self.commands.push(command.to_vec());
            if self.fail == Some(command[0]) {
                return Err("simulated failure".into());
            }
            let response = match command[0] {
                0x21 | 0x23 | 0x30 => vec![],
                0x22 => match command[1] {
                    1 => self.protocol,
                    2 => 7000,
                    3 => 1,
                    4 => 1024,
                    _ => panic!(),
                }
                .to_le_bytes()
                .to_vec(),
                0x27 => {
                    assert_eq!(command.len(), 2 + command[1] as usize);
                    assert_eq!(command[1] % 4, 0);
                    self.memory[self.offset..self.offset + command.len() - 2]
                        .copy_from_slice(&command[2..]);
                    self.offset += command.len() - 2;
                    vec![]
                }
                0x29 => self.crc.to_le_bytes().to_vec(),
                0x24 => {
                    self.offset = 0;
                    vec![]
                }
                0x28 => {
                    let r = self.memory[self.offset..self.offset + command[1] as usize].to_vec();
                    self.offset += r.len();
                    r
                }
                _ => panic!("unexpected command"),
            };
            assert_eq!(response.len(), count);
            Ok(response)
        }
    }
    #[test]
    fn bootloader_identification_program_verification_and_reboot() {
        for version in [2, 3, 5] {
            let mut wire = Model::new(version);
            let b = identify(&mut wire).unwrap();
            assert_eq!(b.protocol, version);
            let mut stages = Vec::new();
            flash(&mut wire, &firmware(), &b, &mut |phase, _, _| {
                stages.push(phase.to_owned())
            })
            .unwrap();
            assert_eq!(&wire.memory[..20], firmware().image.as_slice());
            assert_eq!(wire.commands.iter().filter(|c| c[0] == 0x23).count(), 1);
            assert_eq!(wire.commands.last().unwrap(), &[0x30]);
            assert_eq!(stages.last().unwrap(), "reboot");
        }
        assert!(identify(&mut Model::new(6)).is_err());
    }
    #[test]
    fn board_mismatch_or_capacity_failure_never_erases() {
        let mut wire = Model::new(5);
        let mut b = board(5);
        b.board_id = 9;
        assert!(flash(&mut wire, &firmware(), &b, &mut |_, _, _| {})
            .unwrap_err()
            .contains("板型不匹配"));
        b.board_id = 7000;
        b.flash_size = 16;
        assert!(flash(&mut wire, &firmware(), &b, &mut |_, _, _| {}).is_err());
        assert!(wire.commands.is_empty());
    }
    #[test]
    fn bad_crc_or_transport_failure_never_reboots_or_retries() {
        let mut wire = Model::new(5);
        wire.crc = 123;
        assert!(flash(&mut wire, &firmware(), &board(5), &mut |_, _, _| {})
            .unwrap_err()
            .contains("CRC"));
        assert!(!wire.commands.iter().any(|c| c[0] == 0x30));
        for command in [0x23, 0x27, 0x29] {
            let mut wire = Model::new(5);
            wire.fail = Some(command);
            assert!(flash(&mut wire, &firmware(), &board(5), &mut |_, _, _| {}).is_err());
            assert_eq!(wire.commands.iter().filter(|c| c[0] == command).count(), 1);
            assert!(!wire.commands.iter().any(|c| c[0] == 0x30));
        }
    }
    #[test]
    fn programs_in_aligned_252_byte_chunks() {
        let p = package(&[0x5a; 509]);
        let f =
            Firmware::parse("a.px4".into(), "".into(), &serde_json::to_vec(&p).unwrap()).unwrap();
        let mut wire = Model::new(2);
        flash(&mut wire, &f, &board(2), &mut |_, _, _| {}).unwrap();
        assert_eq!(
            wire.commands
                .iter()
                .filter(|c| c[0] == 0x27)
                .map(|c| c[1])
                .collect::<Vec<_>>(),
            vec![252, 252, 8]
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn real_serial_wire_handles_fragmented_ack_and_rejects_failure() {
        use std::os::fd::FromRawFd;
        let mut master = 0;
        let mut slave = 0;
        let mut name = [0i8; 128];
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    name.as_mut_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            0
        );
        let path = unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) }
            .to_str()
            .unwrap();
        let port = serialport::new(path, 115200)
            .timeout(Duration::from_millis(100))
            .open()
            .unwrap();
        unsafe {
            libc::close(slave);
        }
        let peer = std::thread::spawn(move || {
            let mut device = unsafe { std::fs::File::from_raw_fd(master) };
            let mut command = [0; 2];
            device.read_exact(&mut command).unwrap();
            assert_eq!(command, [0x21, 0x20]);
            device.write_all(&[0x12]).unwrap();
            std::thread::sleep(Duration::from_millis(15));
            device.write_all(&[0x10]).unwrap();
            device.read_exact(&mut command).unwrap();
            assert_eq!(command, [0x23, 0x20]);
            device.write_all(&[0x12, 0x11]).unwrap();
            std::thread::sleep(Duration::from_millis(30));
        });
        let mut wire = SerialWire(port);
        wire.exchange(&[0x21], 0, Duration::from_secs(1)).unwrap();
        assert!(wire
            .exchange(&[0x23], 0, Duration::from_secs(1))
            .unwrap_err()
            .contains("操作失败"));
        peer.join().unwrap();
    }
}
