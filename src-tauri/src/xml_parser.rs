//! JSBSim XML parser — parses JSBSim aircraft XML into JSON graph format.
//!
//! Converts a JSBSim aircraft XML file (plus referenced sub-files) into a
//! JSON structure with aircraft metadata, nodes, and edges for the visual editor.

use crate::expression_xml::{
    extract_tables, find_child, find_children, get_attr, get_text, parse_xml_tree, xml_to_expr,
    ExprNode, XmlElement,
};
use serde_json::{json, Value};
use std::collections::HashMap;

// ── Layout state ───────────────────────────────────────────────────────────

const COL_WIDTH: f64 = 300.0;
const ROW_HEIGHT: f64 = 200.0;

struct LayoutState {
    col: usize,
    row: usize,
    node_counter: usize,
}

impl LayoutState {
    fn new() -> Self {
        Self {
            col: 0,
            row: 0,
            node_counter: 0,
        }
    }

    fn next_position(&mut self) -> Value {
        let pos = json!({
            "x": 100.0 + self.col as f64 * COL_WIDTH,
            "y": 100.0 + self.row as f64 * ROW_HEIGHT
        });
        self.col += 1;
        if self.col > 4 {
            self.col = 0;
            self.row += 1;
        }
        pos
    }

    fn next_id(&mut self) -> String {
        self.node_counter += 1;
        format!("node-{}", self.node_counter)
    }
}

// ── Value extraction helpers ───────────────────────────────────────────────

fn extract_value_with_unit(elem: &XmlElement) -> Option<Value> {
    let val = if let Some(v) = get_attr(elem, "value") {
        v.parse::<f64>().ok()
    } else {
        let text = get_text(elem);
        if text.is_empty() {
            None
        } else {
            text.parse::<f64>().ok()
        }
    };

    let unit = get_attr(elem, "unit").map(|s| s.to_string());

    val.map(|v| {
        if let Some(u) = unit {
            json!({ "value": v, "unit": u })
        } else {
            json!({ "value": v })
        }
    })
}

fn extract_location(obj: &XmlElement) -> Option<Value> {
    // Attribute format
    let x = get_attr(obj, "x").and_then(|s| s.parse::<f64>().ok());
    let y = get_attr(obj, "y").and_then(|s| s.parse::<f64>().ok());
    let z = get_attr(obj, "z").and_then(|s| s.parse::<f64>().ok());
    let unit = get_attr(obj, "unit").unwrap_or("IN");

    // Child element format
    let cx = find_child(obj, "x").and_then(|e| get_text(e).parse::<f64>().ok());
    let cy = find_child(obj, "y").and_then(|e| get_text(e).parse::<f64>().ok());
    let cz = find_child(obj, "z").and_then(|e| get_text(e).parse::<f64>().ok());

    let fx = x.or(cx);
    let fy = y.or(cy);
    let fz = z.or(cz);

    if fx.is_some() || fy.is_some() || fz.is_some() {
        Some(json!({ "x": fx, "y": fy, "z": fz, "unit": unit }))
    } else {
        None
    }
}

fn extract_orient(obj: &XmlElement) -> Option<Value> {
    let r = get_attr(obj, "roll")
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| find_child(obj, "roll").and_then(|e| get_text(e).parse::<f64>().ok()));
    let p = get_attr(obj, "pitch")
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| find_child(obj, "pitch").and_then(|e| get_text(e).parse::<f64>().ok()));
    let y = get_attr(obj, "yaw")
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| find_child(obj, "yaw").and_then(|e| get_text(e).parse::<f64>().ok()));

    if r.is_some() || p.is_some() || y.is_some() {
        Some(json!({ "roll": r, "pitch": p, "yaw": y }))
    } else {
        None
    }
}

fn extract_signal_name(obj: &XmlElement) -> String {
    get_text(obj)
}

// ── Section parsers ────────────────────────────────────────────────────────

fn parse_file_header(fdm_config: &XmlElement, aircraft: &mut Value) {
    if let Some(fh) = find_child(fdm_config, "fileheader") {
        if let Some(name_elem) = find_child(fh, "name") {
            aircraft["name"] = json!(get_text(name_elem));
        }
        if let Some(ver_elem) = find_child(fh, "version") {
            aircraft["version"] = json!(get_text(ver_elem));
        }
        if let Some(desc_elem) = find_child(fh, "description") {
            let desc = get_text(desc_elem);
            if let Some(pos) = desc.rfind("- ") {
                aircraft["release"] = json!(desc[pos + 2..].trim());
            }
        }
    }
}

fn parse_metrics(fdm_config: &XmlElement, nodes: &mut Vec<Value>, layout: &mut LayoutState) {
    let metrics = match find_child(fdm_config, "metrics") {
        Some(m) => m,
        None => return,
    };

    let mut params = json!({});

    for field in &[
        "wingarea", "wingspan", "chord", "htailarea", "htailarm", "vtailarea", "vtailarm",
    ] {
        if let Some(elem) = find_child(metrics, field) {
            if let Some(v) = extract_value_with_unit(elem) {
                params[field] = v;
            }
        }
    }

    // Location (AERORP preferred)
    let locations = find_children(metrics, "location");
    let wing_loc = locations
        .iter()
        .find(|l| {
            get_attr(l, "name")
                .map(|n| n.to_uppercase() == "AERORP")
                .unwrap_or(false)
        })
        .or_else(|| {
            locations.iter().find(|l| {
                get_attr(l, "name")
                    .map(|n| n.to_uppercase() == "EYEPOINT")
                    .unwrap_or(false)
            })
        })
        .or_else(|| {
            locations.iter().find(|l| {
                get_attr(l, "name")
                    .map(|n| n.to_uppercase() == "VRP")
                    .unwrap_or(false)
            })
        })
        .or_else(|| locations.first());

    if let Some(loc) = wing_loc {
        if let Some(location) = extract_location(loc) {
            params["location"] = location;
        }
    }

    // Extract tables
    let (tables_expr, tables_raw) = extract_tables(metrics);
    if !tables_expr.is_empty() {
        params["tables"] = json!(tables_expr);
    }
    if !tables_raw.is_empty() {
        params["_tables"] = json!(tables_raw);
    }

    // Only create node if there's meaningful data
    if params.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
        let id = layout.next_id();
        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": "Wing",
                "componentType": "wing",
                "params": params
            },
            "position": layout.next_position()
        }));
    }

    // Multiple wingarea entries → extra wing nodes
    let wingarea_entries = find_children(metrics, "wingarea");
    for (i, _entry) in wingarea_entries.iter().enumerate().skip(1) {
        let id = layout.next_id();
        let wing_params = json!({
            "wingarea": extract_value_with_unit(_entry)
        });
        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": format!("Wing {}", i + 1),
                "componentType": "wing",
                "params": wing_params
            },
            "position": layout.next_position()
        }));
    }
}

