use serde::Serialize;
use std::net::Ipv4Addr;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Interface {
    pub name: String,
    pub address: String,
    pub netmask: String,
    pub gateway: String,
}

fn field<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    line.split_whitespace().find_map(|part| part.strip_prefix(prefix))
}

pub fn parse_ifconfig(output: &str) -> Vec<Interface> {
    let mut interfaces = Vec::new();
    let mut name = String::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some((candidate, _)) = trimmed.split_once("Link encap:") {
            name = candidate.trim().to_owned();
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
    let output = crate::usb_file::nsh_execute("ifconfig").or_else(|usb_error| {
        if crate::transport::mode() == crate::transport::TransportMode::Usb {
            Err(usb_error)
        } else {
            crate::nsh_execute_tcp("ifconfig").map_err(|network_error| {
                format!("USB readback unavailable ({usb_error}); network readback unavailable ({network_error})")
            })
        }
    })?;
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

pub fn set(name: &str, address: &str, netmask: &str, gateway: &str) -> Result<Interface, String> {
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
    // The IP change can terminate TCP/FTP immediately. USB keeps the readback
    // channel available even if the host no longer shares the new subnet.
    let before = crate::usb_file::nsh_execute(&format!("ifconfig {name}"))?;
    if !parse_ifconfig(&before).iter().any(|item| item.name == name) {
        return Err(format!("{name} was not reported by the simulator"));
    }
    let command = format!("ifconfig {name} {ip} netmask {mask} gateway {router}");
    let response = crate::usb_file::nsh_execute(&command)?;
    if response.contains("nsh: ") || response.contains("Failed") {
        return Err(format!("Simulator rejected network configuration: {response}"));
    }
    if before.contains(" at DOWN ") {
        let response = crate::usb_file::nsh_execute(&format!("ifup {name}"))?;
        if !response.contains(&format!("ifup {name}...OK")) {
            return Err(format!("Simulator could not bring up {name}: {response}"));
        }
    }
    let output = crate::usb_file::nsh_execute(&format!("ifconfig {name}"))?;
    let actual = parse_ifconfig(&output).into_iter().find(|item| item.name == name)
        .ok_or_else(|| format!("No {name} readback after configuration: {output}"))?;
    if actual.address != ip.to_string() || actual.netmask != mask.to_string() || actual.gateway != router.to_string() {
        return Err(format!("Simulator readback differs from the requested configuration: {} / {} / {}", actual.address, actual.netmask, actual.gateway));
    }
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn netmasks_are_contiguous() {
        assert!(valid_mask("255.255.255.0".parse().unwrap()));
        assert!(!valid_mask("255.0.255.0".parse().unwrap()));
        assert!(!valid_mask("0.0.0.0".parse().unwrap()));
    }
}
