//! One authenticated simulator USB lease; never opens a desktop serial port.
use super::{
    protocol::{self, Wire},
    UsbTarget,
};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

pub fn parse_ports(simulator: Ipv4Addr, text: &str) -> Result<Vec<UsbTarget>, String> {
    let line = text
        .lines()
        .find_map(|l| l.strip_prefix("PX4_FIRMWARE "))
        .ok_or("仿真机尚不支持飞控 USB 升级，请先更新带 PX4 固件升级服务的仿真机固件")?;
    let f: HashMap<_, _> = line
        .split_whitespace()
        .filter_map(|p| p.split_once('='))
        .collect();
    if f.get("protocol") != Some(&"1") || f.get("port") != Some(&"14624") {
        return Err("仿真机升级协议版本不兼容".into());
    }
    if f.get("busy") == Some(&"1") || f.get("connected") == Some(&"0") {
        return Ok(Vec::new());
    }
    if f.get("busy") != Some(&"0") || f.get("connected") != Some(&"1") {
        return Err("无效仿真机升级状态".into());
    }
    let path = f.get("device").ok_or("缺少仿真机 USB 路径")?.to_string();
    if !valid_path(&path) {
        return Err("仿真机返回了无效 USB 路径".into());
    }
    let number = |key| {
        f.get(key)
            .ok_or("缺少 USB 身份")?
            .parse::<u16>()
            .map_err(|_| "无效 USB 身份")
    };
    let vid = number("vid")?;
    let pid = number("pid")?;
    if vid == 0 {
        return Err("仿真机未提供可校验的 USB 身份".into());
    }
    Ok(vec![UsbTarget {
        simulator: simulator.to_string(),
        path: path.clone(),
        vid,
        pid,
        serial_number: None,
        label: format!("{simulator} · {path} · {vid:04x}:{pid:04x}"),
    }])
}
fn valid_path(path: &str) -> bool {
    path.strip_prefix("/dev/ttyACM").is_some_and(|n| {
        !n.is_empty()
            && n.len() <= 2
            && n.bytes().all(|b| b.is_ascii_digit())
            && n.parse::<u8>().is_ok_and(|v| v < 32)
    })
}
pub fn ports() -> Result<Vec<UsbTarget>, String> {
    let host = crate::transport::network_host().ok_or("未发现仿真机，请检查网络连接")?;
    crate::romfs_network::with_host_session(host, |s| {
        parse_ports(host, &s.command("jsbsim firmware status")?)
    })
}
pub struct RemoteWire {
    stream: TcpStream,
    pub healthy: bool,
}
impl RemoteWire {
    pub fn connect(target: &UsbTarget) -> Result<Self, String> {
        if !valid_path(&target.path) {
            return Err("非法仿真机 USB 路径".into());
        }
        let host: Ipv4Addr = target.simulator.parse().map_err(|_| "非法仿真机地址")?;
        if crate::transport::network_host() != Some(host) {
            return Err("仿真机已变化，请重新选择目标".into());
        }
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let command = format!(
            "jsbsim firmware serve {token} {} {} {}",
            target.path, target.vid, target.pid
        );
        let result = crate::romfs_network::with_host_session(host, |s| s.command(&command))?;
        if !result
            .lines()
            .any(|l| l.trim() == "PX4_FIRMWARE_READY protocol=1")
        {
            return Err(format!("仿真机未启动升级会话（未自动重试）：{result}"));
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut stream = loop {
            match TcpStream::connect_timeout(
                &SocketAddr::from((host, 14624)),
                Duration::from_millis(300),
            ) {
                Ok(s) => break s,
                Err(e) => {
                    if Instant::now() >= deadline {
                        return Err(format!("无法连接仿真机升级服务：{e}"));
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        };
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(6)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        stream
            .write_all(token.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut wire = Self {
            stream,
            healthy: true,
        };
        wire.reply()?;
        Ok(wire)
    }
    fn reply(&mut self) -> Result<Vec<u8>, String> {
        let result: Result<(u8, Vec<u8>), String> = (|| {
            let mut h = [0; 3];
            self.stream.read_exact(&mut h).map_err(|e| e.to_string())?;
            let n = u16::from_le_bytes([h[1], h[2]]) as usize;
            if n > 254 {
                return Err("仿真机响应超长".into());
            }
            let mut data = vec![0; n];
            self.stream
                .read_exact(&mut data)
                .map_err(|e| e.to_string())?;
            Ok((h[0], data))
        })();
        match result {
            Ok((0, data)) => Ok(data),
            Ok((_, data)) => Err(format!("仿真机 USB：{}", String::from_utf8_lossy(&data))),
            Err(e) => {
                self.healthy = false;
                Err(format!("升级连接中断，未自动重试：{e}"))
            }
        }
    }
    pub fn reset(&mut self) -> Result<(), String> {
        self.stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .map_err(|e| e.to_string())?;
        if let Err(e) = self.stream.write_all(&[0; 9]) {
            self.healthy = false;
            return Err(e.to_string());
        }
        self.reply().map(|_| ())
    }
    fn raw(&mut self, command: &[u8], count: usize, timeout: Duration) -> Result<Vec<u8>, String> {
        let mut packet = vec![1];
        packet.extend_from_slice(&(timeout.as_millis() as u32).to_le_bytes());
        packet.extend_from_slice(&((command.len() + 1) as u16).to_le_bytes());
        packet.extend_from_slice(&(count as u16).to_le_bytes());
        packet.extend_from_slice(command);
        packet.push(0x20);
        self.stream
            .set_read_timeout(Some(timeout + Duration::from_secs(3)))
            .map_err(|e| e.to_string())?;
        if let Err(e) = self.stream.write_all(&packet) {
            self.healthy = false;
            return Err(e.to_string());
        }
        let data = self.reply()?;
        if data.len() != count {
            self.healthy = false;
            return Err("仿真机 USB 响应长度不符".into());
        }
        Ok(data)
    }
}
impl Wire for RemoteWire {
    fn exchange(
        &mut self,
        command: &[u8],
        count: usize,
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        protocol::ack_response(self.raw(command, count + 2, timeout)?, count)
    }
    fn reboot(&mut self, ack: bool) -> Result<(), String> {
        if ack {
            self.exchange(&[0x30], 0, Duration::from_secs(3))
                .map(|_| ())
        } else {
            self.raw(&[0x30], 0, Duration::from_secs(3)).map(|_| ())
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn simulator_capability_and_identity_are_required() {
        let host = "192.0.2.1".parse().unwrap();
        let line="PX4_FIRMWARE protocol=1 port=14624 busy=0 connected=1 device=/dev/ttyACM0 vid=7052 pid=54";
        let p = parse_ports(host, line).unwrap();
        assert_eq!(p[0].simulator, "192.0.2.1");
        assert_eq!(p[0].vid, 7052);
        for s in [
            "nsh: command not found".into(),
            line.replace("protocol=1", "protocol=2"),
            line.replace("/dev/ttyACM0", "/dev/ttyACM0;reboot"),
            line.replace("vid=7052", "vid=0"),
        ] {
            assert!(parse_ports(host, &s).is_err());
        }
        assert!(
            parse_ports(host, &line.replace("connected=1", "connected=0"))
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn tcp_wire_frames_commands_and_does_not_reconnect_on_loss() {
        use std::net::TcpListener;
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = server.local_addr().unwrap();
        let peer = std::thread::spawn(move || {
            let (mut s, _) = server.accept().unwrap();
            let mut h = [0; 9];
            s.read_exact(&mut h).unwrap();
            assert_eq!(h, [0; 9]);
            s.write_all(&[0, 0, 0]).unwrap();
            s.read_exact(&mut h).unwrap();
            assert_eq!(h[0], 1);
            assert_eq!(u16::from_le_bytes([h[5], h[6]]), 2);
            assert_eq!(u16::from_le_bytes([h[7], h[8]]), 2);
            let mut packet = [0; 2];
            s.read_exact(&mut packet).unwrap();
            assert_eq!(packet, [0x21, 0x20]);
            s.write_all(&[0, 2, 0, 0x12]).unwrap();
            s.write_all(&[0x10]).unwrap();
            s.read_exact(&mut h).unwrap();
            s.read_exact(&mut packet).unwrap();
            assert_eq!(packet, [0x23, 0x20]); // Lose the connection after exactly one erase command.
        });
        let stream = TcpStream::connect(addr).unwrap();
        let mut wire = RemoteWire {
            stream,
            healthy: true,
        };
        wire.reset().unwrap();
        wire.exchange(&[0x21], 0, Duration::from_secs(1)).unwrap();
        assert!(wire.exchange(&[0x23], 0, Duration::from_secs(1)).is_err());
        assert!(!wire.healthy);
        peer.join().unwrap();
    }
}