fn parse_mass_balance(fdm_config: &XmlElement, nodes: &mut Vec<Value>, layout: &mut LayoutState) {
    let mb = match find_child(fdm_config, "mass_balance") {
        Some(m) => m,
        None => return,
    };

    // Fuselage (emptywt + CG)
    if let Some(emptywt_elem) = find_child(mb, "emptywt") {
        let mut fuselage_params = json!({});
        if let Some(v) = extract_value_with_unit(emptywt_elem) {
            fuselage_params["emptywt"] = v;
        }

        // Look for pointmass with cg location
        let point_masses = find_children(mb, "pointmass");
        let mut cg_found = false;
        for pm in &point_masses {
            if find_child(pm, "location").is_some()
                && find_child(pm, "weight").is_none()
                && get_attr(pm, "name").is_none()
            {
                if let Some(loc) = find_child(pm, "location").and_then(|l| extract_location(l)) {
                    fuselage_params["cg"] = loc;
                    cg_found = true;
                    break;
                }
            }
        }

        // Direct <location name="CG"> child
        if !cg_found {
            let mb_locs = find_children(mb, "location");
            let cg_loc = mb_locs
                .iter()
                .find(|l| {
                    get_attr(l, "name")
                        .map(|n| n.to_uppercase() == "CG")
                        .unwrap_or(false)
                })
                .or_else(|| mb_locs.first());
            if let Some(loc) = cg_loc {
                if let Some(location) = extract_location(loc) {
                    fuselage_params["cg"] = location;
                }
            }
        }

        if fuselage_params.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            let id = layout.next_id();
            nodes.push(json!({
                "id": id,
                "type": "aircraftComponent",
                "data": {
                    "label": "Fuselage",
                    "componentType": "fuselage",
                    "params": fuselage_params
                },
                "position": layout.next_position()
            }));
        }
    }

    // Inertia values
    let mut inertia_params = json!({});
    for field in &["ixx", "iyy", "izz", "ixy", "ixz", "iyz"] {
        if let Some(elem) = find_child(mb, field) {
            if let Some(v) = extract_value_with_unit(elem) {
                inertia_params[field] = v;
            }
        }
    }

    if inertia_params.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
        let id = layout.next_id();
        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": "Inertia",
                "componentType": "inertia",
                "params": inertia_params
            },
            "position": layout.next_position()
        }));
    }

    // Named point masses
    let point_masses = find_children(mb, "pointmass");
    for pm in &point_masses {
        let name = get_attr(pm, "name").unwrap_or("").to_string();
        let has_weight = find_child(pm, "weight").is_some();

        // Skip the CG pointmass (no name, no weight)
        if name.is_empty() && !has_weight {
            continue;
        }

        let mut pm_params = json!({});
        if !name.is_empty() {
            pm_params["name"] = json!(name);
        }
        if let Some(wt) = find_child(pm, "weight") {
            if let Some(v) = extract_value_with_unit(wt) {
                pm_params["weight"] = v;
            }
        }
        if let Some(loc) = find_child(pm, "location") {
            if let Some(location) = extract_location(loc) {
                pm_params["location"] = location;
            }
        }

        if pm_params.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            let id = layout.next_id();
            let label = if !name.is_empty() {
                name.clone()
            } else {
                "Point Mass".to_string()
            };
            nodes.push(json!({
                "id": id,
                "type": "aircraftComponent",
                "data": {
                    "label": label,
                    "componentType": "point_mass",
                    "params": pm_params
                },
                "position": layout.next_position()
            }));
        }
    }
}

fn parse_ground_reactions(
    fdm_config: &XmlElement,
    nodes: &mut Vec<Value>,
    layout: &mut LayoutState,
) {
    let gr = match find_child(fdm_config, "ground_reactions") {
        Some(g) => g,
        None => return,
    };

    let contacts = find_children(gr, "contact");
    for contact in &contacts {
        let mut params = json!({});
        let name = get_attr(contact, "name").unwrap_or("").to_string();
        let ctype = get_attr(contact, "type").unwrap_or("BOGEY").to_string();

        if !name.is_empty() {
            params["name"] = json!(name);
        }
        params["type"] = json!(ctype);

        if let Some(loc) = find_child(contact, "location") {
            if let Some(location) = extract_location(loc) {
                params["location"] = location;
            }
        }
        if let Some(elem) = find_child(contact, "static_friction") {
            let text = get_text(elem);
            if let Some(v) = text.parse::<f64>().ok() {
                params["static_friction"] = json!(v);
            }
        }
        if let Some(elem) = find_child(contact, "dynamic_friction") {
            let text = get_text(elem);
            if let Some(v) = text.parse::<f64>().ok() {
                params["dynamic_friction"] = json!(v);
            }
        }
        for field in &["spring_coeff", "damping_coeff", "max_steer"] {
            if let Some(elem) = find_child(contact, field) {
                if let Some(v) = extract_value_with_unit(elem) {
                    params[field] = v;
                }
            }
        }
        if let Some(elem) = find_child(contact, "brake_group") {
            params["brake_group"] = json!(get_text(elem));
        }
        if let Some(elem) = find_child(contact, "retractable") {
            let text = get_text(elem);
            if let Some(v) = text.parse::<f64>().ok() {
                params["retractable"] = json!(v);
            }
        }

        let id = layout.next_id();
        let label = if !name.is_empty() {
            name
        } else {
            "Landing Gear".to_string()
        };
        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": label,
                "componentType": "landing_gear",
                "params": params
            },
            "position": layout.next_position()
        }));
    }
}

