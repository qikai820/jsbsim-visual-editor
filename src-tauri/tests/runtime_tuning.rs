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
