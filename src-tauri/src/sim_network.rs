use serde::Serialize;
use std::net::Ipv4Addr;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Interface {
    pub name: String,
    pub address: String,
    pub netmask: String,
    pub gateway: String,
}

#[derive(Debug, Serialize)]
pub struct AppliedInterface {
    #[serde(flatten)]
    pub interface: Interface,
    pub transport: &'static str,
    #[serde(skip)]
    pub control_host: Option<Ipv4Addr>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Channel { Usb, Network(Ipv4Addr) }

trait Commands {
    fn usb(&mut self, command: &str) -> Result<String, String>;
    fn network(&mut self, host: Ipv4Addr, command: &str) -> Result<String, String>;
    fn network_host(&mut self) -> Option<Ipv4Addr>;
    fn known_host(&self) -> Option<Ipv4Addr>;
    fn retry_delay(&self) { std::thread::sleep(std::time::Duration::from_millis(200)); }
}

struct RuntimeCommands;

impl Commands for RuntimeCommands {
    fn usb(&mut self, command: &str) -> Result<String, String> {
        crate::usb_file::nsh_execute(command)
    }
    fn network(&mut self, host: Ipv4Addr, command: &str) -> Result<String, String> {
        crate::nsh_execute_tcp_at(host, command)
    }
    fn network_host(&mut self) -> Option<Ipv4Addr> { crate::transport::network_host() }
    fn known_host(&self) -> Option<Ipv4Addr> { crate::transport::network_host_override() }
}

fn execute(commands: &mut impl Commands, channel: Channel, command: &str) -> Result<String, String> {
    match channel {
        Channel::Usb => commands.usb(command),
        Channel::Network(host) => commands.network(host, command),
    }
}

fn probe(commands: &mut impl Commands, mode: crate::transport::TransportMode, command: &str) -> Result<(Channel, String), String> {
    use crate::transport::TransportMode;
    let mut usb_error = None;
    if mode != TransportMode::Network {
        match commands.usb(command) {
            Ok(output) => return Ok((Channel::Usb, output)),
            Err(error) if mode == TransportMode::Usb => return Err(error),
            Err(error) => usb_error = Some(error),
        }
    }
    let network = commands.network_host().ok_or_else(|| "No network simulator discovered".to_owned())
        .and_then(|host| commands.network(host, command).map(|output| (Channel::Network(host), output)));
    network.map_err(|error| match usb_error {
        Some(usb) => format!("USB unavailable ({usb}); network unavailable ({error})"),
        None => error,
    })
}

fn field<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.split_whitespace().find_map(|part| part.strip_prefix(prefix))
}

fn terminal_text(output: &str) -> String {
    let mut text = String::with_capacity(output.len());
    let mut chars = output.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            // NSH readline emits ANSI CSI sequences such as ESC[K. The
            // first byte in this range terminates the control sequence.
            for control in chars.by_ref() {
                if ('@'..='~').contains(&control) { break; }
            }
        } else {
            text.push(ch);
        }
    }
    text
}

pub fn parse_ifconfig(output: &str) -> Vec<Interface> {
    let mut interfaces = Vec::new();
    let mut name = String::new();
    let output = terminal_text(output);
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some((candidate, _)) = trimmed.split_once("Link encap:") {
            // A Telnet response may start with "nsh> eth0" on one line.
            name = candidate.split_whitespace().last().unwrap_or_default().to_owned();
        }
        if !name.starts_with("eth") { continue; }
        if let (Some(address), Some(gateway), Some(netmask)) =
            (field(trimmed, "addr:"), field(trimmed, "DRaddr:"), field(trimmed, "Mask:"))
        {
            interfaces.push(Interface {
                name: name.clone(), address: address.to_owned(),
                netmask: netmask.to_owned(), gateway: gateway.to_owned(),
            });
            name.clear();
        }
    }
    interfaces
}

