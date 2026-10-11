//! Fetch every XML referenced by a remote aircraft before building its graph.
//! A runnable JSBSim model can otherwise appear as a handful of system nodes.

use quick_xml::{events::{BytesStart, Event}, Reader, XmlVersion};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};

pub struct RemoteXml {
    pub path: String,
    pub xml: String,
}

fn push_reference(element: &BytesStart<'_>, output: &mut Vec<String>) -> Result<(), String> {
    for attr in element.attributes() {
        let attr = attr.map_err(|error| error.to_string())?;
        if attr.key.as_ref() != b"file" { continue; }
        let value = attr.normalized_value(XmlVersion::Implicit1_0).map_err(|error| error.to_string())?;
        let file = value.trim();
        // JSBSim also uses file= for non-XML output paths.
        if !file.is_empty() && (!file.contains('.') || file.to_ascii_lowercase().ends_with(".xml")) {
            output.push(file.to_string());
        }
    }
    Ok(())
}

fn references(xml: &str) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_str(xml);
    let mut buffer = Vec::new();
    let mut output = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element) | Event::Empty(element)) => push_reference(&element, &mut output)?,
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buffer.clear();
    }
    Ok(output)
}

fn candidates(model: &str, parent: &str, reference: &str) -> Result<Vec<String>, String> {
    let raw = reference.trim().replace('\\', "/");
    let parts: Vec<&str> = raw.split('/').collect();
    if parts.iter().any(|part| part.is_empty() || *part == "." || *part == ".." ||
        !part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))) {
        return Err(format!("无效的模型引用路径：{reference}"));
    }
    let name = if raw.to_ascii_lowercase().ends_with(".xml") { raw } else { format!("{raw}.xml") };
    let mut paths = Vec::new();
    let mut add = |path: String| { if !paths.contains(&path) { paths.push(path); } };
    if name.starts_with("aircraft/") || name.starts_with("systems/") || name.starts_with("engine/") {
        add(name);
    } else {
        let parent_dir = parent.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
        if !parent_dir.is_empty() { add(format!("{parent_dir}/{name}")); }
        add(format!("aircraft/{model}/{name}"));
        add(format!("systems/{name}"));
        add(format!("engine/{name}"));
    }
    Ok(paths)
}

pub fn load<F>(model: &str, mut download: F) -> Result<(String, Vec<RemoteXml>), String>
where F: FnMut(&str) -> Result<String, String> {
    if model.is_empty() || model == "." || model == ".." ||
        !model.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')) {
        return Err("无效的模型目录名".into());
    }
    let main_path = format!("aircraft/{model}/{model}.xml");
    let main = download(&main_path).map_err(|error| format!("无法读取 {main_path}: {error}"))?;
    let mut queue = VecDeque::from([(main_path.clone(), main.clone())]);
    let mut seen = HashSet::from([main_path]);
    let mut files = Vec::new();
    while let Some((parent, xml)) = queue.pop_front() {
        crate::xml_diagnostics::validate(&xml, &parent)?;
        for reference in references(&xml).map_err(|error| format!("{parent} XML 解析失败: {error}"))? {
            let paths = candidates(model, &parent, &reference)?;
            if paths.iter().any(|path| seen.contains(path)) { continue; }
            let mut failures = Vec::new();
            let mut found = None;
            for path in &paths {
                match download(path) {
                    Ok(content) => { found = Some((path.clone(), content)); break; }
                    Err(error) => failures.push(format!("{path}: {error}")),
                }
            }
            let Some((path, content)) = found else {
                return Err(format!("模型 {model} 加载不完整：{parent} 引用 {reference}，但未能读取。{}", failures.join("；")));
            };
            if files.len() >= 128 { return Err(format!("模型 {model} 引用的 XML 文件超过 128 个")); }
            seen.insert(path.clone());
            queue.push_back((path.clone(), content.clone()));
            files.push(RemoteXml { path, xml: content });
        }
    }
    Ok((main, files))
}

pub fn attach_sources(result: &mut Value, model: &str, main: &str, refs: &[RemoteXml]) {
    result["model"] = json!(model);
    result["sourceXml"] = json!(main);
    result["referenceFiles"] = json!(refs.iter().map(|file| json!({ "name": file.path, "xml": file.xml })).collect::<Vec<_>>());
    let main_path = format!("aircraft/{model}/{model}.xml");
    let mut xml_files = vec![json!({
        "id": format!("main:{main_path}"), "path": main_path, "category": "main",
        "originalXml": main, "currentXml": main, "dirty": false,
    })];
    for file in refs {
        let category = if file.path.starts_with("engine/") { "engine" } else { "system" };
        xml_files.push(json!({
            "id": format!("{category}:{}", file.path), "path": file.path,
            "category": category, "originalXml": file.xml, "currentXml": file.xml, "dirty": false,
        }));
    }
    result["xmlFiles"] = json!(xml_files);

    // The parser knows the basename in file="..."; the remote fetch knows
    // its actual directory. Keep edits pointed at the fetched source file.
    if let Some(nodes) = result["nodes"].as_array_mut() {
        for node in nodes {
            let Some(params) = node["data"]["params"].as_object_mut() else { continue };
            let Some(source) = params.get("_source_file").and_then(Value::as_str) else { continue };
            let source = source.trim_end_matches(".xml");
            let Some(file) = refs.iter().find(|file| file.path.rsplit('/').next()
                .is_some_and(|name| name.trim_end_matches(".xml") == source)) else { continue };
            let category = if file.path.starts_with("engine/") { "engine" } else { "system" };
            params.insert("referencePath".into(), json!(file.path));
            params.insert("source".into(), json!({
                "fileId": format!("{category}:{}", file.path), "path": file.path, "category": category,
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_f450_sections_and_nested_engine_files() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sdcard/jsbsim");
        let (main, refs) = load("F450", |path| {
            std::fs::read_to_string(root.join(path)).map_err(|error| error.to_string())
        }).unwrap();
        assert!(main.contains("<metrics file=\"Metrics.xml\""));
        for expected in ["Metrics.xml", "Mass.xml", "Gear.xml", "Propulsion.xml", "Aero.xml", "Effectors.xml", "FlightControl.xml"] {
            assert!(refs.iter().any(|file| file.path.ends_with(expected)), "missing {expected}");
        }
        assert!(refs.iter().any(|file| file.path == "engine/DJI_E305.xml"));
        assert!(refs.iter().any(|file| file.path == "engine/DJI_9450.xml"));
    }

    #[test]
    fn reports_missing_reference_instead_of_partial_graph() {
        let error = load("F450", |path| match path {
            "aircraft/F450/F450.xml" => Ok("<fdm_config><metrics file=\"Metrics.xml\"/></fdm_config>".into()),
            _ => Err("not found".into()),
        }).err().unwrap();
        assert!(error.contains("Metrics.xml"));
    }

    #[test]
    fn attached_sources_keep_actual_aircraft_file_paths() {
        let mut graph = json!({ "nodes": [{ "data": { "params": { "_source_file": "Effectors.xml" } } }] });
        let refs = [RemoteXml { path: "aircraft/F450/Effectors.xml".into(), xml: "<system/>".into() }];
        attach_sources(&mut graph, "F450", "<fdm_config/>", &refs);
        assert_eq!(graph["nodes"][0]["data"]["params"]["referencePath"], "aircraft/F450/Effectors.xml");
        assert!(graph["xmlFiles"].as_array().unwrap().iter().any(|file| file["path"] == "aircraft/F450/Effectors.xml"));
    }
}
