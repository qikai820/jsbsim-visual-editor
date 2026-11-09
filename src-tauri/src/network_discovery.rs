//! Simulator discovery on local Ethernet subnets and existing wired neighbors.
//! No address-range scan or private FTP credentials are used here.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::time::Duration;

fn ethernet_broadcast(name: &str, up: bool, broadcast: bool,
                      address: Ipv4Addr, netmask: Ipv4Addr) -> Option<Ipv4Addr> {
    if !up || !broadcast || !(name.starts_with("en") || name.starts_with("eth")) ||
        !address.is_private() {
        return None;
    }
    let mask = u32::from(netmask);
    let prefix = mask.leading_ones();
    // Exclude invalid masks and point-to-point networks with no broadcast.
    if !(8..=30).contains(&prefix) || mask != u32::MAX << (32 - prefix) {
        return None;
    }
    let target = Ipv4Addr::from(u32::from(address) | !mask);
    target.is_private().then_some(target)
}

fn startup_hosts(address: Ipv4Addr, netmask: Ipv4Addr) -> Vec<Ipv4Addr> {
    // The i.MX93 and Orange Pi BSPs have fixed startup addresses. Some firmware
    // profiles do not enable UDP broadcast reception or a discovery responder.
    // Probe only these defaults on an attached subnet, never a whole IP range.
    [Ipv4Addr::new(192, 168, 3, 82), Ipv4Addr::new(192, 168, 101, 82)]
        .into_iter().filter(|host|
            u32::from(*host) & u32::from(netmask) == u32::from(address) & u32::from(netmask))
        .collect()
}

fn local_targets() -> (Vec<Ipv4Addr>, Vec<Ipv4Addr>) {
    let mut addresses = vec![Ipv4Addr::BROADCAST];
    let mut defaults = Vec::new();
    #[cfg(unix)]
    unsafe {
        let mut list = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) == 0 {
            let mut current = list;
            while let Some(interface) = current.as_ref() {
                // getifaddrs owns these pointers until freeifaddrs below. Check
                // both address families before interpreting sockaddr_in.
                if !interface.ifa_name.is_null() && !interface.ifa_addr.is_null() &&
                    !interface.ifa_netmask.is_null() &&
                    (*interface.ifa_addr).sa_family as i32 == libc::AF_INET &&
                    (*interface.ifa_netmask).sa_family as i32 == libc::AF_INET {
                    let name = std::ffi::CStr::from_ptr(interface.ifa_name).to_string_lossy();
                    let address = &*interface.ifa_addr.cast::<libc::sockaddr_in>();
                    let netmask = &*interface.ifa_netmask.cast::<libc::sockaddr_in>();
                    if let Some(target) = ethernet_broadcast(&name,
                        interface.ifa_flags & libc::IFF_UP as u32 != 0,
                        interface.ifa_flags & libc::IFF_BROADCAST as u32 != 0,
                        Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes()),
                        Ipv4Addr::from(netmask.sin_addr.s_addr.to_ne_bytes())) {
                        if !addresses.contains(&target) { addresses.push(target); }
                        for host in startup_hosts(
                            Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes()),
                            Ipv4Addr::from(netmask.sin_addr.s_addr.to_ne_bytes())) {
                            if !defaults.contains(&host) { defaults.push(host); }
                        }
                    }
                }
                current = interface.ifa_next;
            }
            libc::freeifaddrs(list);
        }
    }
    (addresses, defaults)
}

/// Limited broadcast follows the default route, which may be Wi-Fi. Also send
/// directly to every active Ethernet subnet, including secondary IPv4 addresses.
pub fn broadcast_addresses() -> Vec<Ipv4Addr> {
    local_targets().0
}

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
    if reader.read_line(&mut line).is_err() { return false; }
    let sd_library = line.starts_with("250 ");
    let missing_sd_library = line.starts_with("550 ");
    let _ = stream.write_all(b"QUIT\r\n");
    drop(reader);
    drop(stream);
    // A ROMFS-only board is still a simulator. Do not require a user model
    // directory on the SD card, or register an arbitrary NuttX FTP server.
    sd_library || (missing_sd_library && crate::romfs_network::verify_library(address))
}

pub fn verify(address: Ipv4Addr) -> bool {
    simulator_ftp(address)
}

