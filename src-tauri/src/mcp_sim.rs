//! Strict, primary-instance model-control arguments. No flight commands.
use serde_json::Value;
pub struct Start {pub model:String,pub script:Option<String>,pub initial:Option<[f64;6]>}
pub fn start(args:&Value)->Result<Start,String>{
    let object=args.as_object().ok_or("arguments must be an object")?;
    let keys=["model","script","latitudeDeg","longitudeDeg","terrainAltitudeM","rollDeg","pitchDeg","yawDeg"];
    if object.keys().any(|k|!keys.contains(&k.as_str())){return Err("Unknown model control argument".into());}
    let model=args["model"].as_str().filter(|s|!s.is_empty() && s.len()<64 && s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')).ok_or("Invalid model basename")?.to_owned();
    let script=object.get("script").map(|v|v.as_str().filter(|s|!s.is_empty()&&s.len()<64&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-'||b==b'.')&&!s.contains("..")).map(str::to_owned).ok_or("Invalid script basename")).transpose()?;
    let initial=if keys[2..].iter().any(|k|object.contains_key(*k)) {
        if script.is_some(){return Err("Use either script initial conditions or an explicit terrain pose".into());}
        let number=|key:&str,default:Option<f64>|object.get(key).map(|v|v.as_f64().filter(|v|v.is_finite()).ok_or("Invalid finite initial value")).unwrap_or_else(||default.ok_or("Missing geographic initial value"));
        let values=[number("latitudeDeg",None)?,number("longitudeDeg",None)?,number("terrainAltitudeM",None)?,number("rollDeg",Some(0.))?,number("pitchDeg",Some(0.))?,number("yawDeg",Some(0.))?];
        if values[0].abs()>90.||values[1].abs()>180.||!(-1000.0..=100000.0).contains(&values[2])||values[3..].iter().any(|v|v.abs()>360.){return Err("Initial pose out of range".into());}
        Some(values)
    } else {None};
    Ok(Start{model,script,initial})
}
#[cfg(test)]mod tests{use super::*;use serde_json::json;
#[test]fn rejects_invalid_and_ambiguous(){assert!(start(&json!({"model":"../x"})).is_err());assert!(start(&json!({"model":"x","latitudeDeg":0})).is_err());assert!(start(&json!({"model":"x","script":"x.xml","latitudeDeg":0,"longitudeDeg":0,"terrainAltitudeM":0})).is_err());assert!(start(&json!({"model":"x","latitudeDeg":91,"longitudeDeg":0,"terrainAltitudeM":0})).is_err());assert!(start(&json!({"model":"x","extra":1})).is_err());}
#[test]fn valid_model_script_and_pose(){assert_eq!(start(&json!({"model":"x","script":"x.xml"})).unwrap().script.as_deref(),Some("x.xml"));assert_eq!(start(&json!({"model":"x","latitudeDeg":34,"longitudeDeg":109,"terrainAltitudeM":582})).unwrap().initial.unwrap(),[34.,109.,582.,0.,0.,0.]);}
}
