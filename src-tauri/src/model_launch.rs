//! Select a model's plain ground-initialization script for a normal launch.
//! Loading only the aircraft XML skips <use initialize="initGrnd"> entirely.

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GroundScript {
    #[serde(rename = "@name")]
    _name: Option<String>,
    #[serde(rename = "use")]
    initial: GroundInitial,
    run: GroundRun,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GroundInitial {
    #[serde(rename = "@aircraft")]
    aircraft: String,
    #[serde(rename = "@initialize")]
    initialize: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GroundRun {
    #[serde(rename = "@start")]
    start: Option<f64>,
    #[serde(rename = "@end")]
    end: Option<f64>,
    #[serde(rename = "@dt")]
    dt: Option<f64>,
}

fn is_plain_ground_script(model: &str, xml: &str) -> bool {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Decl(_) | Event::Comment(_) | Event::PI(_)) => continue,
            Ok(Event::Text(text)) if text.iter().all(u8::is_ascii_whitespace) => continue,
            Ok(Event::Start(root)) if root.name().as_ref() == b"runscript" => break,
            _ => return false,
        }
    }
    // Only the minimal initial-condition/time-step companion is automatic.
    // Events, control commands and scenarios require explicit script selection.
    let Ok(script) = quick_xml::de::from_str::<GroundScript>(xml) else { return false; };
    script.initial.aircraft == model &&
        matches!(script.initial.initialize.as_str(), "initGrnd" | "initGrnd.xml") &&
        script.run.start.unwrap_or(0.0) == 0.0 &&
        script.run.end.is_none_or(|end| end.is_finite() && end > 0.0) &&
        script.run.dt.is_none_or(|dt| dt.is_finite() && dt > 0.0 && dt <= 1.0)
}

pub fn resolve<F>(explicit: Option<&str>, model: Option<&str>, mut download: F)
    -> Result<Option<String>, String>
where F: FnMut(&str) -> Result<String, String> {
    if let Some(script) = explicit { return Ok(Some(script.to_owned())); }
    let Some(model) = model else { return Ok(None); };
    let model = model.rsplit('/').next().unwrap_or(model).trim_end_matches(".xml");
    if model.is_empty() || model == "." || model == ".." || model.len() >= 64 ||
        !model.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')) {
        return Err("Invalid model launch target".into());
    }
    let script = format!("{model}.xml");
    let path = format!("scripts/{script}");
    let Ok(xml) = download(&path) else { return Ok(None); };
    crate::xml_diagnostics::validate(&xml, &path)?;
    Ok(is_plain_ground_script(model, &xml).then_some(script))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GROUND: &str = r#"<?xml version="1.0"?>
        <runscript name="USB HIL"><use aircraft="f450_usb" initialize="initGrnd"/>
        <run start="0.0" end="3600.0" dt="0.004"/></runscript>"#;

    #[test]
    fn normal_model_start_keeps_its_ground_initialization() {
        let result = resolve(None, Some("f450_usb"), |path| {
            assert_eq!(path, "scripts/f450_usb.xml");
            Ok(GROUND.into())
        }).unwrap();
        assert_eq!(result.as_deref(), Some("f450_usb.xml"));
    }

    #[test]
    fn explicit_script_is_authoritative_without_an_extra_download() {
        assert_eq!(resolve(Some("chosen.xml"), Some("f450_usb"), |_| {
            panic!("explicit script must not trigger discovery")
        }).unwrap().as_deref(), Some("chosen.xml"));
    }

    #[test]
    fn ordinary_models_and_scenario_scripts_keep_their_launch_behavior() {
        assert!(resolve(None, Some("no_script"), |_| Err("not found".into())).unwrap().is_none());
        for xml in [
            GROUND.replace("f450_usb", "other"),
            GROUND.replace("initGrnd", "airborne"),
            GROUND.replace("<run start=", "<run unexpected=\"true\" start="),
            GROUND.replace("<run start=\"0.0\"", "<run start=\"10.0\""),
            GROUND.replace("</runscript>", "<event name=\"takeoff\"/></runscript>"),
            GROUND.replace("/></runscript>", "><event name=\"takeoff\"/></run></runscript>"),
            GROUND.replace("runscript", "unrelated"),
        ] {
            assert!(resolve(None, Some("f450_usb"), |_| Ok(xml.clone())).unwrap().is_none(), "{xml}");
        }
    }

    #[test]
    fn malformed_companion_reports_the_source_path() {
        let error = resolve(None, Some("f450_usb"), |_| Ok(GROUND.replace("</runscript>", "</broken>"))).unwrap_err();
        assert!(error.contains("scripts/f450_usb.xml"), "{error}");
    }

    #[test]
    fn legacy_dotted_model_names_still_allow_direct_loading() {
        assert!(resolve(None, Some("aircraft/custom.v1.xml"), |path| {
            assert_eq!(path, "scripts/custom.v1.xml");
            Err("no companion".into())
        }).unwrap().is_none());
        assert!(resolve(None, Some(".."), |_| panic!("invalid model must not be downloaded")).is_err());
    }
}
