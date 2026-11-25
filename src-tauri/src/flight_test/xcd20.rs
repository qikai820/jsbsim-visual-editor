//! XCD20 test-only preconditions and local simulator observations. Never sends
//! vessel/rail truth to the flight controller or changes a flight parameter.
use super::{engine::Engine,mavlink::Telemetry};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration,Instant};

pub const PARAMETERS:&[&str]=&["SYS_HITL","MPC_TKO_SLIDE","MPC_TKO_RSRC","CA_ROTOR_COUNT","HIL_ACT_FUNC1","HIL_ACT_FUNC2","HIL_ACT_FUNC3","HIL_ACT_FUNC4","HIL_ACT_FUNC5","HIL_ACT_FUNC6","HIL_ACT_FUNC7","HIL_ACT_FUNC8"];
pub fn is_parameter(name:&str)->bool{PARAMETERS.contains(&name)}
pub fn selected(e:&Engine)->Option<bool>{e.value("test/requirements/xcd20-takeoff").map(|v|v==1.)}
pub fn parameters(e:&Engine)->Vec<&'static str>{if selected(e).is_some(){PARAMETERS.to_vec()}else{vec![]}}
pub fn scene(instance:u8)->Result<Value,String>{
    crate::scene_telemetry::snapshots().into_iter().find(|v|v["instance_id"].as_str().and_then(|s|s.parse::<u8>().ok()).or_else(||v["instance_id"].as_u64().map(|n|n as u8))==Some(instance)).ok_or("缺少 XCD20 实例快照".into())
}
fn property(frame:&Value,path:&str)->Result<f64,String>{
    if frame["age_ms"].as_u64().unwrap_or(u64::MAX)>1500||frame["state"].as_str()!=Some("running")||frame["model"].as_str()!=Some("XCD20_FlightIdentified"){return Err("XCD20 模型不匹配、未运行或遥测过期".into());}
    if frame["scene_property_age_ms"][path].as_u64().unwrap_or(u64::MAX)>3000{return Err(format!("模型属性缺失或过期：{path}"));}
    frame["properties"][path].as_f64().filter(|v|v.is_finite()).ok_or_else(||format!("模型属性无效：{path}"))
}
pub fn validate(rail:bool,t:&Telemetry,frame:&Value)->Result<(),String>{
    if t.armed||!t.hil||t.uid.is_none_or(|uid|uid==0){return Err("XCD20 测试需要已上锁的 HIL 飞控及有效硬件身份".into());}
    let expect=|name:&str,value:f64|->Result<(),String>{
        let (actual,_,at)=t.params.get(name).ok_or_else(||format!("缺少参数回读 {name}"))?;
        if at.elapsed()>Duration::from_secs(5)||*actual!=value{return Err(format!("XCD20 测试要求 {name}={value}，请在上锁时配置并重新回读"));}Ok(())
    };
    expect("SYS_HITL",1.)?;expect("MPC_TKO_SLIDE",rail as u8 as f64)?;expect("CA_ROTOR_COUNT",8.)?;
    for (i,name) in PARAMETERS[4..].iter().enumerate(){expect(name,101.+i as f64)?;}
    let enabled=property(frame,"/moving-platform/enabled")?;
    if rail {
        expect("MPC_TKO_RSRC",1.)?;
        if enabled!=1.||![1.,2.].contains(&property(frame,"/moving-platform/contact-mode")?){return Err("双杆脚本需要启用双杆/组合接触模型".into());}
        for key in ["contact-mask","valid-mask"]{if property(frame,&format!("/moving-platform/rail/{key}"))?!=3.{return Err("双杆起飞前两杆必须接触且有效".into());}}
        for i in 0..2{let suffix=if i==0{String::new()}else{format!("[{i}]")};if property(frame,&format!("/moving-platform/rail/travel-m{suffix}"))?.abs()>0.1{return Err("双杆初始套筒不在就位位置".into());}}
    }else if enabled!=0.&&(enabled!=1.||property(frame,"/moving-platform/contact-mode")?!=0.){return Err("普通脚本需要关闭移动平台，或选择无双杆的甲板接触".into());}
    Ok(())
}
pub fn preflight(e:&Engine,t:&Telemetry,instance:u8)->Result<(),String>{if let Some(rail)=selected(e){validate(rail,t,&scene(instance)?)?;}Ok(())}
pub fn values(e:&Engine,instance:u8)->Result<BTreeMap<String,f64>,String>{
    let mut result=BTreeMap::new();
    if selected(e)!=Some(true){return Ok(result);}
    let f=scene(instance)?;
    for name in ["contact-mask","valid-mask","released-mask"]{result.insert(format!("test/sim/rail-{name}"),property(&f,&format!("/moving-platform/rail/{name}"))?);}
    Ok(result)
}
pub fn derived(e:&mut Engine){
    if selected(e).is_none(){return;}
    for (source,dest) in [("yaw-rate-rad-s","yaw-rate-abs-rad-s")]{
        e.properties.remove(&format!("test/fc/{dest}"));
        if let Some(v)=e.value(&format!("test/fc/{source}")){e.set(&format!("test/fc/{dest}"),v.abs());}
    }
    e.properties.remove("test/fc/height-above-launch-m");
    if let (Some(h),Some(reference))=(e.value("test/fc/altitude-msl-m"),e.value("test/flow/xcd20_launch/choice")){e.set("test/fc/height-above-launch-m",h-reference);}
}

