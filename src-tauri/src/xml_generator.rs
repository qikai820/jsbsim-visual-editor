//! JSBSim XML generator — converts JSON graph data to JSBSim XML strings.
//!
//! Port of server/xmlGenerator.js and the exprToXml portion of
//! server/expressionXml.js.

use serde_json::Value;

// ── XML helper functions ────────────────────────────────────────────────────

fn indent(level: usize) -> String {
    "    ".repeat(level)
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Build an XML element string at the given indentation level.
///
/// - `attrs`: ordered list of (key, value) attribute pairs
/// - `content`: `None` → self-closing tag; `Some(text)` without newlines →
///   inline element; `Some(block)` with newlines → block element with the
///   closing tag on its own line.
fn xml_element(name: &str, attrs: &[(&str, &str)], content: Option<&str>, level: usize) -> String {
    let ind = indent(level);
    let mut attr_str = String::new();
    for (k, v) in attrs {
        attr_str.push_str(&format!(" {}=\"{}\"", k, escape_xml(v)));
    }
    match content {
        None | Some("") => format!("{}<{}{}/>", ind, name, attr_str),
        Some(text) if !text.contains('\n') => {
            format!("{}<{}{}>{}</{}>", ind, name, attr_str, escape_xml(text), name)
        }
        Some(text) => {
            let content_str = if text.ends_with('\n') {
                text.to_string()
            } else {
                format!("{}\n", text)
            };
            format!("{}<{}{}>\n{}{}</{}>", ind, name, attr_str, content_str, ind, name)
        }
    }
}

fn xml_simple(name: &str, value: &str, unit: Option<&str>, level: usize) -> String {
    if value.is_empty() {
        return String::new();
    }
    let attrs: Vec<(&str, &str)> = match unit {
        Some(u) if !u.is_empty() => vec![("unit", u)],
        _ => vec![],
    };
    xml_element(name, &attrs, Some(value), level)
}

fn xml_location(
    x: Option<f64>,
    y: Option<f64>,
    z: Option<f64>,
    unit: Option<&str>,
    tag: &str,
    level: usize,
) -> String {
    let ind = indent(level);
    let unit_attr = match unit {
        Some(u) if !u.is_empty() => format!(" unit=\"{}\"", u),
        _ => String::new(),
    };
    let xv = x.unwrap_or(0.0);
    let yv = y.unwrap_or(0.0);
    let zv = z.unwrap_or(0.0);
    let i1 = indent(level + 1);
    format!(
        "{}<{}{}>\n{}<x>{}</x>\n{}<y>{}</y>\n{}<z>{}</z>\n{}</{}>",
        ind, tag, unit_attr, i1, fmt_num(xv), i1, fmt_num(yv), i1, fmt_num(zv), ind, tag
    )
}

/// Format a number: drop trailing zeros for floats, keep integers clean.
fn fmt_num(v: f64) -> String {
    if v == v.floor() && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

/// Convert a serde_json::Value to a display string.
fn val_to_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}

// ── Helpers for accessing node params ───────────────────────────────────────

fn get_params(node: &Value) -> &Value {
    node.get("data")
        .and_then(|d| d.get("params"))
        .unwrap_or(&Value::Null)
}

fn get_val(p: &Value) -> Option<String> {
    match p {
        Value::Null | Value::Object(_) if p.is_null() => None,
        Value::Object(_) => {
            if let Some(v) = p.get("value") {
                if v.is_null() {
                    None
                } else {
                    Some(val_to_str(v))
                }
            } else {
                None
            }
        }
        _ => {
            let s = val_to_str(p);
            if s.is_empty() { None } else { Some(s) }
        }
    }
}

fn get_unit(p: &Value) -> Option<String> {
    p.as_object()
        .and_then(|o| o.get("unit"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
}

fn get_val_or(p: &Value, default: &str) -> String {
    get_val(p).unwrap_or_else(|| default.to_string())
}

fn get_unit_or(p: &Value, default: &str) -> String {
    get_unit(p).unwrap_or_else(|| default.to_string())
}

// ── Expression tree → XML ───────────────────────────────────────────────────

fn expr_to_xml(expr: &Value, level: usize) -> String {
    if expr.is_null() || !expr.is_object() || expr.get("kind").is_none() {
        return format!("{}<value>0</value>", indent(level));
    }

    let kind = expr["kind"].as_str().unwrap_or("");
    let ind = indent(level);

    match kind {
        "value" => {
            let v = expr.get("value").map(|v| val_to_str(v)).unwrap_or_else(|| "0".into());
            format!("{}<value>{}</value>", ind, v)
        }
        "property" | "function_ref" => {
            let name = expr.get("name").map(|v| val_to_str(v)).unwrap_or_default();
            format!("{}<property>{}</property>", ind, escape_xml(&name))
        }
        "table" => table_to_xml(expr, level),
        "product" | "sum" | "min" | "max" | "avg" | "and" | "or" | "roundmultiple" => {
            let children = expr.get("children").and_then(|c| c.as_array());
            multi_arg_to_xml(kind, children, level)
        }
        "difference" | "quotient" | "mod" => {
            let null_val = Value::Null;
            let left = expr.get("left").unwrap_or(&null_val);
            let right = expr.get("right").unwrap_or(&null_val);
            two_arg_to_xml(kind, left, right, level)
        }
        "pow" => {
            let null_val = Value::Null;
            let base = expr.get("base").unwrap_or(&null_val);
            let exp = expr.get("exponent").unwrap_or(&null_val);
            two_arg_to_xml("pow", base, exp, level)
        }
        "atan2" => {
            let null_val = Value::Null;
            let y = expr.get("y").unwrap_or(&null_val);
            let x = expr.get("x").unwrap_or(&null_val);
            two_arg_to_xml("atan2", y, x, level)
        }
        "gt" | "lt" | "ge" | "le" | "eq" | "nq" => {
            let null_val = Value::Null;
            let left = expr.get("left").unwrap_or(&null_val);
            let right = expr.get("right").unwrap_or(&null_val);
            two_arg_to_xml(kind, left, right, level)
        }
        "abs" | "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "sqrt" | "exp"
        | "fraction" | "integer" | "toradians" | "todegrees" | "not" => {
            let null_val = Value::Null;
            let child = expr.get("child").unwrap_or(&null_val);
            unary_to_xml(kind, child, level)
        }
        "pi" => format!("{}<pi/>", ind),
        "random" => format!("{}<random/>", ind),
        "urandom" => format!("{}<urandom/>", ind),
        "ifthen" => {
            let null_val = Value::Null;
            let cond = expr.get("cond").unwrap_or(&null_val);
            let then = expr.get("then").unwrap_or(&null_val);
            let else_ = expr.get("else").unwrap_or(&null_val);
            format!(
                "{}<ifthen>\n{}\n{}\n{}\n{}</ifthen>",
                ind,
                expr_to_xml(cond, level + 1),
                expr_to_xml(then, level + 1),
                expr_to_xml(else_, level + 1),
                ind
            )
        }
        "switch" => {
            let mut parts = vec![];
            if let Some(idx) = expr.get("index") {
                parts.push(expr_to_xml(idx, level + 1));
            }
            if let Some(cases) = expr.get("cases").and_then(|c| c.as_array()) {
                for c in cases {
                    parts.push(expr_to_xml(c, level + 1));
                }
            }
            if let Some(def) = expr.get("default") {
                parts.push(expr_to_xml(def, level + 1));
            }
            format!("{}<switch>\n{}\n{}</switch>", ind, parts.join("\n"), ind)
        }
        _ => format!("{}<value>0</value>", ind),
    }
}

fn multi_arg_to_xml(tag: &str, children: Option<&Vec<Value>>, level: usize) -> String {
    let ind = indent(level);
    match children {
        None => format!("{}<{}{}/>", ind, tag, ""),
        Some(kids) if kids.is_empty() => format!("{}<{}{}/>", ind, tag, ""),
        Some(kids) => {
            let child_xml: Vec<String> = kids.iter().map(|c| expr_to_xml(c, level + 1)).collect();
            format!("{}<{}>\n{}\n{}</{}>", ind, tag, child_xml.join("\n"), ind, tag)
        }
    }
}

fn two_arg_to_xml(tag: &str, left: &Value, right: &Value, level: usize) -> String {
    let ind = indent(level);
    let left_xml = expr_to_xml(left, level + 1);
    let right_xml = expr_to_xml(right, level + 1);
    format!("{}<{}>\n{}\n{}\n{}</{}>", ind, tag, left_xml, right_xml, ind, tag)
}

fn unary_to_xml(tag: &str, child: &Value, level: usize) -> String {
    let ind = indent(level);
    let child_xml = expr_to_xml(child, level + 1);
    format!("{}<{}>\n{}\n{}</{}>", ind, tag, child_xml, ind, tag)
}

fn table_to_xml(expr: &Value, level: usize) -> String {
    let ind = indent(level);
    let table_type = expr.get("tableType").and_then(|v| v.as_str()).unwrap_or("1D");
    let var1 = expr.get("var1").and_then(|v| v.as_str()).unwrap_or("aero/alpha-rad");
    let var2 = expr.get("var2").and_then(|v| v.as_str()).unwrap_or("");

    match table_type {
        "2D" => {
            let var2_disp = if var2.is_empty() { "fcs/elevator-pos-rad" } else { var2 };
            let mut lines = vec![];
            lines.push(format!("{}<table>", ind));
            lines.push(format!(
                "{}<independentVar lookup=\"row\">{}</independentVar>",
                indent(level + 1),
                escape_xml(var1)
            ));
            lines.push(format!(
                "{}<independentVar lookup=\"column\">{}</independentVar>",
                indent(level + 1),
                escape_xml(var2_disp)
            ));
            lines.push(table_data_2d_to_xml(expr, level + 1));
            lines.push(format!("{}</table>", ind));
            lines.join("\n")
        }
        "3D" => {
            let var2_disp = if var2.is_empty() { "fcs/elevator-pos-rad" } else { var2 };
            let mut lines = vec![];
            lines.push(format!("{}<table>", ind));
            lines.push(format!(
                "{}<independentVar lookup=\"row\">{}</independentVar>",
                indent(level + 1),
                escape_xml(var1)
            ));
            lines.push(format!(
                "{}<independentVar lookup=\"column\">{}</independentVar>",
                indent(level + 1),
                escape_xml(var2_disp)
            ));
            lines.push(table_data_3d_to_xml(expr, level + 1));
            lines.push(format!("{}</table>", ind));
            lines.join("\n")
        }
        _ => {
            // 1D
            let mut lines = vec![];
            lines.push(format!("{}<table>", ind));
            lines.push(format!(
                "{}<independentVar>{}</independentVar>",
                indent(level + 1),
                escape_xml(var1)
            ));
            lines.push(table_data_1d_to_xml(expr, level + 1));
            lines.push(format!("{}</table>", ind));
            lines.join("\n")
        }
    }
}

fn table_data_1d_to_xml(expr: &Value, level: usize) -> String {
    let ind = indent(level);
    let bp = expr
        .get("breakpoints1")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let data = expr
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut lines = vec![format!("{}<tableData>", ind)];
    for i in 0..data.len() {
        let b = if i < bp.len() {
            val_to_str(&bp[i])
        } else {
            "0".into()
        };
        let v = if let Some(row) = data[i].as_array() {
            if !row.is_empty() {
                val_to_str(&row[0])
            } else {
                "0".into()
            }
        } else {
            val_to_str(&data[i])
        };
        lines.push(format!("{}    {}\t{}", ind, b, v));
    }
    lines.push(format!("{}</tableData>", ind));
    lines.join("\n")
}

fn table_data_2d_to_xml(expr: &Value, level: usize) -> String {
    let ind = indent(level);
    let bp1 = expr
        .get("breakpoints1")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let bp2 = expr
        .get("breakpoints2")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let data = expr
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut lines = vec![format!("{}<tableData>", ind)];

    // Header row
    let mut header = vec![String::new()];
    for b in &bp2 {
        header.push(val_to_str(b));
    }
    lines.push(format!("{}    {}", ind, header.join("\t")));

    // Data rows
    for r in 0..data.len() {
        let mut row = vec![if r < bp1.len() {
            val_to_str(&bp1[r])
        } else {
            "0".into()
        }];
        let row_data = data[r].as_array();
        for c in 0..bp2.len() {
            let v = row_data
                .and_then(|rd| rd.get(c))
                .map(|v| val_to_str(v))
                .unwrap_or_else(|| "0".into());
            row.push(v);
        }
        lines.push(format!("{}    {}", ind, row.join("\t")));
    }
    lines.push(format!("{}</tableData>", ind));
    lines.join("\n")
}

fn table_data_3d_to_xml(expr: &Value, level: usize) -> String {
    let ind = indent(level);
    let bp1 = expr
        .get("breakpoints1")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let bp2 = expr
        .get("breakpoints2")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let bp3 = expr
        .get("breakpoints3")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let data = expr
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let rows_per_table = if bp1.is_empty() { 1 } else { bp1.len() };
    let cols = if bp2.is_empty() { 1 } else { bp2.len() };

    let mut lines = vec![];
    for t in 0..bp3.len() {
        lines.push(format!(
            "{}<tableData breakPoint=\"{}\">",
            ind,
            val_to_str(&bp3[t])
        ));

        // Header
        let mut header = vec![String::new()];
        for b in &bp2 {
            header.push(val_to_str(b));
        }
        lines.push(format!("{}    {}", ind, header.join("\t")));

        let start_row = t * rows_per_table;
        for r in 0..rows_per_table {
            let idx = start_row + r;
            let mut row = vec![if r < bp1.len() {
                val_to_str(&bp1[r])
            } else {
                "0".into()
            }];
            for c in 0..cols {
                let v = data
                    .get(idx)
                    .and_then(|d| d.as_array())
                    .and_then(|rd| rd.get(c))
                    .map(|v| val_to_str(v))
                    .unwrap_or_else(|| "0".into());
                row.push(v);
            }
            lines.push(format!("{}    {}", ind, row.join("\t")));
        }
        lines.push(format!("{}</tableData>", ind));
    }
    lines.join("\n")
}

// ── Channel / component serialization ───────────────────────────────────────

fn serialize_channel_item(it: &Value, level: usize) -> Option<String> {
    if it.is_null() || !it.is_object() {
        return None;
    }
    let it_type = it.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if it_type.is_empty() {
        return None;
    }
    let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let attrs: Vec<(&str, &str)> = if !name.is_empty() {
        vec![("name", name)]
    } else {
        vec![]
    };

    // function / fcs_function with expression tree
    if (it_type == "function" || it_type == "fcs_function") && it.get("expression").is_some() {
        let body = expr_to_xml(&it["expression"], level + 1);
        let clip_min = it.get("cliptoMin").and_then(|v| v.as_f64());
        let clip_max = it.get("cliptoMax").and_then(|v| v.as_f64());
        let has_clip = clip_min.is_some() || clip_max.is_some();

        if it_type == "fcs_function" {
            let mut inner = vec![];
            if has_clip {
                let mut ci = vec![];
                if let Some(mn) = clip_min {
                    ci.push(xml_element("min", &[], Some(&fmt_num(mn)), level + 2));
                }
                if let Some(mx) = clip_max {
                    ci.push(xml_element("max", &[], Some(&fmt_num(mx)), level + 2));
                }
                inner.push(xml_element("clipto", &[], Some(&ci.join("\n")), level + 1));
            }
            inner.push(xml_element("function", &[], Some(&body), level + 1));
            return Some(xml_element("fcs_function", &attrs, Some(&inner.join("\n")), level));
        }

        // Bare <function>
        let func_content = if has_clip {
            let mut ci = vec![];
            if let Some(mn) = clip_min {
                ci.push(xml_element("min", &[], Some(&fmt_num(mn)), level + 2));
            }
            if let Some(mx) = clip_max {
                ci.push(xml_element("max", &[], Some(&fmt_num(mx)), level + 2));
            }
            let clip_xml = xml_element("clipto", &[], Some(&ci.join("\n")), level + 1);
            format!("{}\n{}", body, clip_xml)
        } else {
            body
        };
        return Some(xml_element("function", &attrs, Some(&func_content), level));
    }

    // Other components: emit componentProps as child elements
    let comp = it.get("componentProps").and_then(|v| v.as_object());
    let mut lines: Vec<String> = vec![];

    if let Some(comp) = comp {
        // Top-level <property> references
        if let Some(props_val) = comp.get("properties") {
            let arr: Vec<String> = if let Some(a) = props_val.as_array() {
                a.iter().map(|v| val_to_str(v)).collect()
            } else if let Some(inner) = props_val.get("value") {
                vec![val_to_str(inner)]
            } else {
                vec![]
            };
            for p in &arr {
                if !p.is_empty() {
                    lines.push(xml_element("property", &[], Some(p), level + 1));
                }
            }
        }

        // Clipping
        let clip_min = comp
            .get("clipto_min")
            .and_then(|v| v.get("value"))
            .and_then(|v| v.as_f64());
        let clip_max = comp
            .get("clipto_max")
            .and_then(|v| v.get("value"))
            .and_then(|v| v.as_f64());
        if clip_min.is_some() || clip_max.is_some() {
            let mut inner = vec![];
            if let Some(mn) = clip_min {
                inner.push(xml_element("min", &[], Some(&fmt_num(mn)), level + 2));
            }
            if let Some(mx) = clip_max {
                inner.push(xml_element("max", &[], Some(&fmt_num(mx)), level + 2));
            }
            lines.push(xml_element("clipto", &[], Some(&inner.join("\n")), level + 1));
        }

        // Inputs
        if let Some(inputs) = comp.get("inputs").and_then(|v| v.as_array()) {
            let gains = comp.get("gains").and_then(|v| v.as_array());
            for (i, sig) in inputs.iter().enumerate() {
                let sig_str = val_to_str(sig);
                if !sig_str.trim().is_empty() {
                    lines.push(xml_element("input", &[], Some(&sig_str), level + 1));
                }
                if let Some(gains_arr) = gains {
                    if let Some(g) = gains_arr.get(i) {
                        let g_str = val_to_str(g);
                        if !g_str.trim().is_empty() {
                            lines.push(xml_element("gain", &[], Some(&g_str), level + 1));
                        }
                    }
                }
            }
        } else if let Some(input_val) = comp.get("input") {
            let input_str = input_val
                .get("value")
                .map(|v| val_to_str(v))
                .unwrap_or_default();
            if !input_str.is_empty() {
                let input_attrs: Vec<(&str, &str)> = input_val
                    .get("attrs")
                    .and_then(|a| a.as_object())
                    .map(|o| {
                        o.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.as_str(), s)))
                            .collect()
                    })
                    .unwrap_or_default();
                lines.push(xml_element("input", &input_attrs, Some(&input_str), level + 1));

                if let Some(gain_val) = comp.get("gain") {
                    let gain_str = gain_val
                        .get("value")
                        .map(|v| val_to_str(v))
                        .unwrap_or_default();
                    if !gain_str.is_empty() {
                        let gain_attrs: Vec<(&str, &str)> = gain_val
                            .get("attrs")
                            .and_then(|a| a.as_object())
                            .map(|o| {
                                o.iter()
                                    .filter_map(|(k, v)| v.as_str().map(|s| (k.as_str(), s)))
                                    .collect()
                            })
                            .unwrap_or_default();
                        lines.push(xml_element("gain", &gain_attrs, Some(&gain_str), level + 1));
                    }
                }
            }
        }

        // Remaining scalar props
        let skip_keys = [
            "properties", "clipto_min", "clipto_max", "input", "gain", "inputs", "gains", "output",
        ];
        for (field, field_data) in comp {
            if skip_keys.contains(&field.as_str()) {
                continue;
            }
            let val = field_data
                .get("value")
                .map(|v| val_to_str(v))
                .unwrap_or_default();
            let attr_entries: Vec<(&str, &str)> = field_data
                .get("attrs")
                .and_then(|a| a.as_object())
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.as_str(), s)))
                        .collect()
                })
                .unwrap_or_default();
            if val.is_empty() && attr_entries.is_empty() {
                continue;
            }
            lines.push(xml_element(field, &attr_entries, Some(&val), level + 1));
        }

        // Output last
        if let Some(out_val) = comp.get("output").and_then(|v| v.get("value")) {
            let out_str = val_to_str(out_val);
            if !out_str.trim().is_empty() {
                lines.push(xml_element("output", &[], Some(&out_str), level + 1));
            }
        }
    }

    if lines.is_empty() {
        return None;
    }
    Some(xml_element(it_type, &attrs, Some(&lines.join("\n")), level))
}

