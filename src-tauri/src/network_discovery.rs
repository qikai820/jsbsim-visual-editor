//! Passive simulator discovery from the host's existing Ethernet neighbor table.
//! No network-wide scan or private FTP credentials are used here.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

fn candidates(arp: &str) -> Vec<Ipv4Addr> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for line in arp.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 6 || fields[2] != "0x2" ||
            !(fields[5].starts_with("en") || fields[5].starts_with("eth")) {
            continue;
        }
        let Ok(address) = fields[0].parse::<Ipv4Addr>() else { continue; };
        if address.is_private() && seen.insert(address) { found.push(address); }
    }
    found
}

fn simulator_ftp(address: Ipv4Addr) -> bool {
    let target = SocketAddr::from((address, 21));
    let Ok(mut stream) = TcpStream::connect_timeout(&target, Duration::from_millis(300)) else {
        return false;
    };
    if stream.set_read_timeout(Some(Duration::from_millis(400))).is_err() { return false; }
    if stream.set_write_timeout(Some(Duration::from_millis(400))).is_err() { return false; }
    let Ok(read_stream) = stream.try_clone() else { return false; };
    let mut reader = BufReader::new(read_stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || !line.starts_with("220 NuttX FTP Server") {
        return false;
    }
    if stream.write_all(b"USER anonymous\r\n").is_err() { return false; }
    line.clear();
    if reader.read_line(&mut line).is_err() { return false; }
    if line.starts_with("331 ") {
        if stream.write_all(b"PASS anonymous@\r\n").is_err() { return false; }
        line.clear();
        if reader.read_line(&mut line).is_err() { return false; }
    }
    if !line.starts_with("230 ") || stream.write_all(b"CWD /jsbsim\r\n").is_err() {
        return false;
    }
    line.clear();
    reader.read_line(&mut line).is_ok_and(|length| length > 0 && line.starts_with("250 "))
}

pub fn verify(address: Ipv4Addr) -> bool {
    simulator_ftp(address)
}

/// Inspect only neighbors already learned by the operating system. A board
/// absent from ARP may still be found by UDP discovery or incoming telemetry.
pub fn discover(preferred: Option<Ipv4Addr>) -> Option<Ipv4Addr> {
    if let Some(address) = preferred.filter(|address| simulator_ftp(*address)) {
        return Some(address);
    }
    let arp = std::fs::read_to_string("/proc/net/arp").ok()?;
    candidates(&arp).into_iter().find(|address| simulator_ftp(*address))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_resolved_wired_neighbors() {
        let table = "IP address HW type Flags HW address Mask Device\n\
192.168.3.82 0x1 0x2 02:73:5e:69:91:8a * enp0s31f6\n\
192.168.3.83 0x1 0x0 00:00:00:00:00:00 * enp0s31f6\n\
192.168.43.137 0x1 0x2 7c:b3:7b:25:47:77 * wlp0s20f3\n";
        assert_eq!(candidates(table), vec![Ipv4Addr::new(192, 168, 3, 82)]);
    }
}
