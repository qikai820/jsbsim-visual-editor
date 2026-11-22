#[path = "../src/runtime_tuning.rs"]
mod runtime_tuning;
use runtime_tuning::{Edit, packet, ingest, snapshot, apply};
use serde_json::json;
#[test]
fn packet_is_little_endian_bounded_and_rejects_invalid_inputs() {
    let bytes=packet(2,17,"0102030405060708",&[Edit{key:"atmosphere/wind-east-fps".into(),value:-12.5}]).unwrap();
    assert_eq!(&bytes[..8],b"VPAR\x02\x01\0\0");
    assert_eq!(&bytes[8..12],&17u32.to_le_bytes());
    assert_eq!(&bytes[12..20],&0x0102030405060708u64.to_le_bytes());
    assert_eq!(&bytes[bytes.len()-8..],&(-12.5f64).to_le_bytes());
    for (id,session) in [(0,"0102030405060708"),(33,"0102030405060708"),(1,"0"),(1,"0000000000000000")] { assert!(packet(id,17,session,&[Edit{key:"x".into(),value:1.}]).is_err()); }
    for key in ["../x","x\ny","x\0y","x\"y"] { assert!(packet(1,17,"0102030405060708",&[Edit{key:key.into(),value:1.}]).is_err()); }
    assert!(packet(1,17,"0102030405060708",&[Edit{key:"x".into(),value:f64::NAN}]).is_err());
    assert!(packet(1,17,"0102030405060708",&[Edit{key:"x".into(),value:1.},Edit{key:"x".into(),value:2.}]).is_err());
}
#[test]
fn only_fdm_ack_and_actual_readback_confirm_an_edit() {
    let session="0123456789abcdef";
    ingest(&json!({"instance_id":"30","model":"live","state":"paused","timestamp":12.5,"monitor":{"tuning":{"version":1,"session":session,"request":0,"status":"","values":[]}}}));
    let result=apply(30,session,"live",&[Edit{key:"atmosphere/wind-east-fps".into(),value:4.}],|bytes|{
        let request=u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        ingest(&json!({"instance_id":"30","model":"live","state":"paused","timestamp":12.5,"monitor":{"tuning":{"version":1,"session":session,"request":request,"status":"applied","values":[4.]}}}));
        Ok(())
    }).unwrap();
    assert_eq!(result["timestamp"],12.5);
    let error=apply(30,session,"live",&[Edit{key:"atmosphere/wind-east-fps".into(),value:4.}],|bytes|{
        let request=u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        ingest(&json!({"instance_id":"30","model":"live","state":"paused","timestamp":12.5,"monitor":{"tuning":{"version":1,"session":session,"request":request,"status":"applied","values":[3.]}}})); Ok(())
    }).unwrap_err();
    assert!(error.contains("实际值"));
    assert!(apply(30,session,"wrong",&[Edit{key:"x".into(),value:1.}],|_|panic!("must not send")).is_err());
    assert!(snapshot(31).is_none());
}
#[test]
fn inertia_requires_capability_and_confirms_all_six_actual_values() {
    let session="0123456789abcd21";
    let edits:Vec<_>=["ixx","iyy","izz","ixy","ixz","iyz"].into_iter().zip([6.,8.,10.,0.,0.,0.]).map(|(key,value)|Edit{key:format!("_tuning/inertia/{key}-slugs_ft2"),value}).collect();
    let frame=|enabled:bool,request:u32,status:&str|json!({"instance_id":"29","model":"live","state":"paused","timestamp":19.5,"monitor":{"tuning":{"version":1,"inertia":enabled,"session":session,"request":request,"status":status,"values":[6.,8.,10.,0.,0.,0.]}}});
    ingest(&frame(false,0,""));
    assert!(apply(29,session,"live",&edits,|_|panic!("old firmware must not receive inertia edits")).unwrap_err().contains("更新仿真机固件"));
    ingest(&frame(true,0,""));
    let result=apply(29,session,"live",&edits,|bytes|{let request=u32::from_le_bytes(bytes[8..12].try_into().unwrap());ingest(&frame(true,request,"applied"));Ok(())}).unwrap();
    assert_eq!(result["timestamp"],19.5);
    let error=apply(29,session,"live",&edits,|bytes|{let request=u32::from_le_bytes(bytes[8..12].try_into().unwrap());ingest(&frame(true,request,"invalid_inertia"));Ok(())}).unwrap_err();
    assert!(error.contains("正定") && error.contains("整组"));
}

#[test]
fn expanded_parameters_require_capability_and_report_atomic_rejection() {
    let session="0123456789abcd22";
    let edits=[Edit{key:"_tuning/mass/emptywt".into(),value:12.}];
    let frame=|cap:u32,request:u32,status:&str|json!({"instance_id":"28","model":"live","state":"paused","timestamp":23.5,"monitor":{"tuning":{"version":1,"parameters":cap,"session":session,"request":request,"status":status,"values":[12.]}}});
    ingest(&frame(0,0,""));
    assert!(apply(28,session,"live",&edits,|_|panic!("old firmware must not receive expanded edits")).unwrap_err().contains("更新仿真机固件"));
    ingest(&frame(2,0,""));
    let actual=apply(28,session,"live",&edits,|bytes|{let request=u32::from_le_bytes(bytes[8..12].try_into().unwrap());ingest(&frame(2,request,"applied"));Ok(())}).unwrap();
    assert_eq!(actual["timestamp"],23.5);
    let error=apply(28,session,"live",&edits,|bytes|{let request=u32::from_le_bytes(bytes[8..12].try_into().unwrap());ingest(&frame(2,request,"invalid_parameter"));Ok(())}).unwrap_err();
    assert!(error.contains("整组"));
}

#[test]
fn wind_uses_a_complete_transaction_and_requires_runtime_capability() {
    let session="0123456789abcd27";
    let edits:Vec<_>=(0..14).map(|n|Edit{key:format!("_tuning/wind/field-{n}"),value:n as f64}).collect();
    let bytes=packet(27,19,session,&edits).unwrap();
    assert_eq!(&bytes[..8],b"VWIN\x1b\x0e\0\0");
    assert!(packet(27,19,session,&edits[..13]).is_err());
    let mut mixed=edits.clone();mixed[0].key="atmosphere/wind-east-fps".into();
    assert!(packet(27,19,session,&mixed).is_err());
    let frame=|cap:u32,request:u32|json!({"instance_id":"27","model":"live","state":"paused","timestamp":7.5,
      "monitor":{"tuning":{"version":1,"wind":cap,"session":session,"request":request,"status":"applied","values":edits.iter().map(|e|e.value).collect::<Vec<_>>()}}});
    ingest(&frame(0,0));
    assert!(apply(27,session,"live",&edits,|_|panic!("must not send to old firmware")).unwrap_err().contains("更新仿真机固件"));
    ingest(&frame(1,0));
    let actual=apply(27,session,"live",&edits,|bytes|{
      assert_eq!(&bytes[..4],b"VWIN");
      let request=u32::from_le_bytes(bytes[8..12].try_into().unwrap());ingest(&frame(1,request));Ok(())
    }).unwrap();
    assert_eq!(actual["timestamp"],7.5);
}