fn serialize_channels_xml(params: &Value) -> String {
    let channels_str = params
        .get("channels")
        .and_then(|v| v.as_str())
        .unwrap_or("[]");
    let channels: Vec<Value> = serde_json::from_str(channels_str).unwrap_or_default();
    if channels.is_empty() {
        return String::new();
    }

    let mut blocks = vec![];
    for ch in &channels {
        let ch_name = ch.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let items = ch
            .get("items")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|it| serialize_channel_item(it, 3))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if !ch_name.is_empty() || !items.is_empty() {
            let ch_attrs: Vec<(&str, &str)> = if !ch_name.is_empty() {
                vec![("name", ch_name)]
            } else {
                vec![]
            };
            let content = if items.is_empty() {
                None
            } else {
                Some(items.join("\n"))
            };
            blocks.push(xml_element("channel", &ch_attrs, content.as_deref(), 2));
        }
    }
    blocks.join("\n")
}

// ── Node grouping ───────────────────────────────────────────────────────────

fn group_nodes_by_type(nodes: &[Value]) -> std::collections::HashMap<String, Vec<&Value>> {
    let mut groups: std::collections::HashMap<String, Vec<&Value>> =
        std::collections::HashMap::new();
    for node in nodes {
        let ntype = node
            .get("data")
            .and_then(|d| d.get("componentType"))
            .and_then(|v| v.as_str())
            .or_else(|| node.get("type").and_then(|v| v.as_str()))
            .unwrap_or("unknown");
        groups.entry(ntype.to_string()).or_default().push(node);
    }
    groups
}