fn parse_propulsion(
    fdm_config: &XmlElement,
    nodes: &mut Vec<Value>,
    edges: &mut Vec<Value>,
    layout: &mut LayoutState,
    file_map: &HashMap<String, String>,
) {
    let prop = match find_child(fdm_config, "propulsion") {
        Some(p) => p,
        None => return,
    };

    let mut _engine_ids: Vec<String> = Vec::new();
    let mut _propeller_ids: Vec<String> = Vec::new();
    let mut _tank_ids: Vec<String> = Vec::new();

    // Engines
    let engines = find_children(prop, "engine");
    for eng in &engines {
        let mut eng_params = json!({});
        let inline_name = get_attr(eng, "name").unwrap_or("").to_string();
        if !inline_name.is_empty() {
            eng_params["name"] = json!(inline_name);
        }
        let engine_file = get_attr(eng, "file").unwrap_or("").to_string();

        // Resolve engine file
        if !engine_file.is_empty() {
            if let Some(content) = file_map.get(&engine_file) {
                if let Ok(ref_root) = parse_xml_tree(content) {
                    eng_params["_root_tag"] = json!(ref_root.tag.clone());
                    extract_element_params(&ref_root, &mut eng_params);
                    eng_params["_source_file"] = json!(engine_file);
                    eng_params["file"] = json!(engine_file);

                    // Resolve nested file references (e.g. thruster inside engine)
                    for child in &ref_root.children {
                        if child.tag.starts_with('@') || child.tag == "#text" {
                            continue;
                        }
                        if let Some(nested_file) = get_attr(child, "file") {
                            if let Some(nested_content) = file_map.get(nested_file) {
                                if let Ok(nested_root) = parse_xml_tree(nested_content) {
                                    extract_element_params(&nested_root, &mut eng_params);
                                    eng_params[format!("{}_file", child.tag)] =
                                        json!(nested_file);
                                }
                            }
                        }
                        // Also extract inline params from nested element
                        extract_element_params(child, &mut eng_params);
                    }
                }
            }
        }

        // Map root tag to engine type
        let root_tag = eng_params["_root_tag"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let engine_type = match root_tag.as_str() {
            "piston_engine" => Some("piston"),
            "turbine_engine" => Some("turbine"),
            "turboprop_engine" => Some("turboprop"),
            "rocket_engine" | "FG_ROCKET" => Some("rocket"),
            "electric_engine" => Some("electric"),
            "brushless_dc_motor" => Some("brushless_dc"),
            _ => None,
        };
        if let Some(et) = engine_type {
            eng_params["engine_type"] = json!(et);
        }

        if let Some(feed) = find_child(eng, "feed") {
            eng_params["feed"] = json!(get_text(feed));
        }
        if let Some(loc) = find_child(eng, "location") {
            if let Some(location) = extract_location(loc) {
                eng_params["location"] = location;
            }
        }
        if let Some(orient_elem) = find_child(eng, "orient") {
            if let Some(orient) = extract_orient(orient_elem) {
                eng_params["orient"] = orient;
            }
        }

        // Restore inline name
        if !inline_name.is_empty() {
            eng_params["name"] = json!(inline_name);
        }

        let eng_id = layout.next_id();
        _engine_ids.push(eng_id.clone());

        // Build label
        let eng_type_str = eng_params["engine_type"].as_str().unwrap_or("").to_string();
        let type_icons = match eng_type_str.as_str() {
            "piston" => "🔧",
            "turbine" | "turboprop" => "🔥",
            "rocket" => "🚀",
            "electric" | "brushless_dc" => "⚡",
            _ => "⚙️",
        };
        let type_labels = match eng_type_str.as_str() {
            "piston" => "活塞",
            "turbine" => "涡轮",
            "turboprop" => "涡桨",
            "rocket" => "火箭",
            "electric" => "电动",
            "brushless_dc" => "无刷直流",
            _ => "",
        };
        let eng_name = eng_params["name"]
            .as_str()
            .unwrap_or(if !engine_file.is_empty() {
                &engine_file
            } else {
                "Engine"
            })
            .to_string();
        let label = if !type_labels.is_empty() {
            format!("{} {} [{}]", type_icons, eng_name, type_labels)
        } else {
            format!("{} {}", type_icons, eng_name)
        };

        nodes.push(json!({
            "id": eng_id,
            "type": "aircraftComponent",
            "data": {
                "label": label,
                "componentType": "engine",
                "params": eng_params
            },
            "position": layout.next_position()
        }));

        // Thruster (nested <thruster> inside <engine>)
        if let Some(thruster) = find_child(eng, "thruster") {
            let thruster_file = get_attr(thruster, "file").unwrap_or("").to_string();
            let mut thr_params = json!({});

            if !thruster_file.is_empty() {
                if let Some(content) = file_map.get(&thruster_file) {
                    if let Ok(thr_root) = parse_xml_tree(content) {
                        extract_element_params(&thr_root, &mut thr_params);
                        thr_params["_source_file"] = json!(thruster_file);
                        thr_params["file"] = json!(thruster_file);
                    }
                }
            }

            // Inline tables on thruster
            let (tables_expr, tables_raw) = extract_tables(thruster);
            if !tables_expr.is_empty() {
                thr_params["tables"] = json!(tables_expr);
            }
            if !tables_raw.is_empty() {
                thr_params["_tables"] = json!(tables_raw);
            }

            if let Some(loc) = find_child(thruster, "location") {
                if let Some(location) = extract_location(loc) {
                    thr_params["location"] = location;
                }
            }
            if let Some(orient_elem) = find_child(thruster, "orient") {
                if let Some(orient) = extract_orient(orient_elem) {
                    thr_params["orient"] = orient;
                }
            }
            if let Some(elem) = find_child(thruster, "sense") {
                let text = get_text(elem);
                if let Some(v) = text.parse::<f64>().ok() {
                    thr_params["sense"] = json!(v);
                }
            }
            if let Some(elem) = find_child(thruster, "p_factor") {
                let text = get_text(elem);
                if let Some(v) = text.parse::<f64>().ok() {
                    thr_params["p_factor"] = json!(v);
                }
            }

            // Engine inherits location from thruster if not set
            if eng_params.get("location").is_none() || eng_params["location"].is_null() {
                if let Some(loc) = thr_params.get("location").cloned() {
                    if let Some(eng_obj) = nodes.last_mut().and_then(|n| n.get_mut("data"))
                        .and_then(|d| d.get_mut("params"))
                    {
                        eng_obj["location"] = loc;
                    }
                }
            }

            let thr_name = get_attr(thruster, "name")
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    if !thruster_file.is_empty() {
                        thruster_file.clone()
                    } else if !inline_name.is_empty() {
                        format!("{} 螺旋桨", inline_name)
                    } else {
                        "Propeller".to_string()
                    }
                });

            let thr_id = layout.next_id();
            _propeller_ids.push(thr_id.clone());

            let thr_label = thr_params["name"]
                .as_str()
                .unwrap_or(&thr_name)
                .to_string();

            nodes.push(json!({
                "id": thr_id,
                "type": "aircraftComponent",
                "data": {
                    "label": thr_label,
                    "componentType": "propeller",
                    "params": thr_params
                },
                "position": layout.next_position()
            }));

            // Edge: propeller → engine
            let edge_id = format!("e{}", edges.len() + 1);
            edges.push(json!({
                "id": edge_id,
                "source": thr_id,
                "target": eng_id,
                "sourceHandle": "thrust",
                "targetHandle": "propulsion"
            }));
        }
    }

    // Standalone thrusters
    let thrusters = find_children(prop, "thruster");
    for thr in &thrusters {
        let file = get_attr(thr, "file").unwrap_or("").to_string();
        let mut params = json!({});

        if !file.is_empty() {
            if let Some(content) = file_map.get(&file) {
                if let Ok(thr_root) = parse_xml_tree(content) {
                    extract_element_params(&thr_root, &mut params);
                    params["_source_file"] = json!(file);
                }
            }
        }

        let (tables_expr, tables_raw) = extract_tables(thr);
        if !tables_expr.is_empty() {
            params["tables"] = json!(tables_expr);
        }
        if !tables_raw.is_empty() {
            params["_tables"] = json!(tables_raw);
        }

        if let Some(loc) = find_child(thr, "location") {
            if let Some(location) = extract_location(loc) {
                params["location"] = location;
            }
        }
        if let Some(elem) = find_child(thr, "sense") {
            let text = get_text(elem);
            if let Some(v) = text.parse::<f64>().ok() {
                params["sense"] = json!(v);
            }
        }
        if let Some(elem) = find_child(thr, "p_factor") {
            let text = get_text(elem);
            if let Some(v) = text.parse::<f64>().ok() {
                params["p_factor"] = json!(v);
            }
        }

        let id = layout.next_id();
        _propeller_ids.push(id.clone());

        let label = params["name"]
            .as_str()
            .unwrap_or(if !file.is_empty() { &file } else { "Propeller" })
            .to_string();

        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": label,
                "componentType": "propeller",
                "params": params
            },
            "position": layout.next_position()
        }));
    }

    // Fuel tanks
    let tanks = find_children(prop, "tank");
    for tank in &tanks {
        let mut params = json!({});
        let name = get_attr(tank, "name").unwrap_or("").to_string();
        if !name.is_empty() {
            params["name"] = json!(name);
        }
        if let Some(loc) = find_child(tank, "location") {
            if let Some(location) = extract_location(loc) {
                params["location"] = location;
            }
        }
        if let Some(elem) = find_child(tank, "capacity") {
            if let Some(v) = extract_value_with_unit(elem) {
                params["capacity"] = v;
            }
        }
        if let Some(elem) = find_child(tank, "contents") {
            if let Some(v) = extract_value_with_unit(elem) {
                params["contents"] = v;
            }
        }

        let id = layout.next_id();
        _tank_ids.push(id.clone());

        let label = if !name.is_empty() {
            name
        } else {
            "Fuel Tank".to_string()
        };

        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": label,
                "componentType": "fuel_tank",
                "params": params
            },
            "position": layout.next_position()
        }));
    }
}

