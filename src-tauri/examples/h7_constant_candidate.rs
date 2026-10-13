#[path = "../src/xml_diagnostics.rs"] mod xml_diagnostics;
#[path = "../src/expression_xml.rs"] mod expression_xml;
#[path = "../src/xml_parser.rs"] mod xml_parser;
#[path = "../src/xml_generator.rs"] mod xml_generator;

use serde_json::json;
use std::{collections::HashMap, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = Path::new("../jsbsim_realtime/data/aviation/aircraft/H7");
    let main = fs::read_to_string(root.join("H7.xml"))?;
    let mut files = HashMap::new();
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("xml") { continue; }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let content = fs::read_to_string(&path)?;
        files.insert(name.clone(), content.clone());
        files.insert(name.trim_end_matches(".xml").to_string(), content);
    }
    let graph = xml_parser::parse_xml(&main, &files)?;
    let node = graph["nodes"].as_array().unwrap().iter().find(|node| {
        node["data"]["params"]["file"].as_str() == Some("H7_Viztra")
    }).ok_or("H7_Viztra system not found")?;
    let mut params = node["data"]["params"].clone();
    let mut channels: serde_json::Value = serde_json::from_str(params["channels"].as_str().ok_or("channels missing")?)?;
    channels[0]["items"].as_array_mut().unwrap().push(json!({
        "type": "constant", "name": "fcs/constant-1",
        "componentProps": { "constant": { "value": "0", "attrs": {} } }
    }));
    params["channels"] = json!(channels.to_string());
    let name = params["name"].as_str().unwrap_or("H7_Viztra");
    print!("{}", xml_generator::generate_subfile_xml("system", name, &params)?);
    Ok(())
}