// ── Section builders ────────────────────────────────────────────────────────

fn build_file_header(aircraft: &Value) -> String {
    let mut lines = vec![];
    let name = aircraft
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unnamed Aircraft");
    lines.push(xml_element("name", &[], Some(name), 1));
    /* Keep the file-header revision independent from the JSBSim schema
     * version.  Legacy models contain SVN values such as "$Revision: 1.91
     * $" here; copying those into fdm_config makes the next load invalid. */
    lines.push(xml_element("version", &[], Some("2.0"), 1));
    if let Some(rel) = aircraft.get("release").and_then(|v| v.as_str()) {
        let desc = format!("Aircraft configuration - {}", rel);
        lines.push(xml_element("description", &[], Some(&desc), 1));
    }
    xml_element("fileheader", &[], Some(&lines.join("\n")), 0)
}

fn build_metrics(groups: &std::collections::HashMap<String, Vec<&Value>>) -> String {
    let mut lines = vec![];

    // Wing nodes
    if let Some(wing_nodes) = groups.get("wing") {
        for wing in wing_nodes {
            let p = get_params(wing);
            if p.get("wingarea").is_some() {
                lines.push(xml_simple(
                    "wingarea",
                    &get_val_or(p.get("wingarea").unwrap(), ""),
                    Some(&get_unit_or(p.get("wingarea").unwrap(), "FT2")),
                    1,
                ));
            }
            if p.get("wingspan").is_some() {
                lines.push(xml_simple(
                    "wingspan",
                    &get_val_or(p.get("wingspan").unwrap(), ""),
                    Some(&get_unit_or(p.get("wingspan").unwrap(), "FT")),
                    1,
                ));
            }
            if p.get("chord").is_some() {
                lines.push(xml_simple(
                    "chord",
                    &get_val_or(p.get("chord").unwrap(), ""),
                    Some(&get_unit_or(p.get("chord").unwrap(), "FT")),
                    1,
                ));
            }
            if p.get("wing_incidence").is_some() {
                lines.push(xml_simple(
                    "wing_incidence",
                    &get_val_or(p.get("wing_incidence").unwrap(), ""),
                    Some(&get_unit_or(p.get("wing_incidence").unwrap(), "DEG")),
                    1,
                ));
            }
            if let Some(loc) = p.get("location").and_then(|v| v.as_object()) {
                let x = loc.get("x").and_then(|v| v.as_f64());
                let y = loc.get("y").and_then(|v| v.as_f64());
                let z = loc.get("z").and_then(|v| v.as_f64());
                let unit = loc
                    .get("unit")
                    .and_then(|v| v.as_str())
                    .unwrap_or("IN");
                lines.push(xml_location(x, y, z, Some(unit), "location", 1));
            }
        }
    }

    // htail nodes
    if let Some(htail_nodes) = groups.get("htail") {
        for ht in htail_nodes {
            let p = get_params(ht);
            if p.get("area").is_some() {
                lines.push(xml_simple(
                    "htailarea",
                    &get_val_or(p.get("area").unwrap(), ""),
                    Some(&get_unit_or(p.get("area").unwrap(), "FT2")),
                    1,
                ));
            }
            if p.get("arm").is_some() {
                lines.push(xml_simple(
                    "htailarm",
                    &get_val_or(p.get("arm").unwrap(), ""),
                    Some(&get_unit_or(p.get("arm").unwrap(), "FT")),
                    1,
                ));
            }
            if p.get("htailarea").is_some() {
                lines.push(xml_simple(
                    "htailarea",
                    &get_val_or(p.get("htailarea").unwrap(), ""),
                    Some(&get_unit_or(p.get("htailarea").unwrap(), "FT2")),
                    1,
                ));
            }
            if p.get("htailarm").is_some() {
                lines.push(xml_simple(
                    "htailarm",
                    &get_val_or(p.get("htailarm").unwrap(), ""),
                    Some(&get_unit_or(p.get("htailarm").unwrap(), "FT")),
                    1,
                ));
            }
        }
    }

    // vtail nodes
    if let Some(vtail_nodes) = groups.get("vtail") {
        for vt in vtail_nodes {
            let p = get_params(vt);
            if p.get("area").is_some() {
                lines.push(xml_simple(
                    "vtailarea",
                    &get_val_or(p.get("area").unwrap(), ""),
                    Some(&get_unit_or(p.get("area").unwrap(), "FT2")),
                    1,
                ));
            }
            if p.get("arm").is_some() {
                lines.push(xml_simple(
                    "vtailarm",
                    &get_val_or(p.get("arm").unwrap(), ""),
                    Some(&get_unit_or(p.get("arm").unwrap(), "FT")),
                    1,
                ));
            }
            if p.get("vtailarea").is_some() {
                lines.push(xml_simple(
                    "vtailarea",
                    &get_val_or(p.get("vtailarea").unwrap(), ""),
                    Some(&get_unit_or(p.get("vtailarea").unwrap(), "FT2")),
                    1,
                ));
            }
            if p.get("vtailarm").is_some() {
                lines.push(xml_simple(
                    "vtailarm",
                    &get_val_or(p.get("vtailarm").unwrap(), ""),
                    Some(&get_unit_or(p.get("vtailarm").unwrap(), "FT")),
                    1,
                ));
            }
        }
    }

    let content = if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n")
    };
    xml_element("metrics", &[], Some(&content), 0)
}