/// Extract numeric params from an XML element (for propulsion sub-files).
fn extract_element_params(el: &XmlElement, merged: &mut Value) {
    if let Some(name) = get_attr(el, "name") {
        merged["name"] = json!(name);
    }

    for child in &el.children {
        if child.tag.starts_with('@') || child.tag == "#text" || child.tag == "table" {
            continue;
        }

        let text = get_text(child);
        if let Some(v) = text.parse::<f64>().ok() {
            merged[&child.tag] = json!(v);
        } else if !text.is_empty() {
            merged[&child.tag] = json!(text);
        }

        if let Some(unit) = get_attr(child, "unit") {
            merged[format!("{}_unit", child.tag)] = json!(unit);
        }
    }

    let (tables_expr, tables_raw) = extract_tables(el);
    if !tables_expr.is_empty() {
        merged["tables"] = json!(tables_expr);
    }
    if !tables_raw.is_empty() {
        merged["_tables"] = json!(tables_raw);
    }
}

fn parse_component_section(
    fdm_config: &XmlElement,
    nodes: &mut Vec<Value>,
    _edges: &mut Vec<Value>,
    section_key: &str,
    component_type: &str,
    _file_map: &HashMap<String, String>,
    layout: &mut LayoutState,
) {
    let elements = find_children(fdm_config, section_key);
    for el in &elements {
        let file = get_attr(el, "file").unwrap_or("").to_string();
        let mut params = json!({});
        if !file.is_empty() {
            params["file"] = json!(file);
        }

        let sys_def = el;

        if let Some(name) = get_attr(sys_def, "name") {
            params["name"] = json!(name);
        }

        // Parse channels
        let channels = find_children(sys_def, "channel");
        let mut channel_data: Vec<Value> = Vec::new();

        for ch in &channels {
            let ch_name = get_attr(ch, "name").unwrap_or("").to_string();
            let mut ch_items: Vec<Value> = Vec::new();

            // Extract functions from channel
            for fk in &["function", "fcs_function"] {
                let funcs = find_children(ch, fk);
                for f in &funcs {
                    let f_name = get_attr(f, "name").unwrap_or("").to_string();
                    let body = if *fk == "fcs_function" {
                        find_child(f, "function").unwrap_or(f)
                    } else {
                        *f
                    };

                    let expression = xml_to_expr(body);
                    let expr_val = serde_json::to_value(&expression).unwrap_or(json!({"kind": "value", "value": 0}));

                    let mut item = json!({
                        "type": fk,
                        "name": f_name,
                        "expression": expr_val
                    });

                    // Sibling <clipto>
                    if let Some(clip) = find_child(f, "clipto") {
                        if let Some(min_elem) = find_child(clip, "min") {
                            item["cliptoMin"] = json!(get_text(min_elem));
                        }
                        if let Some(max_elem) = find_child(clip, "max") {
                            item["cliptoMax"] = json!(get_text(max_elem));
                        }
                    }

                    ch_items.push(item);
                }
            }

            // Extract other channel elements
            for child in &ch.children {
                if child.tag.starts_with('@')
                    || child.tag == "#text"
                    || child.tag == "function"
                    || child.tag == "fcs_function"
                {
                    continue;
                }

                let item_name = get_attr(child, "name").unwrap_or("").to_string();
                let mut ch_item = json!({
                    "type": child.tag,
                    "name": item_name
                });

                // Extract component-specific properties
                let mut props = json!({});

                let known_fields = [
                    "input", "output", "gain", "test", "default", "trigger",
                    "lag", "noise", "drift_rate", "bias", "width", "rate_limit",
                    "traverse", "quantization", "hysteresis", "sensitivity",
                    "constant", "clipto", "min", "max", "c1", "c2", "c3", "c4", "c5", "c6",
                    "kp", "ki", "kd",
                ];

                // Handle clipto
                if let Some(clip) = find_child(child, "clipto") {
                    if let Some(min_elem) = find_child(clip, "min") {
                        props["clipto_min"] = json!({
                            "value": get_text(min_elem),
                            "attrs": {}
                        });
                    }
                    if let Some(max_elem) = find_child(clip, "max") {
                        props["clipto_max"] = json!({
                            "value": get_text(max_elem),
                            "attrs": {}
                        });
                    }
                }

                for field in &known_fields {
                    if *field == "clipto" {
                        continue;
                    }
                    if let Some(field_elem) = find_child(child, field) {
                        let text = get_text(field_elem);
                        let mut field_attrs = json!({});
                        for (ak, av) in &field_elem.attrs {
                            field_attrs[ak] = json!(av);
                        }
                        props[*field] = json!({
                            "value": text,
                            "attrs": field_attrs
                        });
                    }
                }

                // Extract <property> children
                let prop_children = find_children(child, "property");
                if !prop_children.is_empty() {
                    let prop_names: Vec<String> = prop_children
                        .iter()
                        .map(|p| {
                            get_attr(p, "name")
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| get_text(p))
                        })
                        .filter(|s| !s.is_empty())
                        .collect();
                    if !prop_names.is_empty() {
                        props["properties"] = json!(prop_names);
                    }
                }

                // Normalize multiple <input>/<gain> children (summer pattern)
                let raw_inputs: Vec<String> = find_children(child, "input")
                    .iter()
                    .map(|i| extract_signal_name(i))
                    .filter(|s| !s.is_empty())
                    .collect();
                let raw_gains: Vec<String> = find_children(child, "gain")
                    .iter()
                    .map(|g| get_text(g))
                    .filter(|s| !s.is_empty())
                    .collect();

                if raw_inputs.len() > 1 {
                    props["inputs"] = json!(raw_inputs);
                    let gains: Vec<Option<String>> = raw_inputs
                        .iter()
                        .enumerate()
                        .map(|(i, _)| {
                            if i == 0 {
                                None
                            } else {
                                raw_gains.get(i - 1).map(|s| s.to_string())
                            }
                        })
                        .collect();
                    props["gains"] = json!(gains);
                    // Remove singular input/gain
                    if let Some(obj) = props.as_object_mut() {
                        obj.remove("input");
                        obj.remove("gain");
                    }
                }

                if props.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                    ch_item["componentProps"] = props;
                }

                // Try expression
                let expression = xml_to_expr(child);
                let expr_val = serde_json::to_value(&expression).unwrap_or(json!({"kind": "value", "value": 0}));
                ch_item["expression"] = expr_val;

                ch_items.push(ch_item);
            }

            if !ch_name.is_empty() || !ch_items.is_empty() {
                channel_data.push(json!({
                    "name": ch_name,
                    "items": ch_items
                }));
            }
        }

        if !channel_data.is_empty() {
            params["channels"] = json!(serde_json::to_string(&channel_data).unwrap_or_default());
        }

        // Top-level functions (no enclosing channel)
        if channel_data.is_empty() {
            let mut top_func_items: Vec<Value> = Vec::new();
            for fk in &["function", "fcs_function"] {
                let top_funcs = find_children(sys_def, fk);
                for f in &top_funcs {
                    let f_name = get_attr(f, "name").unwrap_or("").to_string();
                    if f_name.is_empty() {
                        continue;
                    }
                    let body = if *fk == "fcs_function" {
                        find_child(f, "function").unwrap_or(f)
                    } else {
                        *f
                    };
                    let expression = xml_to_expr(body);
                    let expr_val = serde_json::to_value(&expression).unwrap_or(json!({"kind": "value", "value": 0}));
                    top_func_items.push(json!({
                        "type": fk,
                        "name": f_name,
                        "expression": expr_val
                    }));
                }
            }
            if !top_func_items.is_empty() {
                let ch_data = vec![json!({ "name": "", "items": top_func_items })];
                params["channels"] = json!(serde_json::to_string(&ch_data).unwrap_or_default());
            }
        }

        // System properties
        let sys_props = find_children(sys_def, "property");
        if !sys_props.is_empty() {
            let prop_names: Vec<String> = sys_props
                .iter()
                .map(|p| {
                    get_attr(p, "name")
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| get_text(p))
                })
                .filter(|s| !s.is_empty())
                .collect();
            if !prop_names.is_empty() {
                params["properties"] = json!(prop_names.join(","));
            }
        }

        // Tables
        let (tables_expr, tables_raw) = extract_tables(sys_def);
        if !tables_expr.is_empty() {
            params["tables"] = json!(tables_expr);
        }
        if !tables_raw.is_empty() {
            params["_tables"] = json!(tables_raw);
        }

        let id = layout.next_id();
        let label = if let Some(name) = get_attr(sys_def, "name") {
            name.to_string()
        } else if !file.is_empty() {
            file.clone()
        } else if component_type == "flight_control" {
            "Flight Control".to_string()
        } else {
            "System".to_string()
        };

        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": label,
                "componentType": component_type,
                "params": params
            },
            "position": layout.next_position()
        }));
    }
}

