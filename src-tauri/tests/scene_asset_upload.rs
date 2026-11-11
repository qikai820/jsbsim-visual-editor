#![cfg(unix)]
#![allow(dead_code)]

#[path = "../src/model_read.rs"] mod model_read;
#[path = "../src/ftp_sync.rs"] mod ftp_sync;
#[path = "../src/romfs_network.rs"] mod romfs_network;
#[path = "../src/transport.rs"] mod transport;
#[path = "../src/network_discovery.rs"] mod network_discovery;
#[path = "../src/usb_file.rs"] mod usb_file;

// An isolated curl/storage fixture verifies the complete replacement protocol.
// No physical simulator is contacted or modified.
#[test]
fn collision_assets_report_progress_and_verify_before_and_after_commit() {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    let directory = std::env::temp_dir().join(format!("scene-upload-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let keys = ["PATH", "NUTTX_FTP_URL", "ASSET_TEST_DIR", "ASSET_TEST_FAILURE"];
    struct Cleanup { path: std::path::PathBuf, vars: Vec<(&'static str, Option<std::ffi::OsString>)> }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for (key, value) in &self.vars {
                if let Some(value) = value { std::env::set_var(key, value); }
                else { std::env::remove_var(key); }
            }
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
    let _cleanup = Cleanup { path: directory.clone(), vars: keys.iter().map(|&key| (key, std::env::var_os(key))).collect() };
    let curl = directory.join("curl");
    std::fs::write(&curl, r#"#!/usr/bin/env python3
import os, pathlib, sys, urllib.parse
args = sys.argv[1:]
root = pathlib.Path(os.environ['ASSET_TEST_DIR'])
failure = os.environ.get('ASSET_TEST_FAILURE', '')
def local(path):
    path = root / path.lstrip('/')
    path.parent.mkdir(parents=True, exist_ok=True)
    return path
if '--upload-file' in args:
    content = sys.stdin.buffer.read()
    path = local(urllib.parse.urlsplit(args[-1]).path)
    path.write_bytes(content)
    if failure == 'upload':
        path.write_bytes(content[:10])
        print('fixture: upload interrupted', file=sys.stderr)
        sys.exit(28)
elif '-Q' in args:
    source = None
    for i, arg in enumerate(args):
        if arg != '-Q': continue
        command, path = args[i+1].split(' ', 1)
        if command == 'RNFR':
            source = local(path)
            if not source.exists(): sys.exit(21)
        elif command == 'RNTO': source.rename(local(path))
else:
    path = local(urllib.parse.urlsplit(args[-1]).path)
    assert '--speed-time' in args and '--max-time' in args
    assert int(args[args.index('--max-time')+1]) >= 16
    content = path.read_bytes()
    if (failure == 'temporary' and path.name.endswith('.upload')) or (failure == 'remote' and path.name == 'scene.collision'):
        content = b'corrupted readback'
    sys.stdout.buffer.write(content)
"#).unwrap();
    std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("PATH", format!("{}:{}", directory.display(), std::env::var("PATH").unwrap()));
    std::env::set_var("NUTTX_FTP_URL", "ftp://127.0.0.1");
    std::env::set_var("ASSET_TEST_DIR", &directory);
    std::env::remove_var("ASSET_TEST_FAILURE");
    transport::set_mode("network").unwrap();

    let target = directory.join("jsbsim/aircraft/voliro_t/scene.collision");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, b"previous map").unwrap();
    let content = vec![b'x'; 64 * 1024];
    let started = Instant::now();
    let mut events = Vec::new();
    ftp_sync::upload_model_asset_with_progress("voliro_t", "scene.collision", &content, |event| events.push(event)).unwrap();
    assert!(started.elapsed() < Duration::from_secs(4), "large assets still use small-XML pacing: {:?}", started.elapsed());
    assert_eq!(std::fs::read(&target).unwrap(), content);
    let stages = events.iter().map(|e| e.stage).fold(Vec::new(), |mut stages, stage| {
        if stages.last() != Some(&stage) { stages.push(stage); } stages
    });
    assert_eq!(stages, ["waiting", "upload", "verify_temporary", "commit", "verify"]);
    assert!(events.iter().all(|e| e.total == content.len() as u64 && e.transferred <= e.total));
    assert!(events.iter().any(|e| e.stage == "upload" && e.transferred > 0 && e.transferred < e.total));
    assert_eq!(events.last().unwrap().transferred, content.len() as u64);

    for failure in ["upload", "temporary", "remote"] {
        std::fs::write(&target, b"previous map").unwrap();
        std::env::set_var("ASSET_TEST_FAILURE", failure);
        let mut events = Vec::new();
        let error = ftp_sync::upload_model_asset_with_progress("voliro_t", "scene.collision", &content, |event| events.push(event)).unwrap_err();
        if failure == "remote" {
            assert!(error.contains("differs on SD card"));
            assert!(!events.iter().any(|e| e.stage == "verify" && e.transferred == e.total));
        } else {
            assert_eq!(std::fs::read(&target).unwrap(), b"previous map", "failed temporary upload/readback replaced the old map");
            assert!(!events.iter().any(|e| e.stage == "commit"));
        }
    }
}