fn build_mass_balance(groups: &std::collections::HashMap<String, Vec<&Value>>) -> String {
    let mut lines = vec![];

    // Fuselage → emptywt, cg
    if let Some(fus_nodes) = groups.get("fuselage") {
        for fus in fus_nodes {
            let p = get_params(fus);
            if let Some(ew) = p.get("emptywt") {
                let val = if ew.is_object() {
                    ew.get("value").map(|v| val_to_str(v)).unwrap_or_default()
                } else {
                    val_to_str(ew)
                };
                let unit = if ew.is_object() {
                    ew.get("unit").and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    None
                };
                if !val.is_empty() {
                    lines.push(xml_simple("emptywt", &val, unit.as_deref(), 1));
                }
            }
            if let Some(cg) = p.get("cg").and_then(|v| v.as_object()) {
                let x = cg.get("x").and_then(|v| v.as_f64());
                let y = cg.get("y").and_then(|v| v.as_f64());
                let z = cg.get("z").and_then(|v| v.as_f64());
                let unit = cg.get("unit").and_then(|v| v.as_str());
                let mut loc = xml_location(x, y, z, unit, "location", 1);
                // Insert name="CG" attribute
                loc = loc.replacen("<location", "<location name=\"CG\"", 1);
                lines.push(loc);
            }
        }
    }

    // Inertia node
    if let Some(inertia_nodes) = groups.get("inertia") {
        for iner in inertia_nodes {
            let p = get_params(iner);
            for (field, default_unit) in &[
                ("ixx", "SLUG*FT2"),
                ("iyy", "SLUG*FT2"),
                ("izz", "SLUG*FT2"),
                ("ixy", "SLUG*FT2"),
                ("ixz", "SLUG*FT2"),
                ("iyz", "SLUG*FT2"),
            ] {
                if let Some(v) = p.get(*field) {
                    lines.push(xml_simple(field, &get_val_or(v, ""), Some(&get_unit_or(v, default_unit)), 1));
                }
            }
        }
    }

    // Point masses
    if let Some(pm_nodes) = groups.get("point_mass") {
        for pm in pm_nodes {
            let p = get_params(pm);
            let mut pm_lines = vec![];
            if let Some(w) = p.get("weight") {
                pm_lines.push(xml_simple(
                    "weight",
                    &get_val_or(w, ""),
                    Some(&get_unit_or(w, "LBS")),
                    2,
                ));
            }
            if let Some(loc) = p.get("location").and_then(|v| v.as_object()) {
                let x = loc.get("x").and_then(|v| v.as_f64());
                let y = loc.get("y").and_then(|v| v.as_f64());
                let z = loc.get("z").and_then(|v| v.as_f64());
                let unit = loc.get("unit").and_then(|v| v.as_str()).unwrap_or("IN");
                pm_lines.push(xml_location(x, y, z, Some(unit), "location", 2));
            }
            let pm_attrs: Vec<(&str, &str)> = p
                .get("name")
                .and_then(|v| v.as_str())
                .map(|n| vec![("name", n)])
                .unwrap_or_default();
            lines.push(xml_element(
                "pointmass",
                &pm_attrs,
                Some(&pm_lines.join("\n")),
                1,
            ));
        }
    }

    let content = if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n")
    };
    xml_element("mass_balance", &[], Some(&content), 0)
}

