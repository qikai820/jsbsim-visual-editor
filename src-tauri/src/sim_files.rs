//! File-manager access follows the same transport selection as model transfer.
use std::path::Path;
use crate::{network_files as network, usb_file as usb};
pub(crate) use usb::{crc32, crc32_fold, has_long_component, managed_volume, UsbFileEntry};

pub const NETWORK_IDENTITY: &str = "nuttx-network-files/1";

pub fn source() -> &'static str {
    if crate::ftp_sync::use_usb() { "usb-bulk" } else { "nuttx-network" }
}

pub fn ping() -> Result<String, String> {
    if crate::ftp_sync::use_usb() { usb::ping() }
    else { network::storage()?; Ok(NETWORK_IDENTITY.into()) }
}

pub fn storage() -> Result<Vec<crate::storage_usage::StorageUsage>, String> {
    if crate::ftp_sync::use_usb() {
        crate::storage_usage::parse(&usb::nsh_execute(crate::storage_usage::COMMAND)?)
    } else { network::storage() }
}

/// File operations use sd/... and data/...; native/MCP pickers may also supply
/// an absolute path shown by the simulator. Resolve only its actual volume root.
pub fn managed_file_path(path: &str) -> Result<String, String> {
    if !path.starts_with('/') {
        managed_volume(path)?;
        return Ok(path.into());
    }
    managed_file_path_at(path, &storage()?)
}

fn managed_file_path_at(path: &str, volumes: &[crate::storage_usage::StorageUsage]) -> Result<String, String> {
    for volume in volumes {
        if let Some(tail) = path.strip_prefix(volume.mount_path).and_then(|s| s.strip_prefix('/')) {
            if volume.total_bytes.is_none() { return Err(format!("{} 未挂载", volume.mount_path)); }
            let managed = format!("{}/{tail}", volume.volume);
            managed_volume(&managed)?;
            return Ok(managed);
        }
    }
    Err("固件路径必须位于仿真机当前挂载的数据盘或 SD 卡内".into())
}

pub fn list(path: &str) -> Result<Vec<UsbFileEntry>, String> {
    if crate::ftp_sync::use_usb() { usb::list(path) } else { network::list(path) }
}

pub fn list_with_modified(path: &str) -> Result<Vec<UsbFileEntry>, String> {
    if crate::ftp_sync::use_usb() { usb::list_with_modified(path) } else { network::list(path) }
}

pub fn stat(path: &str) -> Result<UsbFileEntry, String> {
    if crate::ftp_sync::use_usb() { usb::stat(path) } else { network::stat(path) }
}

pub fn validate_editable_file(path: &str) -> Result<(), String> {
    managed_volume(path)?;
    if stat(path)?.directory { return Err("请选择普通文件".into()); }
    Ok(())
}

pub fn read_limited(path: &str, limit: usize) -> Result<Vec<u8>, String> {
    if crate::ftp_sync::use_usb() { usb::read_limited(path, limit) } else { network::read_limited(path, limit) }
}

pub fn read_all(path: &str) -> Result<Vec<u8>, String> {
    read_limited(path, 16 * 1024 * 1024)
}

pub fn download_to_fingerprint(path: &str, target: &Path) -> Result<(u64, u32), String> {
    if crate::ftp_sync::use_usb() { usb::download_to_fingerprint(path, target) }
    else { network::download_to_fingerprint(path, target) }
}

pub fn fingerprint(path: &str) -> Result<(u64, u32), String> {
    if crate::ftp_sync::use_usb() { usb::fingerprint(path) } else { network::fingerprint(path) }
}

pub fn write_all(path: &str, bytes: &[u8]) -> Result<(), String> {
    if crate::ftp_sync::use_usb() { usb::write_all(path, bytes) } else { network::write_all(path, bytes) }
}

pub fn upload_from(path: &str, source: &Path) -> Result<u64, String> {
    if crate::ftp_sync::use_usb() { usb::upload_from(path, source) } else { network::upload_from(path, source) }
}

pub fn delete(path: &str) -> Result<(), String> {
    if crate::ftp_sync::use_usb() { usb::delete(path) } else { network::delete(path) }
}

pub fn delete_directory_tree(path: &str) -> Result<(), String> {
    if crate::ftp_sync::use_usb() { usb::delete_directory_tree(path) } else { network::delete_directory_tree(path) }
}

pub fn mkdir(path: &str) -> Result<(), String> {
    if crate::ftp_sync::use_usb() { usb::mkdir(path) } else { network::mkdir(path) }
}

pub fn transfer(source: &str, destination: &str, move_source: bool) -> Result<(), String> {
    if crate::ftp_sync::use_usb() { usb::transfer(source, destination, move_source) }
    else { network::transfer(source, destination, move_source) }
}

pub fn remove_tree(path: &str, directory: bool) -> Result<(), String> {
    if directory { delete_directory_tree(path) } else { delete(path) }
}

#[cfg(test)]
mod path_tests {
    use super::*;
    #[test]
    fn absolute_firmware_paths_follow_actual_ssd_emmc_and_sd_mounts() {
        let header="Size Blocks Used Available Mounted on\n";
        let ssd=crate::storage_usage::parse(&format!("{header}4096 100 0 100 /mnt/home\n512 100 0 100 /mnt/sdcard\n")).unwrap();
        assert_eq!(managed_file_path_at("/mnt/home/firmware/a.px4",&ssd).unwrap(),"data/firmware/a.px4");
        assert_eq!(managed_file_path_at("/mnt/sdcard/a.px4",&ssd).unwrap(),"sd/a.px4");
        let emmc=crate::storage_usage::parse(&format!("{header}4096 100 0 100 /data\n")).unwrap();
        assert_eq!(managed_file_path_at("/data/a.px4",&emmc).unwrap(),"data/a.px4");
        assert_eq!(managed_file_path("data/firmware/a.px4").unwrap(),"data/firmware/a.px4");
        for path in ["/data/a.px4","/mnt/home-other/a.px4","/etc/a.px4","/mnt/home/../a.px4","/mnt/home//a.px4","/mnt/home/"] {
            assert!(managed_file_path_at(path,&ssd).is_err(),"{path}");
        }
        assert!(managed_file_path_at("/mnt/sdcard/a.px4",&emmc).unwrap_err().contains("未挂载"));
        assert!(managed_file_path_at(&format!("/mnt/home/{}.px4","x".repeat(65)),&ssd).is_err());
    }
}