pub fn read() -> Result<Vec<Interface>, String> {
    let (_, output) = probe(&mut RuntimeCommands, crate::transport::mode(), "ifconfig")?;
    let interfaces = parse_ifconfig(&output);
    if interfaces.is_empty() {
        return Err(format!("No Ethernet IPv4 configuration in simulator reply: {output}"));
    }
    Ok(interfaces)
}

fn valid_mask(mask: Ipv4Addr) -> bool {
    let value = u32::from(mask);
    value != 0 && value != u32::MAX && (value | value.wrapping_sub(1)) == u32::MAX
}

fn requested_interface(name: &str, address: &str, netmask: &str, gateway: &str) -> Result<Interface, String> {
    if name != "eth0" && name != "eth1" {
        return Err("Only eth0 and eth1 can be configured".into());
    }
    let ip: Ipv4Addr = address.parse().map_err(|_| "Invalid IPv4 address")?;
    let mask: Ipv4Addr = netmask.parse().map_err(|_| "Invalid IPv4 netmask")?;
    let router: Ipv4Addr = gateway.parse().map_err(|_| "Invalid IPv4 gateway")?;
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() || ip.is_broadcast() || !valid_mask(mask) {
        return Err("Invalid unicast IPv4 address or contiguous netmask".into());
    }
    let network = u32::from(ip) & u32::from(mask);
    let broadcast = network | !u32::from(mask);
    if u32::from(ip) == network || u32::from(ip) == broadcast ||
        (!router.is_unspecified() && (u32::from(router) & u32::from(mask) != network || router == ip || u32::from(router) == broadcast))
    {
        return Err("IP or gateway is outside the usable subnet".into());
    }
    Ok(Interface { name: name.into(), address: ip.to_string(), netmask: mask.to_string(), gateway: router.to_string() })
}

fn hardware_address(output: &str, name: &str) -> Option<String> {
    let output = terminal_text(output);
    for line in output.lines() {
        if let Some((prefix, fields)) = line.split_once("Link encap:") {
            if prefix.split_whitespace().last() == Some(name) {
                let mut fields = fields.split_whitespace();
                while let Some(field) = fields.next() {
                    if field == "HWaddr" { return fields.next().map(str::to_ascii_lowercase); }
                }
            }
        }
    }
    None
}

pub fn set(name: &str, address: &str, netmask: &str, gateway: &str) -> Result<AppliedInterface, String> {
    let requested = requested_interface(name, address, netmask, gateway)?;
    apply(&mut RuntimeCommands, crate::transport::mode(), requested)
}