fn build_ground_reactions(groups: &std::collections::HashMap<String, Vec<&Value>>) -> String {
    let mut lines = vec![];

    if let Some(gear_nodes) = groups.get("landing_gear") {
        for gear in gear_nodes {
            let p = get_params(gear);
            let mut gear_lines = vec![];

            if let Some(loc) = p.get("location").and_then(|v| v.as_object()) {
                let x = loc.get("x").and_then(|v| v.as_f64());
                let y = loc.get("y").and_then(|v| v.as_f64());
                let z = loc.get("z").and_then(|v| v.as_f64());
                let unit = loc.get("unit").and_then(|v| v.as_str()).unwrap_or("IN");
                gear_lines.push(xml_location(x, y, z, Some(unit), "location", 2));
            }

            for field in &["static_friction", "dynamic_friction", "rolling_friction"] {
                if let Some(v) = p.get(*field) {
                    let s = val_to_str(v);
                    if !s.is_empty() {
                        let val = if v.is_object() {
                            v.get("value").map(|vv| val_to_str(vv)).unwrap_or(s)
                        } else {
                            s
                        };
                        if !val.is_empty() {
                            gear_lines.push(xml_element(field, &[], Some(&val), 2));
                        }
                    }
                }
            }

            if let Some(v) = p.get("spring_coeff") {
                gear_lines.push(xml_simple(
                    "spring_coeff",
                    &get_val_or(v, ""),
                    Some(&get_unit_or(v, "LBS/FT")),
                    2,
                ));
            }
            if let Some(v) = p.get("damping_coeff") {
                gear_lines.push(xml_simple(
                    "damping_coeff",
                    &get_val_or(v, ""),
                    Some(&get_unit_or(v, "LBS/FT/SEC")),
                    2,
                ));
            }
            if let Some(v) = p.get("max_steer") {
                gear_lines.push(xml_simple(
                    "max_steer",
                    &get_val_or(v, ""),
                    Some(&get_unit_or(v, "DEG")),
                    2,
                ));
            }
            if let Some(v) = p.get("brake_group").and_then(|v| v.as_str()) {
                if !v.is_empty() {
                    gear_lines.push(xml_element("brake_group", &[], Some(v), 2));
                }
            }
            if let Some(v) = p.get("retractable") {
                let s = val_to_str(v);
                if !s.is_empty() {
                    let val = if v.is_object() {
                        v.get("value").map(|vv| val_to_str(vv)).unwrap_or(s)
                    } else {
                        s
                    };
                    if !val.is_empty() {
                        gear_lines.push(xml_element("retractable", &[], Some(&val), 2));
                    }
                }
            }

            let mut contact_attrs = vec![];
            if let Some(n) = p.get("name").and_then(|v| v.as_str()) {
                if !n.is_empty() {
                    contact_attrs.push(("name", n));
                }
            }
            if let Some(t) = p.get("type").and_then(|v| v.as_str()) {
                if !t.is_empty() {
                    contact_attrs.push(("type", t));
                }
            }
            lines.push(xml_element(
                "contact",
                &contact_attrs,
                Some(&gear_lines.join("\n")),
                1,
            ));
        }
    }

    let content = if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n")
    };
    xml_element("ground_reactions", &[], Some(&content), 0)
}

fn build_external_reactions() -> String {
    xml_element("external_reactions", &[], None, 0)
}