#[cfg(test)]mod tests{
    use super::*;use serde_json::json;
    fn fixture(rail:bool)->(Telemetry,Value){
        let mut t=Telemetry::default();t.hil=true;t.uid=Some(123);
        for name in PARAMETERS{t.params.insert((*name).into(),(if *name=="SYS_HITL"||*name=="MPC_TKO_RSRC"{1.}else if *name=="CA_ROTOR_COUNT"{8.}else if *name=="MPC_TKO_SLIDE"{rail as u8 as f64}else{100.+name.trim_start_matches("HIL_ACT_FUNC").parse::<f64>().unwrap()},0,Instant::now()));}
        let mut f=json!({"model":"XCD20_FlightIdentified","state":"running","age_ms":0,"properties":{},"scene_property_age_ms":{}});
        for (k,v) in [("/moving-platform/enabled",rail as u8 as f64),("/moving-platform/contact-mode",rail as u8 as f64),("/moving-platform/rail/contact-mask",3.),("/moving-platform/rail/valid-mask",3.),("/moving-platform/rail/travel-m",0.),("/moving-platform/rail/travel-m[1]",0.)]{f["properties"][k]=json!(v);f["scene_property_age_ms"][k]=json!(0);}
        (t,f)
    }
    #[test]fn requirements_reject_wrong_mode_outputs_identity_and_stale_truth(){
        for rail in [false,true]{let(t,f)=fixture(rail);validate(rail,&t,&f).unwrap();let mut bad=t.clone();bad.params.get_mut("SYS_HITL").unwrap().0=3.;assert!(validate(rail,&bad,&f).is_err());bad=t.clone();bad.params.get_mut("MPC_TKO_SLIDE").unwrap().0=if rail{0.}else{1.};assert!(validate(rail,&bad,&f).is_err());bad=t.clone();bad.params.get_mut("HIL_ACT_FUNC8").unwrap().0=104.;assert!(validate(rail,&bad,&f).is_err());bad=t.clone();bad.uid=None;assert!(validate(rail,&bad,&f).is_err());bad=t.clone();bad.armed=true;assert!(validate(rail,&bad,&f).is_err());let mut wrong=f.clone();wrong["model"]=json!("F450");assert!(validate(rail,&t,&wrong).is_err());if rail{let mut stale=f.clone();stale["scene_property_age_ms"]["/moving-platform/rail/contact-mask"]=json!(4000);assert!(validate(rail,&t,&stale).is_err());}}
    }
}
