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