/// Probe local Ethernet broadcasts, attached BSP defaults and known wired
/// neighbors. UDP telemetry establishes the connection independently of FTP,
/// an ARP entry or broadcast reception support in the board's firmware.
pub fn heartbeat_candidates(preferred: Option<Ipv4Addr>) -> Vec<Ipv4Addr> {
    let mut hosts = preferred.filter(Ipv4Addr::is_private).into_iter().collect::<Vec<_>>();
    if let Ok(arp) = std::fs::read_to_string("/proc/net/arp") {
        for address in candidates(&arp) {
            if !hosts.contains(&address) { hosts.push(address); }
        }
    }
    let (broadcasts, defaults) = local_targets();
    for address in defaults.into_iter().chain(broadcasts) {
        if !hosts.contains(&address) { hosts.push(address); }
    }
    hosts
}

/// Use the telemetry socket so firmware replying to the heartbeat's source port
/// reaches the receiver, rather than the separate discovery listener.
pub fn send_heartbeat_probes(socket: &UdpSocket, control_port: u16, hosts: &[Ipv4Addr]) {
    let _ = socket.set_broadcast(true);
    for host in hosts {
        let _ = socket.send_to(b"VCMD\x07", SocketAddr::from((*host, control_port)));
    }
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

    #[test]
    fn broadcasts_cover_secondary_ethernet_subnets_without_neighbors() {
        // The default route can remain on Wi-Fi. Neither Ethernet subnet
        // needs a known board address or an ARP entry to receive a heartbeat.
        let mask = Ipv4Addr::new(255, 255, 255, 0);
        assert_eq!(ethernet_broadcast("enp0s31f6", true, true,
            Ipv4Addr::new(192, 168, 3, 109), mask), Some(Ipv4Addr::new(192, 168, 3, 255)));
        assert_eq!(ethernet_broadcast("enp0s31f6", true, true,
            Ipv4Addr::new(192, 168, 101, 100), mask), Some(Ipv4Addr::new(192, 168, 101, 255)));
        assert_eq!(ethernet_broadcast("eth0", true, true,
            Ipv4Addr::new(172, 20, 4, 1), Ipv4Addr::new(255, 255, 240, 0)),
            Some(Ipv4Addr::new(172, 20, 15, 255)));
    }

    #[test]
    fn skips_down_virtual_and_non_broadcast_interfaces() {
        let address = Ipv4Addr::new(192, 168, 101, 100);
        let mask = Ipv4Addr::new(255, 255, 255, 0);
        for name in ["wlp0s20f3", "docker0", "tailscale0", "lo"] {
            assert_eq!(ethernet_broadcast(name, true, true, address, mask), None);
        }
        assert_eq!(ethernet_broadcast("eth0", false, true, address, mask), None);
        assert_eq!(ethernet_broadcast("eth0", true, false, address, mask), None);
        assert_eq!(ethernet_broadcast("eth0", true, true, Ipv4Addr::LOCALHOST, mask), None);
        for mask in [Ipv4Addr::UNSPECIFIED, Ipv4Addr::BROADCAST,
            Ipv4Addr::new(255, 255, 255, 254), Ipv4Addr::new(255, 0, 255, 0)] {
            assert_eq!(ethernet_broadcast("eth0", true, true, address, mask), None);
        }
    }

    #[test]
    fn startup_fallback_does_not_require_arp_or_broadcast_support() {
        let mask = Ipv4Addr::new(255, 255, 255, 0);
        assert_eq!(startup_hosts(Ipv4Addr::new(192, 168, 101, 100), mask),
            vec![Ipv4Addr::new(192, 168, 101, 82)]);
        assert_eq!(startup_hosts(Ipv4Addr::new(192, 168, 3, 109), mask),
            vec![Ipv4Addr::new(192, 168, 3, 82)]);
        assert!(startup_hosts(Ipv4Addr::new(192, 168, 144, 200), mask).is_empty());
    }

    #[test]
    fn heartbeat_reply_returns_to_the_telemetry_socket() {
        let telemetry = UdpSocket::bind("127.0.0.1:0").unwrap();
        let board = UdpSocket::bind("127.0.0.1:0").unwrap();
        for socket in [&telemetry, &board] {
            socket.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        }
        send_heartbeat_probes(&telemetry, board.local_addr().unwrap().port(), &[Ipv4Addr::LOCALHOST]);
        let mut buffer = [0u8; 64];
        let (size, peer) = board.recv_from(&mut buffer).unwrap();
        assert_eq!(&buffer[..size], b"VCMD\x07");
        assert_eq!(peer, telemetry.local_addr().unwrap());
        board.send_to(b"{\"kind\":\"heartbeat\"}", peer).unwrap();
        let (size, _) = telemetry.recv_from(&mut buffer).unwrap();
        assert_eq!(&buffer[..size], b"{\"kind\":\"heartbeat\"}");
    }
}
