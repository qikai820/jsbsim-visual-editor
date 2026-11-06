#[allow(dead_code)] #[path = "../src/network_files.rs"] mod network_files;
#[allow(dead_code)] #[path = "../src/romfs_network.rs"] mod romfs_network;
#[allow(dead_code)] #[path = "../src/storage_usage.rs"] mod storage_usage;
#[allow(dead_code)] #[path = "../src/transport.rs"] mod transport;
#[allow(dead_code)] #[path = "../src/network_discovery.rs"] mod network_discovery;
#[allow(dead_code)] #[path = "../src/usb_file.rs"] mod usb_file;
#[allow(dead_code)] #[path = "../src/sim_files.rs"] mod sim_files;
#[allow(dead_code)] #[path = "../src/usb_file_editor.rs"] mod usb_file_editor;
fn download_usb_file(_: &str, _: &str) -> Result<(std::path::PathBuf, u64, u32), String> {
    Err("native computer editor is outside this network regression".into())
}
async fn run_blocking<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    operation()
}
// Explicit Network mode must not select USB, even when it is plugged in.
mod ftp_sync {
    pub fn use_usb() -> bool {
        assert_eq!(crate::transport::mode(), crate::transport::TransportMode::Network);
        false
    }
}

#[test]
#[ignore = "requires the simulator; writes and removes only its own temporary data directory"]
fn live_network_file_manager() {
    use std::time::{SystemTime, UNIX_EPOCH};
    transport::set_mode("network").unwrap();
    assert_eq!(sim_files::source(), "nuttx-network");
    assert_eq!(sim_files::ping().unwrap(), sim_files::NETWORK_IDENTITY);
    let storage = sim_files::storage().unwrap();
    assert!(storage.iter().any(|volume| volume.volume == "data" && volume.total_bytes.is_some()));
    if storage.iter().any(|volume| volume.volume == "sd" && volume.total_bytes.is_none()) {
        assert!(sim_files::list("sd").unwrap_err().contains("未挂载"));
        let error = sim_files::write_all("sd/must-not-create.txt", b"never written").unwrap_err();
        assert!(error.contains("未挂载"), "{error}");
    }
    assert!(!sim_files::list("data").unwrap().is_empty());
    let root = format!("data/.codex-fm-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
    sim_files::mkdir(&root).unwrap();
    let result = std::panic::catch_unwind(|| {
        let path = format!("{root}/file space's $name.txt");
        let mut bytes: Vec<u8> = (0..=255).collect();
        bytes.extend_from_slice(b"<xml>$variable `command` %s</xml>\r\n");
        bytes.extend_from_slice("中文文件内容\n".as_bytes());
        sim_files::write_all(&path, &bytes).unwrap();
        assert_eq!(sim_files::read_limited(&path, bytes.len()).unwrap(), bytes);
        assert_eq!(sim_files::stat(&path).unwrap().size, bytes.len() as u64);
        assert_eq!(sim_files::fingerprint(&path).unwrap(), (bytes.len() as u64, usb_file::crc32(&bytes)));
        let renamed = format!("{root}/renamed.bin");
        sim_files::transfer(&path, &renamed, true).unwrap();
        assert!(sim_files::stat(&path).unwrap_err().contains("errno 2"));
        let copy = format!("{root}/copy.bin");
        sim_files::transfer(&renamed, &copy, false).unwrap();
        assert_eq!(sim_files::read_all(&copy).unwrap(), bytes);
        assert!(sim_files::transfer(&renamed, &copy, false).is_err());
        assert!(sim_files::read_limited(&copy, 1).is_err());
        sim_files::write_all(&copy, b"edited\n").unwrap();
        assert_eq!(sim_files::read_all(&copy).unwrap(), b"edited\n");
        let opened = usb_file_editor::open_builtin(&copy).unwrap();
        assert_eq!(opened.content, "edited\n");
        assert!(!usb_file_editor::save_builtin(&copy, opened.content.clone(), opened.size, opened.checksum).unwrap().changed);
        sim_files::write_all(&copy, b"external change\n").unwrap();
        assert!(usb_file_editor::save_builtin(&copy, "conflicting edit\n".into(), opened.size, opened.checksum).is_err());
        assert_eq!(sim_files::read_all(&copy).unwrap(), b"external change\n");
        let reopened = usb_file_editor::open_builtin(&copy).unwrap();
        assert!(usb_file_editor::save_builtin(&copy, "saved from editor\n".into(), reopened.size, reopened.checksum).unwrap().changed);
        assert_eq!(sim_files::read_all(&copy).unwrap(), b"saved from editor\n");
        let empty = format!("{root}/empty.txt");
        sim_files::write_all(&empty, b"").unwrap();
        assert!(sim_files::read_all(&empty).unwrap().is_empty());
        let directory = format!("{root}/folder");
        sim_files::mkdir(&directory).unwrap();
        sim_files::write_all(&format!("{directory}/child.txt"), b"child").unwrap();
        sim_files::transfer(&directory, &format!("{root}/folder-copy"), false).unwrap();
        assert_eq!(sim_files::read_all(&format!("{root}/folder-copy/child.txt")).unwrap(), b"child");
        sim_files::delete(&empty).unwrap();
        println!("network file manager: SD mount guard, capacity, listing, binary/text writes, readback, rename, copy, editor save/conflict protection and recursive directory copy passed");
    });
    let cleanup = sim_files::delete_directory_tree(&root);
    assert!(cleanup.is_ok(), "temporary test directory cleanup: {cleanup:?}");
    assert!(sim_files::stat(&root).is_err());
    if let Err(error) = result { std::panic::resume_unwind(error); }
}