fn parse_aerodynamics(
    fdm_config: &XmlElement,
    nodes: &mut Vec<Value>,
    _edges: &mut Vec<Value>,
    layout: &mut LayoutState,
) {
    let aero = match find_child(fdm_config, "aerodynamics") {
        Some(a) => a,
        None => return,
    };

    let mut coefficients: Vec<Value> = Vec::new();
    let axes = find_children(aero, "axis");

    for axis in &axes {
        let axis_name = get_attr(axis, "name")
            .unwrap_or("LIFT")
            .to_uppercase();
        let functions = find_children(axis, "function");

        for func in &functions {
            let name = get_attr(func, "name").unwrap_or("").to_string();
            let description = find_child(func, "description")
                .map(|d| get_text(d))
                .unwrap_or_default();

            let expression = xml_to_expr(func);

            let is_nonzero = match &expression {
                ExprNode::Value { value } => *value != 0.0,
                _ => true,
            };

            if !name.is_empty() || is_nonzero {
                let expr_val = serde_json::to_value(&expression)
                    .unwrap_or(json!({"kind": "value", "value": 0}));
                coefficients.push(json!({
                    "name": name,
                    "description": description,
                    "axis": axis_name,
                    "expression": expr_val
                }));
            }
        }
    }

    // Also parse top-level functions (not inside axes)
    let top_functions = find_children(aero, "function");
    for func in &top_functions {
        let name = get_attr(func, "name").unwrap_or("").to_string();
        let description = find_child(func, "description")
            .map(|d| get_text(d))
            .unwrap_or_default();

        let expression = xml_to_expr(func);
        let is_nonzero = match &expression {
            ExprNode::Value { value } => *value != 0.0,
            _ => true,
        };

        if !name.is_empty() || is_nonzero {
            let expr_val = serde_json::to_value(&expression)
                .unwrap_or(json!({"kind": "value", "value": 0}));
            coefficients.push(json!({
                "name": name,
                "description": description,
                "axis": "",
                "expression": expr_val
            }));
        }
    }

    if !coefficients.is_empty() {
        let id = layout.next_id();
        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": "Aero Coefficients",
                "componentType": "aero_coefficients",
                "params": {
                    "coefficients": serde_json::to_string(&coefficients).unwrap_or_default()
                }
            },
            "position": layout.next_position()
        }));
    }
}

