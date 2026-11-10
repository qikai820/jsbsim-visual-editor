#![allow(dead_code)]
#[allow(dead_code)] #[path = "../src/model_read.rs"] mod model_read;
#[path = "../src/network_files.rs"] mod network_files;
#[path = "../src/romfs_network.rs"] mod romfs_network;
#[path = "../src/storage_usage.rs"] mod storage_usage;
#[path = "../src/transport.rs"] mod transport;
#[path = "../src/network_discovery.rs"] mod network_discovery;
#[path = "../src/usb_file.rs"] mod usb_file;
#[path = "../src/px4_router.rs"] mod px4_router;

#[test]
#[ignore = "requires simulator; switches toolbox UDP port temporarily and restores it"]
fn live_router_settings_roundtrip() {
    transport::set_mode("network").unwrap();
    let before=px4_router::read().unwrap();
    assert_eq!(before.state,"running");
    let mut changed=before.config.clone();changed.toolbox_port=if changed.toolbox_port==14554{14553}else{14554};
    let applied=px4_router::apply(changed.clone(),before.config.clone(),&before.simulator).unwrap();
    assert_eq!(applied.active_config,changed);
    let restored=px4_router::apply(before.config.clone(),changed,&before.simulator).unwrap();
    assert_eq!(restored.active_config,before.active_config);
    println!("Restored verified router settings: {}",serde_json::to_string(&restored).unwrap());
}

#[test]
#[ignore = "requires disarmed, idle simulator; stops/starts forwarding and verifies persistent daemon ownership"]
fn live_router_control_session_exit() {
    transport::set_mode("network").unwrap();
    let before=px4_router::read().unwrap();
    let host=before.simulator.parse().unwrap();
    let pid=||romfs_network::with_host_session(host,|session|{
        session.command("ps")?.lines().find(|line|line.ends_with("mavlink_router"))
            .and_then(|line|line.split_whitespace().next()).map(str::to_owned).ok_or("router owner task missing".into())
    }).unwrap();
    let owner=pid();
    assert_eq!(px4_router::control("stop",&before.simulator).unwrap().state,"stopped");
    assert_eq!(pid(),owner,"stopping forwarding must not terminate a shared USB owner task group");
    assert_eq!(px4_router::control("start",&before.simulator).unwrap().state,"running");
    assert_eq!(pid(),owner);
    println!("Management sessions exited cleanly; persistent router owner PID {owner}");
}
