#[allow(dead_code)]
#[path = "../src/xml_generator.rs"]
mod xml_generator;

use serde_json::json;

#[test]
fn canvas_constant_generates_a_real_fcs_source() {
    let channels = json!([{ "name": "H7 channel", "items": [
        { "type": "constant", "name": "fcs/constant-1", "componentProps": { "constant": { "value": "2.5" } } },
        { "type": "constant", "name": "", "componentProps": {} }
    ] }]);
    let params = json!({ "channels": channels.to_string() });
    let xml = xml_generator::generate_subfile_xml("system", "H7_Viztra", &params).unwrap();
    assert!(xml.contains("<fcs_function name=\"fcs/constant-1\">"));
    assert!(xml.contains("<value>2.5</value>"));
    assert!(xml.contains("<fcs_function name=\"fcs/canvas-constant-1-2\">"));
    assert!(xml.contains("<value>0</value>"));
    assert!(!xml.contains("<constant"));
}