fn parse_output(fdm_config: &XmlElement, nodes: &mut Vec<Value>, layout: &mut LayoutState) {
    let outputs = find_children(fdm_config, "output");
    for out in &outputs {
        let mut params = json!({});
        params["name"] = json!(get_attr(out, "name").unwrap_or("localhost"));
        params["type"] = json!(get_attr(out, "type").unwrap_or("SOCKET"));
        if let Some(port) = get_attr(out, "port").and_then(|s| s.parse::<f64>().ok()) {
            params["port"] = json!(port);
        }
        if let Some(rate) = get_attr(out, "rate").and_then(|s| s.parse::<f64>().ok()) {
            params["rate"] = json!(rate);
        }

        let data_groups = [
            "simulation", "atmosphere", "massprops", "rates", "velocities", "forces", "moments",
            "position", "propulsion", "aerosurfaces", "fcs", "ground_reactions", "coefficients",
        ];
        for group in &data_groups {
            if let Some(elem) = find_child(out, group) {
                let text = get_text(elem);
                params[*group] = json!(if text.is_empty() { "OFF" } else { &text });
            }
        }

        let properties = find_children(out, "property");
        if !properties.is_empty() {
            let prop_names: Vec<String> = properties
                .iter()
                .map(|p| get_text(p))
                .filter(|s| !s.is_empty())
                .collect();
            if !prop_names.is_empty() {
                params["properties"] = json!(prop_names.join(","));
            }
        }

        let id = layout.next_id();
        let name = params["name"].as_str().unwrap_or("localhost");
        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": format!("Output: {}", name),
                "componentType": "output",
                "params": params
            },
            "position": layout.next_position()
        }));
    }
}

// ── Logical edges ──────────────────────────────────────────────────────────