fn apply(commands: &mut impl Commands, mode: crate::transport::TransportMode, requested: Interface) -> Result<AppliedInterface, String> {
    let name = &requested.name;
    // Fallback is limited to this read-only probe. Once a write has been
    // attempted, never repeat it through a different transport.
    let (channel, before) = probe(commands, mode, &format!("ifconfig {name}"))?;
    let previous = parse_ifconfig(&before).into_iter().find(|item| item.name == *name)
        .ok_or_else(|| format!("{name} was not reported by the simulator"))?;
    let previous_host = match channel { Channel::Network(host) => Some(host), Channel::Usb => commands.known_host() };
    let control_host = previous_host.filter(|host| host.to_string() == previous.address && requested.address != previous.address)
        .map(|_| requested.address.parse::<Ipv4Addr>().unwrap());
    let readback_channel = match (channel, control_host) {
        (Channel::Network(_), Some(host)) => Channel::Network(host),
        _ => channel,
    };
    let mac = hardware_address(&before, name);
    if readback_channel != channel && mac.is_none() {
        return Err("Cannot verify simulator identity after an IP change; use USB for this firmware".into());
    }
    let command = format!("ifconfig {name} {} netmask {} gateway {}", requested.address, requested.netmask, requested.gateway);
    let write_error = match execute(commands, channel, &command) {
        Ok(response) if response.contains("nsh: ") || response.contains("Failed") =>
            return Err(format!("Simulator rejected network configuration: {response}")),
        Ok(_) => None,
        Err(error) if channel == Channel::Usb => return Err(error),
        // Changing the active port's IP may close its old TCP connection.
        // Only a verified readback from the same MAC can acknowledge it.
        Err(error) => Some(error),
    };
    if before.contains(" at DOWN ") {
        let response = execute(commands, channel, &format!("ifup {name}"))?;
        if !response.contains(&format!("ifup {name}...OK")) {
            return Err(format!("Simulator could not bring up {name}: {response}"));
        }
    }
    let mut last_error = String::new();
    let attempts = if channel == Channel::Usb { 1 } else { 5 };
    for attempt in 0..attempts {
        if attempt > 0 { commands.retry_delay(); }
        match execute(commands, readback_channel, &format!("ifconfig {name}")) {
            Ok(output) => {
                if mac.is_some() && hardware_address(&output, name) != mac {
                    return Err("Readback came from a different Ethernet device; configuration was not verified".into());
                }
                if let Some(actual) = parse_ifconfig(&output).into_iter().find(|item| item.name == *name) {
                    if actual == requested {
                        return Ok(AppliedInterface { interface: actual,
                            transport: if channel == Channel::Usb { "usb" } else { "network" }, control_host });
                    }
                    last_error = format!("Readback differs from requested configuration: {} / {} / {}", actual.address, actual.netmask, actual.gateway);
                } else { last_error = format!("No {name} IPv4 configuration in readback"); }
            }
            Err(error) => last_error = error,
        }
    }
    Err(format!("Network configuration not verified; edits retained. {last_error}{}",
        write_error.map(|error| format!("; write connection: {error}")).unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::TransportMode;
    use std::collections::VecDeque;

    struct FakeCommands {
        host: Ipv4Addr,
        steps: VecDeque<(Channel, String, Result<String, String>)>,
    }

    impl Commands for FakeCommands {
        fn usb(&mut self, command: &str) -> Result<String, String> { self.call(Channel::Usb, command) }
        fn network(&mut self, host: Ipv4Addr, command: &str) -> Result<String, String> { self.call(Channel::Network(host), command) }
        fn network_host(&mut self) -> Option<Ipv4Addr> { Some(self.host) }
        fn known_host(&self) -> Option<Ipv4Addr> { Some(self.host) }
        fn retry_delay(&self) {}
    }

    impl FakeCommands {
        fn call(&mut self, channel: Channel, command: &str) -> Result<String, String> {
            let (expected_channel, expected_command, result) = self.steps.pop_front().expect("unexpected extra command");
            assert_eq!(channel, expected_channel);
            assert_eq!(command, expected_command);
            result
        }
    }

    fn host(address: &str) -> Ipv4Addr { address.parse().unwrap() }
    fn network(address: &str) -> Channel { Channel::Network(host(address)) }
    fn step(channel: Channel, command: &str, result: Result<String, String>) -> (Channel, String, Result<String, String>) {
        (channel, command.into(), result)
    }
    fn output(name: &str, address: &str, gateway: &str) -> String {
        format!("nsh> \x1b[K{name}\tLink encap:Ethernet HWaddr 02:00:00:00:00:01 at RUNNING mtu 1500\n\tinet addr:{address} DRaddr:{gateway} Mask:255.255.255.0\nnsh> \x1b[K")
    }

    #[test]
    fn auto_falls_back_to_network_and_reconnects_after_active_ip_change() {
        let mut commands = FakeCommands { host: host("192.168.144.82"), steps: VecDeque::from([
            step(Channel::Usb, "ifconfig eth0", Err("USB not found".into())),
            step(network("192.168.144.82"), "ifconfig eth0", Ok(output("eth0", "192.168.144.82", "0.0.0.0"))),
            step(network("192.168.144.82"), "ifconfig eth0 192.168.144.83 netmask 255.255.255.0 gateway 0.0.0.0", Err("old TCP connection closed".into())),
            step(network("192.168.144.83"), "ifconfig eth0", Err("ARP settling".into())),
            step(network("192.168.144.83"), "ifconfig eth0", Ok(output("eth0", "192.168.144.83", "0.0.0.0"))),
        ]) };
        let requested = requested_interface("eth0", "192.168.144.83", "255.255.255.0", "0.0.0.0").unwrap();
        let actual = apply(&mut commands, TransportMode::Auto, requested.clone()).unwrap();
        assert_eq!(actual.interface, requested);
        assert_eq!(actual.transport, "network");
        assert_eq!(actual.control_host, Some(host("192.168.144.83")));
        assert!(commands.steps.is_empty());
    }

    #[test]
    fn auto_uses_usb_when_available_without_retargeting_another_port() {
        let mut commands = FakeCommands { host: host("192.168.101.82"), steps: VecDeque::from([
            step(Channel::Usb, "ifconfig eth0", Ok(output("eth0", "192.168.144.82", "0.0.0.0"))),
            step(Channel::Usb, "ifconfig eth0 192.168.144.83 netmask 255.255.255.0 gateway 0.0.0.0", Ok(String::new())),
            step(Channel::Usb, "ifconfig eth0", Ok(output("eth0", "192.168.144.83", "0.0.0.0"))),
        ]) };
        let requested = requested_interface("eth0", "192.168.144.83", "255.255.255.0", "0.0.0.0").unwrap();
        let actual = apply(&mut commands, TransportMode::Auto, requested).unwrap();
        assert_eq!(actual.transport, "usb");
        assert_eq!(actual.control_host, None);
        assert!(commands.steps.is_empty());
    }

    #[test]
    fn network_mode_keeps_the_active_port_when_configuring_the_other_port() {
        let peer = network("192.168.101.82");
        let mut commands = FakeCommands { host: host("192.168.101.82"), steps: VecDeque::from([
            step(peer, "ifconfig eth0", Ok(output("eth0", "192.168.144.82", "0.0.0.0").replace("at RUNNING", "at DOWN"))),
            step(peer, "ifconfig eth0 192.168.144.83 netmask 255.255.255.0 gateway 0.0.0.0", Ok(String::new())),
            step(peer, "ifup eth0", Ok("ifup eth0...OK".into())),
            step(peer, "ifconfig eth0", Ok(output("eth0", "192.168.144.83", "0.0.0.0"))),
        ]) };
        let requested = requested_interface("eth0", "192.168.144.83", "255.255.255.0", "0.0.0.0").unwrap();
        let actual = apply(&mut commands, TransportMode::Network, requested).unwrap();
        assert_eq!(actual.control_host, None);
        assert!(commands.steps.is_empty());
    }

    #[test]
    fn failed_usb_write_is_not_repeated_over_network() {
        let mut commands = FakeCommands { host: host("192.168.144.82"), steps: VecDeque::from([
            step(Channel::Usb, "ifconfig eth0", Ok(output("eth0", "192.168.144.82", "0.0.0.0"))),
            step(Channel::Usb, "ifconfig eth0 192.168.144.83 netmask 255.255.255.0 gateway 0.0.0.0", Err("USB reply timed out".into())),
        ]) };
        let requested = requested_interface("eth0", "192.168.144.83", "255.255.255.0", "0.0.0.0").unwrap();
        assert!(apply(&mut commands, TransportMode::Auto, requested).unwrap_err().contains("USB reply timed out"));
        assert!(commands.steps.is_empty());
    }

    #[test]
    fn a_different_device_at_the_new_ip_cannot_acknowledge_a_save() {
        let peer = network("192.168.144.82");
        let mut commands = FakeCommands { host: host("192.168.144.82"), steps: VecDeque::from([
            step(peer, "ifconfig eth0", Ok(output("eth0", "192.168.144.82", "0.0.0.0"))),
            step(peer, "ifconfig eth0 192.168.144.83 netmask 255.255.255.0 gateway 0.0.0.0", Ok(String::new())),
            step(network("192.168.144.83"), "ifconfig eth0", Ok(output("eth0", "192.168.144.83", "0.0.0.0").replace("02:00:00:00:00:01", "02:00:00:00:00:02"))),
        ]) };
        let requested = requested_interface("eth0", "192.168.144.83", "255.255.255.0", "0.0.0.0").unwrap();
        assert!(apply(&mut commands, TransportMode::Network, requested).unwrap_err().contains("different Ethernet device"));
        assert!(commands.steps.is_empty());
    }

    #[test]
    fn mismatched_readback_is_not_reported_as_saved() {
        let peer = network("192.168.144.82");
        let mut steps = VecDeque::from([
            step(peer, "ifconfig eth0", Ok(output("eth0", "192.168.144.82", "0.0.0.0"))),
            step(peer, "ifconfig eth0 192.168.144.82 netmask 255.255.255.0 gateway 192.168.144.1", Ok(String::new())),
        ]);
        for _ in 0..5 { steps.push_back(step(peer, "ifconfig eth0", Ok(output("eth0", "192.168.144.82", "0.0.0.0")))); }
        let mut commands = FakeCommands { host: host("192.168.144.82"), steps };
        let requested = requested_interface("eth0", "192.168.144.82", "255.255.255.0", "192.168.144.1").unwrap();
        assert!(apply(&mut commands, TransportMode::Network, requested).unwrap_err().contains("not verified"));
        assert!(commands.steps.is_empty());
    }

    #[test]
    fn reads_nuttx_interface_fields() {
        let output = "eth0\tLink encap:Ethernet at UP mtu 1500\n\tinet addr:192.168.101.81 DRaddr:192.168.101.1 Mask:255.255.255.0\n\neth1\tLink encap:Ethernet at DOWN mtu 1500\n\tinet addr:10.0.0.2 DRaddr:10.0.0.1 Mask:255.255.255.0\n";
        let found = parse_ifconfig(output);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].address, "192.168.101.81");
        assert_eq!(found[1].name, "eth1");
        assert_eq!(found[1].gateway, "10.0.0.1");
    }

    #[test]
    fn reads_first_interface_after_telnet_prompt_and_terminal_controls() {
        // NSH echoes the command without a newline after its prompt. Its
        // readline clear-line sequences are attached to the first header.
        let output = "\n\rNuttShell (NSH) NuttX-13.0.0\n\rnsh> \x1b[K\x1b[Keth0\tLink encap:Ethernet HWaddr c0:74:2b:ff:24:13 at RUNNING mtu 1500\n\r\tinet addr:192.168.144.82 DRaddr:0.0.0.0 Mask:255.255.255.0\n\r\n\reth1\tLink encap:Ethernet HWaddr c0:74:2b:ff:24:12 at UP mtu 1500\n\r\tinet addr:192.168.101.82 DRaddr:192.168.101.1 Mask:255.255.255.0\n\rnsh> \x1b[K";
        let found = parse_ifconfig(output);
        assert_eq!(found.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(), ["eth0", "eth1"]);
        assert_eq!(found[0].address, "192.168.144.82");
        assert_eq!(found[0].gateway, "0.0.0.0");
        assert_eq!(found[1].address, "192.168.101.82");
    }

    #[test]
    fn keeps_down_and_unconfigured_interfaces_in_prompted_output() {
        let output = "nsh> eth0\tLink encap:Ethernet at DOWN mtu 1500\n\tinet addr:0.0.0.0 DRaddr:0.0.0.0 Mask:0.0.0.0\neth1\tLink encap:Ethernet at RUNNING mtu 1500\n\tinet addr:192.168.101.82 DRaddr:192.168.101.1 Mask:255.255.255.0\n";
        let found = parse_ifconfig(output);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].name, "eth0");
        assert_eq!(found[0].address, "0.0.0.0");
    }

    #[test]
    fn netmasks_are_contiguous() {
        assert!(valid_mask("255.255.255.0".parse().unwrap()));
        assert!(!valid_mask("255.0.255.0".parse().unwrap()));
        assert!(!valid_mask("0.0.0.0".parse().unwrap()));
    }
}