fn build_propulsion(
    groups: &std::collections::HashMap<String, Vec<&Value>>,
    input: &Value,
) -> String {
    let mut lines = vec![];

    let engine_nodes = groups.get("engine").cloned().unwrap_or_default();
    let propeller_nodes = groups.get("propeller").cloned().unwrap_or_default();
    let fuel_tank_nodes = groups.get("fuel_tank").cloned().unwrap_or_default();
    let edges = input.get("edges").and_then(|v| v.as_array());

    // Engines
    for eng in &engine_nodes {
        let p = get_params(eng);
        let mut eng_lines = vec![];

        // Feed tanks
        if let Some(feed) = p.get("feed") {
            let feeds: Vec<String> = if let Some(s) = feed.as_str() {
                s.split(',').map(|s| s.trim().to_string()).collect()
            } else {
                vec![val_to_str(feed)]
            };
            for f in &feeds {
                if !f.is_empty() {
                    eng_lines.push(xml_element("feed", &[], Some(f), 2));
                }
            }
        }

        // Thruster (nested propeller)
        {
            let mut thr_lines = vec![];

            // Find connected propeller
            let prop_node = propeller_nodes.iter().find(|pr| {
                edges.map_or(false, |es| {
                    es.iter().any(|e| {
                        let src = e.get("source").and_then(|v| v.as_str()).unwrap_or("");
                        let tgt = e.get("target").and_then(|v| v.as_str()).unwrap_or("");
                        let eng_id = eng.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let pr_id = pr.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        (src == eng_id && tgt == pr_id) || (src == pr_id && tgt == eng_id)
                    })
                })
            });

            let pp = prop_node.map(|pr| get_params(pr)).unwrap_or(&Value::Null);

            if !pp.is_null() {
                if let Some(loc) = pp.get("location").and_then(|v| v.as_object()) {
                    let x = loc.get("x").and_then(|v| v.as_f64());
                    let y = loc.get("y").and_then(|v| v.as_f64());
                    let z = loc.get("z").and_then(|v| v.as_f64());
                    let unit = loc.get("unit").and_then(|v| v.as_str());
                    thr_lines.push(xml_location(x, y, z, unit, "location", 3));
                }
                if let Some(s) = pp.get("sense").map(|v| val_to_str(v)) {
                    if !s.is_empty() {
                        thr_lines.push(xml_element("sense", &[], Some(&s), 3));
                    }
                }
                if let Some(s) = pp.get("p_factor").map(|v| val_to_str(v)) {
                    if !s.is_empty() {
                        thr_lines.push(xml_element("p_factor", &[], Some(&s), 3));
                    }
                }
                if let Some(v) = pp.get("diameter") {
                    thr_lines.push(xml_simple(
                        "diameter",
                        &get_val_or(v, ""),
                        get_unit(v).as_deref(),
                        3,
                    ));
                }
                if let Some(s) = pp.get("numblades").map(|v| val_to_str(v)) {
                    if !s.is_empty() {
                        thr_lines.push(xml_element("numblades", &[], Some(&s), 3));
                    }
                }
                if let Some(s) = pp.get("gearratio").map(|v| val_to_str(v)) {
                    if !s.is_empty() {
                        thr_lines.push(xml_element("gearratio", &[], Some(&s), 3));
                    }
                }

                // Inline tables
                let tbls = pp
                    .get("tables")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let thr_content = if thr_lines.is_empty() {
                    None
                } else {
                    Some(thr_lines.join("\n"))
                };
                if !tbls.is_empty() {
                    for t in &tbls {
                        if let Some(expr) = t.get("expression") {
                            thr_lines.push(expr_to_xml(expr, 3));
                        }
                    }
                    let thr_body = thr_lines.join("\n");
                    eng_lines.push(xml_element("thruster", &[], Some(&thr_body), 2));
                } else if let Some(tf) = p.get("thruster_file").and_then(|v| v.as_str()) {
                    if !tf.is_empty() {
                        eng_lines.push(xml_element(
                            "thruster",
                            &[("file", tf)],
                            thr_content.as_deref(),
                            2,
                        ));
                    } else {
                        eng_lines.push(xml_element(
                            "thruster",
                            &[],
                            thr_content.as_deref(),
                            2,
                        ));
                    }
                } else {
                    eng_lines.push(xml_element(
                        "thruster",
                        &[],
                        thr_content.as_deref(),
                        2,
                    ));
                }
            } else {
                // No propeller connected
                if let Some(tf) = p.get("thruster_file").and_then(|v| v.as_str()) {
                    if !tf.is_empty() {
                        eng_lines.push(xml_element("thruster", &[("file", tf)], None, 2));
                    } else {
                        eng_lines.push(xml_element("thruster", &[], None, 2));
                    }
                } else {
                    eng_lines.push(xml_element("thruster", &[], None, 2));
                }
            }
        }

        let mut eng_attrs = vec![];
        if let Some(f) = p.get("file").and_then(|v| v.as_str()) {
            if !f.is_empty() {
                eng_attrs.push(("file", f));
            }
        }
        lines.push(xml_element(
            "engine",
            &eng_attrs,
            Some(&eng_lines.join("\n")),
            1,
        ));
    }

    // Propellers (standalone, not linked to engine)
    for prop in &propeller_nodes {
        let linked = edges.map_or(false, |es| {
            let prop_id = prop.get("id").and_then(|v| v.as_str()).unwrap_or("");
            es.iter().any(|e| {
                let src = e.get("source").and_then(|v| v.as_str()).unwrap_or("");
                let tgt = e.get("target").and_then(|v| v.as_str()).unwrap_or("");
                (src == prop_id && engine_nodes.iter().any(|en| {
                    en.get("id").and_then(|v| v.as_str()).unwrap_or("") == tgt
                })) || (tgt == prop_id && engine_nodes.iter().any(|en| {
                    en.get("id").and_then(|v| v.as_str()).unwrap_or("") == src
                }))
            })
        });
        if linked {
            continue;
        }

        let p = get_params(prop);
        let mut prop_lines = vec![];

        if let Some(loc) = p.get("location").and_then(|v| v.as_object()) {
            let x = loc.get("x").and_then(|v| v.as_f64());
            let y = loc.get("y").and_then(|v| v.as_f64());
            let z = loc.get("z").and_then(|v| v.as_f64());
            let unit = loc.get("unit").and_then(|v| v.as_str());
            prop_lines.push(xml_location(x, y, z, unit, "location", 2));
        }
        if let Some(s) = p.get("sense").map(|v| val_to_str(v)) {
            if !s.is_empty() {
                prop_lines.push(xml_element("sense", &[], Some(&s), 2));
            }
        }
        if let Some(s) = p.get("p_factor").map(|v| val_to_str(v)) {
            if !s.is_empty() {
                prop_lines.push(xml_element("p_factor", &[], Some(&s), 2));
            }
        }
        if let Some(v) = p.get("diameter") {
            prop_lines.push(xml_simple(
                "diameter",
                &get_val_or(v, ""),
                get_unit(v).as_deref(),
                2,
            ));
        }
        if let Some(s) = p.get("numblades").map(|v| val_to_str(v)) {
            if !s.is_empty() {
                prop_lines.push(xml_element("numblades", &[], Some(&s), 2));
            }
        }
        if let Some(s) = p.get("gearratio").map(|v| val_to_str(v)) {
            if !s.is_empty() {
                prop_lines.push(xml_element("gearratio", &[], Some(&s), 2));
            }
        }

        let tbls = p
            .get("tables")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if !tbls.is_empty() {
            for t in &tbls {
                if let Some(expr) = t.get("expression") {
                    prop_lines.push(expr_to_xml(expr, 2));
                }
            }
            lines.push(xml_element(
                "thruster",
                &[],
                Some(&prop_lines.join("\n")),
                1,
            ));
        } else {
            let mut thr_attrs = vec![];
            if let Some(f) = p.get("file").and_then(|v| v.as_str()) {
                if !f.is_empty() {
                    thr_attrs.push(("file", f));
                }
            }
            lines.push(xml_element(
                "thruster",
                &thr_attrs,
                Some(&prop_lines.join("\n")),
                1,
            ));
        }
    }

    // Fuel tanks
    for tank in &fuel_tank_nodes {
        let p = get_params(tank);
        let mut tank_lines = vec![];

        if let Some(loc) = p.get("location").and_then(|v| v.as_object()) {
            let x = loc.get("x").and_then(|v| v.as_f64());
            let y = loc.get("y").and_then(|v| v.as_f64());
            let z = loc.get("z").and_then(|v| v.as_f64());
            let unit = loc.get("unit").and_then(|v| v.as_str()).unwrap_or("IN");
            tank_lines.push(xml_location(x, y, z, Some(unit), "location", 2));
        }
        if let Some(v) = p.get("capacity") {
            tank_lines.push(xml_simple(
                "capacity",
                &get_val_or(v, ""),
                Some(&get_unit_or(v, "LBS")),
                2,
            ));
        }
        if let Some(v) = p.get("contents") {
            tank_lines.push(xml_simple(
                "contents",
                &get_val_or(v, ""),
                Some(&get_unit_or(v, "LBS")),
                2,
            ));
        }

        lines.push(xml_element(
            "tank",
            &[("type", "FUEL")],
            Some(&tank_lines.join("\n")),
            1,
        ));
    }

    let content = if lines.is_empty() {
        String::new()
    } else {
        lines.join("\n")
    };
    xml_element("propulsion", &[], Some(&content), 0)
}