fn create_logical_edges(nodes: &[Value], edges: &mut Vec<Value>) {
    // Group nodes by componentType
    let mut by_type: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        let ct = node
            .get("data")
            .and_then(|d| d.get("componentType"))
            .and_then(|v| v.as_str())
            .unwrap_or("other")
            .to_string();
        by_type.entry(ct).or_default().push(i);
    }

    let mut edge_set: std::collections::HashSet<String> = edges
        .iter()
        .filter_map(|e| {
            let src = e.get("source")?.as_str()?;
            let tgt = e.get("target")?.as_str()?;
            Some(format!("{}->{}", src, tgt))
        })
        .collect();

    let mut edge_counter = edges.len();

    let mut add_edge = |source: &str, target: &str, sh: &str, th: &str| {
        let key = format!("{}->{}", source, target);
        if edge_set.insert(key) {
            edge_counter += 1;
            edges.push(json!({
                "id": format!("e{}", edge_counter),
                "source": source,
                "target": target,
                "sourceHandle": sh,
                "targetHandle": th
            }));
        }
    };

    let get_node_id = |idx: usize| -> Option<String> {
        nodes.get(idx)?.get("id")?.as_str().map(|s| s.to_string())
    };

    let fuselage_nodes = by_type.get("fuselage").cloned().unwrap_or_default();
    let wing_nodes = by_type.get("wing").cloned().unwrap_or_default();
    let inertia_nodes = by_type.get("inertia").cloned().unwrap_or_default();
    let gear_nodes = by_type.get("landing_gear").cloned().unwrap_or_default();
    let engine_nodes = by_type.get("engine").cloned().unwrap_or_default();
    let tank_nodes = by_type.get("fuel_tank").cloned().unwrap_or_default();

    // Wing → Fuselage
    if let Some(&fus_idx) = fuselage_nodes.first() {
        if let Some(fus_id) = get_node_id(fus_idx) {
            for &w_idx in &wing_nodes {
                if let Some(w_id) = get_node_id(w_idx) {
                    add_edge(&w_id, &fus_id, "metrics", "metrics");
                }
            }
            for &i_idx in &inertia_nodes {
                if let Some(i_id) = get_node_id(i_idx) {
                    add_edge(&i_id, &fus_id, "mass", "mass");
                }
            }
            for &g_idx in &gear_nodes {
                if let Some(g_id) = get_node_id(g_idx) {
                    add_edge(&g_id, &fus_id, "gear", "structure");
                }
            }
        }
    }

    // Fuel tanks → first engine
    if let Some(&eng_idx) = engine_nodes.first() {
        if let Some(eng_id) = get_node_id(eng_idx) {
            for &t_idx in &tank_nodes {
                if let Some(t_id) = get_node_id(t_idx) {
                    add_edge(&t_id, &eng_id, "fuel", "propulsion");
                }
            }
        }
    }
}

// ── Location-based layout ──────────────────────────────────────────────────

fn apply_location_layout(nodes: &mut [Value]) {
    let mut located: Vec<(usize, f64, f64, f64, String)> = Vec::new();
    let mut unlocated: Vec<usize> = Vec::new();

    for (i, node) in nodes.iter().enumerate() {
        let params = node
            .get("data")
            .and_then(|d| d.get("params"));
        let location = params.and_then(|p| p.get("location"));

        if let Some(loc) = location {
            let x = loc.get("x").and_then(|v| v.as_f64());
            let y = loc.get("y").and_then(|v| v.as_f64());
            let z = loc.get("z").and_then(|v| v.as_f64());
            let unit = loc
                .get("unit")
                .and_then(|v| v.as_str())
                .unwrap_or("IN")
                .to_string();

            if x.is_some() && y.is_some() {
                located.push((i, x.unwrap(), y.unwrap(), z.unwrap_or(0.0), unit));
                continue;
            }
        }
        unlocated.push(i);
    }

    if located.is_empty() {
        // No location data — arrange by category
        let node_h = 80.0;
        let gap_y = 20.0;
        let start_x = 100.0;

        let mut by_type: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, node) in nodes.iter().enumerate() {
            let ct = node
                .get("data")
                .and_then(|d| d.get("componentType"))
                .and_then(|v| v.as_str())
                .unwrap_or("other")
                .to_string();
            by_type.entry(ct).or_default().push(i);
        }

        let type_order = [
            "wing", "fuselage", "inertia", "landing_gear", "engine", "propeller", "fuel_tank",
            "point_mass", "system", "output", "aero_coefficients",
        ];

        let mut cur_y = 100.0;
        for t in &type_order {
            if let Some(indices) = by_type.get(*t) {
                for &idx in indices {
                    if let Some(pos) = nodes[idx].get_mut("position") {
                        *pos = json!({ "x": start_x, "y": cur_y });
                    }
                    cur_y += node_h + gap_y;
                }
                cur_y += gap_y;
            }
        }
        return;
    }

    // Convert units to inches
    fn to_inches(val: f64, unit: &str) -> f64 {
        match unit {
            "M" | "MTR" => val * 39.3701,
            "CM" => val * 0.393701,
            "FT" => val * 12.0,
            _ => val,
        }
    }

    let located_norm: Vec<(usize, f64, f64)> = located
        .iter()
        .map(|(idx, x, y, _z, unit)| (*idx, to_inches(*x, unit), to_inches(*y, unit)))
        .collect();

    // Find bounding box
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for (_, x, y) in &located_norm {
        min_x = min_x.min(*x);
        max_x = max_x.max(*x);
        min_y = min_y.min(*y);
        max_y = max_y.max(*y);
    }

    let range_x = (max_x - min_x).max(1.0);
    let range_y = (max_y - min_y).max(1.0);
    let scale = (400.0 / range_x).max(300.0 / range_y).max(1.5);

    let margin = 120.0;
    let w = (range_y * scale).max(400.0);
    let h = (range_x * scale).max(300.0);

    for (idx, x, y) in &located_norm {
        let norm_y = (y - min_y) / range_y;
        let norm_x = (x - min_x) / range_x;
        let screen_x = margin + norm_y * w;
        let screen_y = margin + (1.0 - norm_x) * h;
        if let Some(pos) = nodes[*idx].get_mut("position") {
            *pos = json!({ "x": screen_x.round(), "y": screen_y.round() });
        }
    }

    // Position unlocated nodes on the right side
    let max_located_x = located_norm
        .iter()
        .filter_map(|(idx, _, _)| {
            nodes[*idx]
                .get("position")
                .and_then(|p| p.get("x"))
                .and_then(|v| v.as_f64())
        })
        .fold(0.0f64, f64::max);

    let node_w = 250.0;
    let node_h = 100.0;
    let gap_y = 20.0;
    let start_x = (max_located_x + node_w + 120.0).max(600.0);
    let col2_x = start_x + node_w + 40.0;

    let mut by_type: HashMap<String, Vec<usize>> = HashMap::new();
    for &idx in &unlocated {
        let ct = nodes[idx]
            .get("data")
            .and_then(|d| d.get("componentType"))
            .and_then(|v| v.as_str())
            .unwrap_or("other")
            .to_string();
        by_type.entry(ct).or_default().push(idx);
    }

    let type_order = [
        "wing", "fuselage", "inertia", "landing_gear", "engine", "propeller", "fuel_tank",
        "point_mass", "system", "output", "aero_coefficients",
    ];

    let mut ordered: Vec<usize> = Vec::new();
    for t in &type_order {
        if let Some(indices) = by_type.get(*t) {
            ordered.extend(indices);
        }
    }
    // Remaining types
    for (t, indices) in &by_type {
        if !type_order.contains(&t.as_str()) {
            ordered.extend(indices);
        }
    }

    let mut cur_y1 = 100.0;
    let mut cur_y2 = 100.0;

    for &idx in &ordered {
        if cur_y1 <= cur_y2 {
            if let Some(pos) = nodes[idx].get_mut("position") {
                *pos = json!({ "x": start_x, "y": cur_y1 });
            }
            cur_y1 += node_h + gap_y;
        } else {
            if let Some(pos) = nodes[idx].get_mut("position") {
                *pos = json!({ "x": col2_x, "y": cur_y2 });
            }
            cur_y2 += node_h + gap_y;
        }
    }
}

