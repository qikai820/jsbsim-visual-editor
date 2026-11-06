#[allow(dead_code)] #[path = "../../src-tauri/src/disabled_xml.rs"] mod disabled_xml;
// Tiny stdin/stdout adapter for browser regressions using production XML code.
#[allow(dead_code)] #[path = "../../src-tauri/src/xml_generator.rs"] mod xml_generator;
#[allow(dead_code)] #[path = "../../src-tauri/src/xml_parser.rs"] mod xml_parser;
#[allow(dead_code)] #[path = "../../src-tauri/src/expression_xml.rs"] mod expression_xml;
#[allow(dead_code)] #[path = "../../src-tauri/src/xml_diagnostics.rs"] mod xml_diagnostics;
#[allow(dead_code)] #[path = "../../src-tauri/src/remote_model.rs"] mod remote_model;
use serde_json::{json, Value};
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let request: Value = serde_json::from_str(&input).unwrap();
    let args = &request["args"];
    let result = match request["command"].as_str().unwrap() {
        "load_model" => {
            let model = args["model"].as_str().unwrap();
            let documents = args["documents"].as_object().unwrap();
            remote_model::load(model, |path| documents.get(path).and_then(Value::as_str)
                .map(str::to_string).ok_or_else(|| "not found".into()))
                .and_then(|(main, refs)| {
                    let mut files = std::collections::HashMap::new();
                    for file in &refs {
                        let name = file.path.rsplit('/').next().unwrap();
                        files.insert(name.trim_end_matches(".xml").to_string(), file.xml.clone());
                        files.insert(name.to_string(), file.xml.clone());
                    }
                    let mut graph = xml_parser::parse_xml(&main, &files)?;
                    remote_model::attach_sources(&mut graph, model, &main, &refs);
                    Ok(graph)
                })
        },
        "generate_xml" => xml_generator::generate_xml(&args["data"]).map(|xml| json!({"xml":xml})),
        "generate_subfile" => {
            let r = &args["req"];
            xml_generator::generate_subfile_xml(r["type"].as_str().unwrap(), r["name"].as_str().unwrap(), &r["params"])
                .map(|xml| json!({"xml":xml}))
        },
        "parse_xml" => {
            let mut files = std::collections::HashMap::new();
            for file in args["files"].as_array().unwrap_or(&vec![]) {
                let name = file["name"].as_str().unwrap();
                let xml = file["xml"].as_str().unwrap().to_string();
                files.insert(name.to_string(), xml.clone());
                let base = name.rsplit('/').next().unwrap();
                files.insert(base.trim_end_matches(".xml").to_string(), xml.clone());
                files.insert(base.to_string(), xml);
            }
            xml_parser::parse_xml(args["xml"].as_str().unwrap(), &files)
        },
        other => Err(format!("Unsupported command: {other}")),
    };
    println!("{}", result.unwrap_or_else(|error| json!({"error":error})));
}