fn build_system_references(groups: &std::collections::HashMap<String, Vec<&Value>>) -> String {
    let system_nodes = match groups.get("system") {
        Some(n) => n,
        None => return String::new(),
    };

    let mut lines = vec![];
    for sys in system_nodes {
        let p = get_params(sys);
        let file = p
            .get("file")
            .and_then(|v| v.as_str())
            .or_else(|| {
                sys.get("data")
                    .and_then(|d| d.get("label"))
                    .and_then(|v| v.as_str())
            })
            .unwrap_or("unknown");

        // A file-backed system is represented in the aircraft XML only by
        // its reference. Its channels/properties are serialized into the
        // referenced systems XML by the per-file generator.
        if p.get("file").and_then(|v| v.as_str()).map(|v| !v.is_empty()).unwrap_or(false) {
            lines.push(xml_element("system", &[("file", file)], None, 1));
            continue;
        }

        let properties = p.get("properties");
        let mut body = String::new();

        if let Some(props) = properties {
            let prop_list: Vec<String> = if let Some(s) = props.as_str() {
                s.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else if let Some(a) = props.as_array() {
                a.iter().map(|v| val_to_str(v)).collect()
            } else {
                vec![]
            };
            let prop_xmls: Vec<String> = prop_list
                .iter()
                .map(|prop| xml_element("property", &[], Some(prop), 2))
                .collect();
            if !prop_xmls.is_empty() {
                body = prop_xmls.join("\n");
            }
        }

        let ch_xml = serialize_channels_xml(p);
        if !ch_xml.is_empty() {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(&ch_xml);
        }

        if body.trim().is_empty() {
            lines.push(xml_element("system", &[("file", file)], None, 1));
        } else {
            lines.push(xml_element("system", &[("file", file)], Some(&body), 1));
        }
    }

    lines.join("\n")
}

fn build_flight_control(groups: &std::collections::HashMap<String, Vec<&Value>>) -> String {
    let fc_nodes = match groups.get("flight_control") {
        Some(n) => n,
        None => return String::new(),
    };

    let mut lines = vec![];
    for node in fc_nodes {
        let p = get_params(node);
        let file = p.get("file").and_then(|v| v.as_str()).unwrap_or("");
        let name = p
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| {
                node.get("data")
                    .and_then(|d| d.get("label"))
                    .and_then(|v| v.as_str())
            })
            .unwrap_or("");

        if !file.is_empty() {
            lines.push(xml_element("flight_control", &[("file", file)], None, 1));
            continue;
        }

        let mut body = String::new();

        let properties = p.get("properties");
        if let Some(props) = properties {
            let prop_list: Vec<String> = if let Some(s) = props.as_str() {
                s.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else if let Some(a) = props.as_array() {
                a.iter().map(|v| val_to_str(v)).collect()
            } else {
                vec![]
            };
            let prop_xmls: Vec<String> = prop_list
                .iter()
                .map(|prop| xml_element("property", &[], Some(prop), 2))
                .collect();
            if !prop_xmls.is_empty() {
                body = prop_xmls.join("\n");
            }
        }

        let ch_xml = serialize_channels_xml(p);
        if !ch_xml.is_empty() {
            if !body.is_empty() && !body.ends_with('\n') {
                body.push('\n');
            }
            body.push_str(&ch_xml);
        }

        if body.trim().is_empty() {
            continue;
        }

        let mut attrs = vec![];
        if !file.is_empty() {
            attrs.push(("file", file));
        } else if !name.is_empty() {
            attrs.push(("name", name));
        }
        lines.push(xml_element("flight_control", &attrs, Some(&body), 1));
    }

    lines.join("\n\n")
}

fn build_aerodynamics(groups: &std::collections::HashMap<String, Vec<&Value>>) -> String {
    let aero_nodes = match groups.get("aero_coefficients") {
        Some(n) => n,
        None => return xml_element("aerodynamics", &[], None, 0),
    };

    // Collect (axis, xml_string) pairs
    let mut func_entries: Vec<(String, String)> = vec![];

    for aero in aero_nodes {
        let p = get_params(aero);
        let raw_coeffs = p
            .get("coefficients")
            .and_then(|v| v.as_str())
            .unwrap_or("[]");
        let coeffs: Vec<Value> = serde_json::from_str(raw_coeffs).unwrap_or_default();

        for c in &coeffs {
            let func_name = match c.get("name").and_then(|v| v.as_str()) {
                Some(n) if !n.is_empty() => n,
                _ => continue,
            };

            let axis = match c.get("axis").and_then(|v| v.as_str()) {
                Some("DRAG") => "drag",
                Some("SIDE") => "side",
                Some("LIFT") => "lift",
                Some("ROLL") => "roll",
                Some("PITCH") => "pitch",
                Some("YAW") => "yaw",
                _ => "lift",
            };

            let body_xml = if let Some(expr) = c.get("expression") {
                expr_to_xml(expr, 3)
            } else {
                // Legacy flat format
                let table_type = c.get("tableType").and_then(|v| v.as_str()).unwrap_or("");
                if table_type == "constant" {
                    let val = c
                        .get("value")
                        .map(|v| val_to_str(v))
                        .unwrap_or_else(|| "0".into());
                    xml_element("value", &[], Some(&val), 3)
                } else if table_type == "1D" || table_type == "2D" || table_type == "3D" {
                    let var1 = c
                        .get("var1")
                        .and_then(|v| v.as_str())
                        .unwrap_or("aero/alpha-rad");
                    let table_expr = serde_json::json!({
                        "kind": "table",
                        "tableType": table_type,
                        "var1": var1,
                        "var2": c.get("var2").and_then(|v| v.as_str()).unwrap_or(""),
                        "var3": c.get("var3").and_then(|v| v.as_str()).unwrap_or(""),
                        "data": c.get("data").unwrap_or(&serde_json::json!([[0]])),
                        "breakpoints1": c.get("breakpoints1").unwrap_or(&serde_json::json!([0])),
                        "breakpoints2": c.get("breakpoints2").unwrap_or(&serde_json::json!([])),
                        "breakpoints3": c.get("breakpoints3").unwrap_or(&serde_json::json!([])),
                    });
                    let mut prod_lines = vec![];
                    prod_lines.push(xml_element("property", &[], Some(var1), 3));
                    prod_lines.push(expr_to_xml(&table_expr, 3));
                    xml_element("product", &[], Some(&prod_lines.join("\n")), 3)
                } else {
                    xml_element("value", &[], Some("0"), 3)
                }
            };

            let desc_xml = c
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|d| xml_element("description", &[], Some(d), 3));

            let mut func_content_parts = vec![];
            if let Some(ref d) = desc_xml {
                func_content_parts.push(d.clone());
            }
            func_content_parts.push(body_xml);
            let func_content = func_content_parts.join("\n");

            let func_xml = xml_element("function", &[("name", func_name)], Some(&func_content), 2);
            func_entries.push((axis.to_string(), func_xml));
        }
    }

    // Group by axis
    let mut axis_groups: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for (axis, xml) in func_entries {
        axis_groups.entry(axis).or_default().push(xml);
    }

    let mut axis_blocks = vec![];
    for (axis_name, funcs) in &axis_groups {
        axis_blocks.push(xml_element(
            "axis",
            &[("name", &axis_name.to_uppercase())],
            Some(&funcs.join("\n")),
            1,
        ));
    }

    let content = if axis_blocks.is_empty() {
        String::new()
    } else {
        axis_blocks.join("\n")
    };
    xml_element("aerodynamics", &[], Some(&content), 0)
}

