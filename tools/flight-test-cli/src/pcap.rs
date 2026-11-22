//! Read-only copy of the existing visual UDP stream. Never bind its occupied port.
use std::io::{self, Read, Write};
use std::net::Ipv4Addr;

pub fn visual_payload(packet: &[u8], link: u32, host: Ipv4Addr) -> Option<&[u8]> {
    let mut offset = match link {
        1 => {
            let mut offset = 14;
            let mut protocol = u16::from_be_bytes(packet.get(12..14)?.try_into().ok()?);
            for _ in 0..2 {
                if protocol != 0x8100 && protocol != 0x88a8 {
                    break;
                }
                protocol = u16::from_be_bytes(packet.get(offset + 2..offset + 4)?.try_into().ok()?);
                offset += 4;
            }
            if protocol != 0x0800 {
                return None;
            }
            offset
        }
        113 => {
            if packet.get(14..16)? != [0x08, 0x00] {
                return None;
            }
            16
        }
        276 => {
            if packet.get(0..2)? != [0x08, 0x00] {
                return None;
            }
            20
        }
        101 => 0,
        _ => return None,
    };
    let ip = packet.get(offset..)?;
    if ip.len() < 20 || ip[0] >> 4 != 4 || ip[9] != 17 || ip[12..16] != host.octets() {
        return None;
    }
    let ihl = usize::from(ip[0] & 15) * 4;
    let total = usize::from(u16::from_be_bytes([ip[2], ip[3]]));
    // Incomplete or fragmented frames cannot freshen model/clock feedback.
    if ihl < 20
        || total < ihl + 8
        || total > ip.len()
        || u16::from_be_bytes([ip[6], ip[7]]) & 0x3fff != 0
    {
        return None;
    }
    offset += ihl;
    let udp = packet.get(offset..offset + total - ihl)?;
    let size = usize::from(u16::from_be_bytes([udp[4], udp[5]]));
    if udp[2..4] != 5801u16.to_be_bytes() || size < 8 || size > udp.len() {
        return None;
    }
    udp.get(8..size)
}

pub fn copy_stream(
    mut input: impl Read,
    mut capture: impl Write,
    host: Ipv4Addr,
    mut observe: impl FnMut(serde_json::Value),
) -> Result<(), String> {
    let mut header = [0; 24];
    input
        .read_exact(&mut header)
        .map_err(|e| format!("读取 pcap 文件头失败：{e}"))?;
    let little = match header[..4] {
        [0xd4, 0xc3, 0xb2, 0xa1] | [0x4d, 0x3c, 0xb2, 0xa1] => true,
        [0xa1, 0xb2, 0xc3, 0xd4] | [0xa1, 0xb2, 0x3c, 0x4d] => false,
        _ => return Err("只支持 dumpcap -P 输出的标准 pcap".into()),
    };
    let integer = |v: &[u8]| {
        let b: [u8; 4] = v.try_into().unwrap();
        if little {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        }
    };
    let link = integer(&header[20..24]);
    if ![1, 101, 113, 276].contains(&link) {
        return Err(format!("不支持的 pcap 链路类型 {link}"));
    }
    capture.write_all(&header).map_err(|e| e.to_string())?;
    loop {
        let mut record = [0; 16];
        match input.read_exact(&mut record) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                return Err("遥测抓取进程已停止".into())
            }
            Err(e) => return Err(e.to_string()),
        }
        let size = integer(&record[8..12]) as usize;
        if size > 262_144 {
            return Err("pcap 包长度越界".into());
        }
        let mut packet = vec![0; size];
        input.read_exact(&mut packet).map_err(|e| e.to_string())?;
        capture
            .write_all(&record)
            .and_then(|_| capture.write_all(&packet))
            .map_err(|e| e.to_string())?;
        if let Some(payload) = visual_payload(&packet, link, host) {
            if let Ok(value) = serde_json::from_slice(payload) {
                observe(value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_complete_visual_packets_from_configured_simulator_are_accepted() {
        let host = Ipv4Addr::new(192, 168, 101, 82);
        let payload = br#"{"instance_id":"01","model":"MorphQuad","timestamp":12.5}"#;
        let mut frame = vec![0u8; 14 + 20 + 8];
        frame[12..14].copy_from_slice(&0x0800u16.to_be_bytes());
        frame[14] = 0x45;
        frame[23] = 17;
        frame[26..30].copy_from_slice(&host.octets());
        frame[16..18].copy_from_slice(&((28 + payload.len()) as u16).to_be_bytes());
        frame[36..38].copy_from_slice(&5801u16.to_be_bytes());
        frame[38..40].copy_from_slice(&((8 + payload.len()) as u16).to_be_bytes());
        frame.extend_from_slice(payload);
        assert_eq!(visual_payload(&frame, 1, host), Some(payload.as_slice()));
        assert!(visual_payload(&frame, 1, Ipv4Addr::LOCALHOST).is_none());
        frame[36..38].copy_from_slice(&14553u16.to_be_bytes());
        assert!(visual_payload(&frame, 1, host).is_none());
        frame[36..38].copy_from_slice(&5801u16.to_be_bytes());
        frame[20] = 0x20;
        assert!(visual_payload(&frame, 1, host).is_none());
        assert!(visual_payload(&frame[..30], 1, host).is_none());
    }
}
