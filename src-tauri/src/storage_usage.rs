//! Exact filesystem capacities from NuttX /proc/fs/blocks, without rounding df -h.
use serde::Serialize;

pub const COMMAND: &str = "cat /proc/fs/blocks";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub volume: &'static str,
    pub mount_path: &'static str,
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
}

pub fn parse(output: &str) -> Result<Vec<StorageUsage>, String> {
    let mut volumes = vec![
        StorageUsage { volume: "sd", mount_path: "/mnt/sdcard", total_bytes: None, used_bytes: None, available_bytes: None },
        StorageUsage { volume: "data", mount_path: "/data", total_bytes: None, used_bytes: None, available_bytes: None },
    ];
    // A command error must not be mistaken for two unmounted volumes.
    let mut has_header = false;
    for line in output.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields == ["Size", "Blocks", "Used", "Available", "Mounted", "on"] {
            has_header = true;
            continue;
        }
        let mount = match fields.last().copied() {
            Some("/mnt/sdcard") => "/mnt/sdcard",
            Some("/data") => "/data",
            Some("/mnt/home") => "/mnt/home",
            _ => continue,
        };
        let key = if mount == "/mnt/sdcard" { "sd" } else { "data" };
        let Some(volume) = volumes.iter_mut().find(|volume| volume.volume == key) else {
            continue;
        };
        // Reject ambiguous data roots rather than writing to an arbitrary disk.
        if volume.total_bytes.is_some() { return Err("Multiple mounted data volumes".into()); }
        volume.mount_path = mount;
        let invalid = || format!("Invalid storage statistics for {}", volume.mount_path);
        if fields.len() != 5 || volume.total_bytes.is_some() { return Err(invalid()); }
        let counts = fields[..4].iter().map(|field| field.parse::<u64>())
            .collect::<Result<Vec<_>, _>>().map_err(|_| invalid())?;
        let [block_size, blocks, used, available] = counts[..] else { unreachable!() };
        if block_size == 0 || blocks == 0 || used.checked_add(available) != Some(blocks) {
            return Err(invalid());
        }
        volume.total_bytes = Some(block_size.checked_mul(blocks).ok_or_else(invalid)?);
        volume.used_bytes = Some(block_size.checked_mul(used).ok_or_else(invalid)?);
        volume.available_bytes = Some(block_size.checked_mul(available).ok_or_else(invalid)?);
    }
    if !has_header { return Err("Simulator did not return /proc/fs/blocks storage statistics".into()); }
    Ok(volumes)
}

#[cfg(test)]
mod tests {
    use super::*;
    const HEADER: &str = "  Block    Number\r\n  Size     Blocks       Used   Available Mounted on\r\n";

    #[test]
    fn reads_both_volumes_in_bytes_above_four_gib() {
        let volumes = parse(&format!("{HEADER}512 62500000 12500000 50000000 /mnt/sdcard\r\n4096 1000000 400000 600000 /data\r\n0 0 0 0 /proc\r\n")).unwrap();
        assert_eq!(volumes[0].total_bytes, Some(32_000_000_000));
        assert_eq!(volumes[0].used_bytes, Some(6_400_000_000));
        assert_eq!(volumes[0].available_bytes, Some(25_600_000_000));
        assert_eq!(volumes[1].total_bytes, Some(4_096_000_000));
        assert_eq!(volumes[1].used_bytes, Some(1_638_400_000));
    }

    #[test]
    fn missing_mount_is_unknown_and_never_uses_parent_or_nested_mount() {
        let volumes = parse(&format!("{HEADER}512 100 100 0 /data\n512 1000 1 999 /\n512 1000 1 999 /mnt/sdcard/other\n")).unwrap();
        assert_eq!(volumes[0].total_bytes, None);
        assert_eq!(volumes[1].available_bytes, Some(0));
        let empty = parse(&format!("{HEADER}512 100 0 100 /data\n")).unwrap();
        assert_eq!(empty[1].used_bytes, Some(0));
    }

    #[test]
    fn recognizes_orangepi_ssd_and_rejects_ambiguous_data_roots() {
        let output = format!("{HEADER}4096 1000000 400000 600000 /mnt/home\n");
        let volumes = parse(&output).unwrap();
        assert_eq!(volumes[1].volume, "data");
        assert_eq!(volumes[1].mount_path, "/mnt/home");
        assert_eq!(volumes[1].total_bytes, Some(4_096_000_000));
        assert!(parse(&format!("{output}4096 10 1 9 /data\n")).is_err());
    }

    #[test]
    fn rejects_command_errors_inconsistent_counts_and_overflow() {
        assert!(parse("nsh: cat: open failed: No such file or directory").is_err());
        for row in ["512 100 10 100 /data", "512 invalid 0 0 /data", "0 100 0 100 /data",
            "4096 18446744073709551615 0 18446744073709551615 /data", "512 100 10 90 /data\n512 100 10 90 /data"] {
            assert!(parse(&format!("{HEADER}{row}\n")).is_err(), "{row}");
        }
    }

    #[test]
    #[ignore = "requires the real simulator with exclusive USB access; read-only NSH query"]
    fn live_usb_storage_usage() {
        let output = crate::usb_file::nsh_execute(COMMAND).unwrap();
        let volumes = parse(&output).unwrap();
        println!("{}", serde_json::to_string_pretty(&volumes).unwrap());
        assert!(volumes.iter().any(|volume| volume.total_bytes.is_some()));
    }
}
