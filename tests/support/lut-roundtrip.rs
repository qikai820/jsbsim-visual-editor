// Executable regression using the production Rust serializers and both parsers.
#[allow(dead_code)] #[path = "../../src-tauri/src/xml_generator.rs"] mod xml_generator;
#[allow(dead_code)] #[path = "../../src-tauri/src/xml_parser.rs"] mod xml_parser;
#[allow(dead_code)] #[path = "../../src-tauri/src/expression_xml.rs"] mod expression_xml;
#[allow(dead_code)] #[path = "../../src-tauri/src/xml_diagnostics.rs"] mod xml_diagnostics;
#[allow(dead_code)] #[path = "../../src-tauri/src/dataflow.rs"] mod dataflow;
use serde_json::{json, Value};
fn flow_shape(mut value: Value) -> Value {
    value["kind"] = json!("Table");
    let dimension = value.as_object_mut().unwrap().remove("tableType").unwrap();
    value["table_type"] = dimension;
    value
}
fn main() {
    let table = json!({"kind":"table","tableType":"3D","var1":"aero/alpha-rad","var2":"fcs/elevator-pos-rad","var3":"velocities/mach",
        "breakpoints1":[-0.2,0.4],"breakpoints2":[-1.0,1.0],"breakpoints3":[0.0,0.8],
        "data":[[0.123456789012345,-1.0],[2.0,3.0],[4.0,5.0],[6.0,7.0]]});
    let parsed: expression_xml::ExprNode = serde_json::from_value(table.clone()).unwrap();
    let typed_xml = expression_xml::expr_to_xml(&parsed, 0);
    assert!(typed_xml.contains("lookup=\"table\">velocities/mach"));
    for alias in ["table", "axis3", "z"] {
        let xml = typed_xml.replace("lookup=\"table\"", &format!("lookup=\"{alias}\""));
        let root = expression_xml::parse_xml_tree(&xml).unwrap();
        let restored = serde_json::to_value(expression_xml::parse_table(&root)).unwrap();
        assert_eq!(restored, table, "typed parser preserves every coordinate for {alias}");
    }
    let channels = json!([{"name":"test","items":[{"type":"function","name":"fcs/lut","expression":table}]}]);
    let generated = xml_generator::generate_subfile_xml("system","LUT", &json!({"channels":channels.to_string()})).unwrap();
    assert!(generated.contains("lookup=\"table\">velocities/mach"));
    let restored = expression_xml::parse_subfile_xml(&generated,"system").unwrap();
    let reloaded: Value = serde_json::from_str(restored["params"]["channels"].as_str().unwrap()).unwrap();
    assert_eq!(reloaded[0]["items"][0]["expression"], table, "JSON generator and subfile parser round-trip");
    let signal_graph = dataflow::parse_dataflow_json(&format!("<aerodynamics><function name=\"aero/test\">{typed_xml}</function></aerodynamics>"), &std::collections::HashMap::new()).unwrap();
    assert_eq!(signal_graph["nodes"][0]["expression"], flow_shape(table.clone()), "dataflow parser preserves all three axes");
    for (header, cols) in [("-1 1", json!([-1.0, 1.0])), ("0 -1 1", json!([-1.0, 1.0])), ("1", json!([1.0]))] {
        let values = if cols.as_array().unwrap().len() == 1 { "-0.2 2\n0.4 4" } else { "-0.2 2 3\n0.4 4 5" };
        let xml = format!("<table><independentVar lookup=\"row\">a</independentVar><independentVar lookup=\"column\">b</independentVar><tableData>{header}\n{values}</tableData></table>");
        let parsed = expression_xml::parse_table(&expression_xml::parse_xml_tree(&xml).unwrap());
        let parsed = serde_json::to_value(parsed).unwrap();
        assert_eq!(parsed["breakpoints2"], cols, "blank or numeric corner and one-column tables");
        let graph = dataflow::parse_dataflow_json(&format!("<aerodynamics><function name=\"test\">{xml}</function></aerodynamics>"), &std::collections::HashMap::new()).unwrap();
        assert_eq!(graph["nodes"][0]["expression"], flow_shape(parsed), "both production parsers agree");
    }
    println!("PASS: 3D table numeric precision, third independent variable, canonical table lookup, legacy aliases and both Rust parse/generation paths.");
}