// ── Section file resolver ──────────────────────────────────────────────────

fn resolve_section_files(
    fdm_config: &XmlElement,
    file_map: &HashMap<String, String>,
) -> XmlElement {
    let section_names = [
        "metrics", "mass_balance", "ground_reactions", "propulsion", "aerodynamics",
        "flight_control", "system", "output",
    ];

    let mut resolved = fdm_config.clone();

    for section in &section_names {
        let mut new_children = Vec::new();
        for child in &resolved.children {
            if child.tag == *section {
                if let Some(file) = get_attr(child, "file") {
                    if let Some(content) = file_map.get(file) {
                        if let Ok(ref_root) = parse_xml_tree(content) {
                            // The sub-file root should be the section element
                            if ref_root.tag == *section {
                                let mut merged = ref_root.clone();
                                // Copy attributes from the reference element (except file)
                                for (k, v) in &child.attrs {
                                    if k != "file" {
                                        merged.attrs.insert(k.clone(), v.clone());
                                    }
                                }
                                new_children.push(merged);
                                continue;
                            }
                        }
                    }
                }
            }
            new_children.push(child.clone());
        }
        resolved.children = new_children;
    }

    resolved
}

// ── Aircraft type detection ────────────────────────────────────────────────

fn detect_aircraft_type(xml: &str, file_map: &HashMap<String, String>) -> String {
    let combined_files: String = file_map.values().cloned().collect::<Vec<_>>().join("\n");
    let combined = format!("{}\n{}", xml, combined_files);

    let has_wing = combined.contains("<wing ") || combined.contains("<wing>");

    if combined.contains("brushless_dc_motor") {
        "multirotor".to_string()
    } else if combined.contains("electric_engine") && !has_wing {
        "multirotor".to_string()
    } else if combined.contains("<rotor") || combined.contains("rotor>") {
        "helicopter".to_string()
    } else {
        "fixed_wing".to_string()
    }
}

// ── Main parser ────────────────────────────────────────────────────────────

/// Parse a JSBSim aircraft XML string into a JSON graph (aircraft, nodes, edges).
pub fn parse_xml(xml: &str, file_map: &HashMap<String, String>) -> Result<Value, String> {
    if xml.is_empty() {
        return Err("Invalid XML input".to_string());
    }

    let root = parse_xml_tree(xml)?;

    // Find the root fdm_config element
    let fdm_config_raw = if root.tag == "fdm_config" || root.tag == "fdm_configuration" {
        &root
    } else {
        // Try to find fdm_config as a child
        find_child(&root, "fdm_config")
            .or_else(|| find_child(&root, "fdm_configuration"))
            .ok_or_else(|| "No fdm_config element found in XML".to_string())?
    };

    // Resolve section-level file references
    let fdm_config = resolve_section_files(fdm_config_raw, file_map);

    // Extract aircraft metadata
    let mut aircraft = json!({
        "name": get_attr(&fdm_config, "name").unwrap_or("Unnamed Aircraft"),
        "version": get_attr(&fdm_config, "version").unwrap_or("1.0"),
        "release": get_attr(&fdm_config, "release").unwrap_or("")
    });

    // Detect aircraft type
    let aircraft_type = detect_aircraft_type(xml, file_map);
    aircraft["type"] = json!(aircraft_type);

    let mut layout = LayoutState::new();
    let mut nodes: Vec<Value> = Vec::new();
    let mut edges: Vec<Value> = Vec::new();

    // Parse each section
    parse_file_header(&fdm_config, &mut aircraft);
    parse_metrics(&fdm_config, &mut nodes, &mut layout);
    parse_mass_balance(&fdm_config, &mut nodes, &mut layout);
    parse_ground_reactions(&fdm_config, &mut nodes, &mut layout);
    parse_propulsion(&fdm_config, &mut nodes, &mut edges, &mut layout, file_map);
    parse_component_section(
        &fdm_config,
        &mut nodes,
        &mut edges,
        "system",
        "system",
        file_map,
        &mut layout,
    );
    parse_component_section(
        &fdm_config,
        &mut nodes,
        &mut edges,
        "flight_control",
        "flight_control",
        file_map,
        &mut layout,
    );
    parse_aerodynamics(&fdm_config, &mut nodes, &mut edges, &mut layout);
    parse_output(&fdm_config, &mut nodes, &mut layout);

    // Create logical edges
    create_logical_edges(&nodes, &mut edges);

    // Apply location-based layout
    apply_location_layout(&mut nodes);

    Ok(json!({
        "aircraft": aircraft,
        "nodes": nodes,
        "edges": edges
    }))
}