fn build_output(groups: &std::collections::HashMap<String, Vec<&Value>>) -> String {
    let mut output_nodes = groups.get("output").cloned().unwrap_or_default();
    output_nodes.extend(groups.get("uavcan").cloned().unwrap_or_default());
    if output_nodes.is_empty() {
        return String::new();
    }

    let mut blocks = vec![];
    for out in output_nodes {
        let p = get_params(out);
        let mut out_lines = vec![];

        let data_groups = [
            "simulation", "atmosphere", "massprops", "rates", "velocities", "forces", "moments",
            "position", "propulsion", "aerosurfaces", "fcs", "ground_reactions", "coefficients",
        ];
        for group in &data_groups {
            if let Some(v) = p.get(*group) {
                let s = val_to_str(v);
                if !s.is_empty() {
                    out_lines.push(xml_element(group, &[], Some(&s), 1));
                }
            }
        }

        // Properties
        if let Some(props) = p.get("properties") {
            let prop_list: Vec<String> = if let Some(s) = props.as_str() {
                s.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else if let Some(a) = props.as_array() {
                a.iter()
                    .map(|v| {
                        if v.is_object() {
                            v.get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("")
                                .to_string()
                        } else {
                            val_to_str(v)
                        }
                    })
                    .collect()
            } else {
                vec![]
            };
            for prop in &prop_list {
                if !prop.is_empty() {
                    out_lines.push(xml_element("property", &[], Some(prop), 1));
                }
            }
        }

        let mut attrs: Vec<(String, String)> = vec![];
        if let Some(n) = p.get("name").and_then(|v| v.as_str()) {
            if !n.is_empty() {
                attrs.push(("name".to_string(), n.to_string()));
            }
        }
        if let Some(t) = p.get("type").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                attrs.push(("type".to_string(), t.to_string()));
            }
        }
        let component_type = out
            .get("data")
            .and_then(|d| d.get("componentType"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if component_type == "uavcan" {
            attrs.push(("type".to_string(), "UAVCAN".to_string()));
            for key in ["interface", "node_id", "subject_id", "dsdl_path", "dsdl_type", "sensor_type"] {
                if let Some(value) = p.get(key) {
                    let text = val_to_str(value);
                    if !text.is_empty() {
                        attrs.push((key.to_string(), text));
                    }
                }
            }
        }
        if let Some(port) = p.get("port") {
            let s = val_to_str(port);
            if !s.is_empty() {
                attrs.push(("port".to_string(), s));
            }
        }
        if let Some(rate) = p.get("rate") {
            let s = val_to_str(rate);
            if !s.is_empty() {
                attrs.push(("rate".to_string(), s));
            }
        }

        let attr_refs: Vec<(&str, &str)> = attrs
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        blocks.push(xml_element(
            "output",
            &attr_refs,
            Some(&out_lines.join("\n")),
            0,
        ));
    }
    blocks.join("\n\n")
}

// ── Main generator ──────────────────────────────────────────────────────────

/// Generate JSBSim aircraft XML from a JSON graph.
pub fn generate_xml(data: &Value) -> Result<String, String> {
    let aircraft = data
        .get("aircraft")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({"name": "Unnamed Aircraft", "version": "1.0"}));
    let nodes = data
        .get("nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let groups = group_nodes_by_type(&nodes);

    let mut sections = vec![];

    // XML declaration
    sections.push("<?xml version=\"1.0\"?>".to_string());

    // Root element attributes
    let name = aircraft
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unnamed Aircraft");
    /* JSBSim 1.3/2.x expects the aircraft configuration schema version,
     * not the legacy file-header SVN revision. */
    let version = "2.0";
    let release = aircraft.get("release").and_then(|v| v.as_str());

    let mut fdm_attrs = format!("name=\"{}\" version=\"{}\"", escape_xml(name), escape_xml(version));
    if let Some(rel) = release {
        fdm_attrs.push_str(&format!(" release=\"{}\"", escape_xml(rel)));
    }

    // Build sections
    let mut section_content = vec![];
    section_content.push(build_file_header(&aircraft));
    section_content.push(build_metrics(&groups));
    section_content.push(build_mass_balance(&groups));
    section_content.push(build_ground_reactions(&groups));
    section_content.push(build_external_reactions());
    section_content.push(build_propulsion(&groups, data));

    let system_refs = build_system_references(&groups);
    if !system_refs.is_empty() {
        section_content.push(system_refs);
    }

    let fc_xml = build_flight_control(&groups);
    if !fc_xml.is_empty() {
        section_content.push(fc_xml);
    }

    section_content.push(build_aerodynamics(&groups));

    let output_xml = build_output(&groups);
    if !output_xml.is_empty() {
        section_content.push(output_xml);
    }

    let inner_xml = section_content.join("\n\n");

    sections.push(format!("<fdm_config {}>", fdm_attrs));
    sections.push(inner_xml);
    sections.push("</fdm_config>".to_string());

    Ok(sections.join("\n\n") + "\n")
}

/// Generate sub-file XML (engine, thruster, system).
pub fn generate_subfile_xml(
    file_type: &str,
    name: &str,
    params: &Value,
) -> Result<String, String> {
    let mut lines = vec!["<?xml version=\"1.0\"?>".to_string()];

    match file_type {
        "engine" => {
            let engine_type = params
                .get("engineType")
                .and_then(|v| v.as_str())
                .unwrap_or("piston");

            match engine_type {
                "piston" | "electric" => {
                    let mut content = vec![];
                    if let Some(v) = params.get("maxHP") {
                        content.push(xml_simple("maxhp", &val_to_str(v), None, 1));
                    }
                    if let Some(v) = params.get("displacement") {
                        content.push(xml_simple("displacement", &val_to_str(v), Some("IN3"), 1));
                    }
                    if let Some(v) = params.get("cycles") {
                        content.push(xml_simple("cycles", &val_to_str(v), None, 1));
                    }
                    if let Some(v) = params.get("bsfc") {
                        content.push(xml_simple("bsfc", &val_to_str(v), Some("LBS/HP*HR"), 1));
                    }
                    if let Some(v) = params.get("starterTorque") {
                        content.push(xml_simple("startertorque", &val_to_str(v), None, 1));
                    }
                    if let Some(v) = params.get("idleRPM") {
                        content.push(xml_simple("idlerpm", &val_to_str(v), None, 1));
                    }
                    if let Some(v) = params.get("maxRPM") {
                        content.push(xml_simple("maxrpm", &val_to_str(v), None, 1));
                    }
                    if let Some(v) = params.get("minMP") {
                        content.push(xml_simple("minmp", &val_to_str(v), Some("INHG"), 1));
                    }
                    if let Some(v) = params.get("maxMP") {
                        content.push(xml_simple("maxmp", &val_to_str(v), Some("INHG"), 1));
                    }
                    lines.push(xml_element(
                        "piston_engine",
                        &[("name", name)],
                        Some(&content.join("\n")),
                        0,
                    ));
                }
                "turbine" => {
                    let mut content = vec![];
                    if let Some(v) = params.get("maxThrust") {
                        content.push(xml_simple("maxthrust", &val_to_str(v), Some("LBS"), 1));
                    }
                    if let Some(v) = params.get("idleRPM") {
                        content.push(xml_simple("idlen1", &val_to_str(v), None, 1));
                    }
                    if let Some(v) = params.get("maxRPM") {
                        content.push(xml_simple("maxn1", &val_to_str(v), None, 1));
                    }
                    lines.push(xml_element(
                        "turbine_engine",
                        &[("name", name)],
                        Some(&content.join("\n")),
                        0,
                    ));
                }
                "rocket" => {
                    let mut content = vec![];
                    if let Some(v) = params.get("maxThrust") {
                        content.push(xml_simple("maxthrust", &val_to_str(v), Some("LBS"), 1));
                    }
                    lines.push(xml_element(
                        "rocket_engine",
                        &[("name", name)],
                        Some(&content.join("\n")),
                        0,
                    ));
                }
                _ => {
                    return Err(format!("Unknown engine type: {}", engine_type));
                }
            }
        }
        "thruster" => {
            let thruster_type = params
                .get("thrusterType")
                .and_then(|v| v.as_str())
                .unwrap_or("propeller");

            match thruster_type {
                "propeller" => {
                    let mut content = vec![];
                    if let Some(v) = params.get("diameter") {
                        content.push(xml_simple("diameter", &val_to_str(v), Some("IN"), 1));
                    }
                    if let Some(v) = params.get("numBlades") {
                        content.push(xml_simple("numblades", &val_to_str(v), None, 1));
                    }
                    if let Some(v) = params.get("gearRatio") {
                        content.push(xml_simple("gearratio", &val_to_str(v), None, 1));
                    }
                    lines.push(xml_element(
                        "propeller",
                        &[("name", name)],
                        Some(&content.join("\n")),
                        0,
                    ));
                }
                "direct" => {
                    lines.push(xml_element("direct", &[("name", name)], None, 0));
                }
                "nozzle" => {
                    lines.push(xml_element("nozzle", &[("name", name)], None, 0));
                }
                _ => {
                    return Err(format!("Unknown thruster type: {}", thruster_type));
                }
            }
        }
        "system" => {
            let mut content = vec![];
            let properties = params.get("properties");
            let prop_list: Vec<String> = if let Some(a) = properties.and_then(|v| v.as_array()) {
                a.iter()
                    .map(|v| {
                        if v.is_object() {
                            v.get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("")
                                .to_string()
                        } else {
                            val_to_str(v)
                        }
                    })
                    .collect()
            } else if let Some(s) = params.get("properties").and_then(|v| v.as_str()) {
                s.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            } else {
                vec![]
            };
            for prop in &prop_list {
                if !prop.is_empty() {
                    content.push(xml_element("property", &[], Some(prop), 1));
                }
            }
            // System signal-flow edits live in `channels`.  Omitting them
            // produced an almost empty child XML and encouraged callers to
            // regenerate the aircraft XML instead.
            let channels = serialize_channels_xml(params);
            if !channels.trim().is_empty() {
                content.push(channels);
            }
            let body = if content.is_empty() {
                None
            } else {
                Some(content.join("\n"))
            };
            lines.push(xml_element("system", &[("name", name)], body.as_deref(), 0));
        }
        _ => {
            return Err(format!("Unknown sub-file type: {}", file_type));
        }
    }

    Ok(lines.join("\n") + "\n")
}
