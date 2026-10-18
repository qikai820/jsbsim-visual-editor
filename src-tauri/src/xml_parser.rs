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
        /* fileheader/version is the historical source-file revision (for
         * example "$Revision: 1.91 $").  It is not the JSBSim aircraft
         * configuration version.  Keep the root fdm_config version, which
         * must remain 2.0 for the current loader. */
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

    for field in &["wingarea", "wingspan", "chord", "wing_incidence"] {
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

    // Tail metrics are separate components in the editor.  Keeping them on
    // the wing node makes a load -> save -> load cycle silently delete the
    // htail/vtail nodes from the graph.
    for (component_type, label, area, arm) in [
        ("htail", "H-Tail", "htailarea", "htailarm"),
        ("vtail", "V-Tail", "vtailarea", "vtailarm"),
    ] {
        let mut tail_params = json!({});
        if let Some(elem) = find_child(metrics, area) {
            if let Some(value) = extract_value_with_unit(elem) {
                tail_params[area] = value;
            }
        }
        if let Some(elem) = find_child(metrics, arm) {
            if let Some(value) = extract_value_with_unit(elem) {
                tail_params[arm] = value;
            }
        }
        if tail_params.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            nodes.push(json!({
                "id": layout.next_id(),
                "type": "aircraftComponent",
                "data": {
                    "label": label,
                    "componentType": component_type,
                    "params": tail_params
                },
                "position": layout.next_position()
            }));
        }
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
        if let Some(elem) = find_child(contact, "rolling_friction") {
            let text = get_text(elem);
            if let Ok(v) = text.parse::<f64>() {
                params["rolling_friction"] = json!(v);
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
            // Preserve ownership for edits made in the signal-flow editor.
            // This is an external systems/flight_control XML, not the
            // aircraft's main XML.
            params["_source_file"] = json!(file);
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
                    if *fk == "fcs_function" {
                        if let Some(output) = find_child(f, "output") {
                            item["output"] = json!(get_text(output));
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
                    "lag", "noise", "drift_rate", "bias", "delay", "width", "rate_limit",
                    "traverse", "quantization", "hysteresis", "sensitivity",
                    "constant", "clipto", "domain", "range", "zero_centered", "min", "max", "c1", "c2", "c3", "c4", "c5", "c6",
                    "kp", "ki", "kd", "axis", "location", "orientation",
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
                        if !field_elem.children.is_empty() {
                            props[*field]["children"] = json!(field_elem.children.iter()
                                .filter(|nested| !nested.tag.starts_with('@') && nested.tag != "#text")
                                .map(|nested| json!({
                                    "name": nested.tag,
                                    "value": get_text(nested),
                                    "attrs": nested.attrs
                                })).collect::<Vec<_>>());
                        }
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
                    "attrs": ch.attrs.iter().filter(|(key, _)| key.as_str() != "name")
                        .map(|(key, value)| (key.clone(), json!(value))).collect::<serde_json::Map<_, _>>(),
                    "items": ch_items
                }));
            }
        }

        if !channel_data.is_empty() {
            params["channels"] = json!(serde_json::to_string(&channel_data).unwrap_or_default());
        }

        // Top-level functions must remain top-level even when channels also
        // exist (all PX4 sensor models use both forms).
        {
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
                params["topLevelItems"] = json!(serde_json::to_string(&top_func_items).unwrap_or_default());
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
            params["propertyDefinitions"] = json!(serde_json::to_string(&sys_props.iter().map(|property| json!({
                "name": get_text(property),
                "attrs": property.attrs
            })).collect::<Vec<_>>()).unwrap_or_default());
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
        let is_uavcan = get_attr(out, "type") == Some("UAVCAN");
        let is_serial_hil = get_attr(out, "transport") == Some("SERIAL") &&
            matches!(get_attr(out, "type"), Some("HIL_SENSOR") | Some("HIL_GPS")) &&
            get_attr(out, "editor_module") != Some("output");
        if get_attr(out, "transport") == Some("SERIAL") {
            params["transport"] = json!("SERIAL");
        }
        if let Some(host) = get_attr(out, "host") { params["host"] = json!(host); }
        if get_attr(out, "editor_module") == Some("output") || is_serial_hil {
            for key in ["device", "baud"] {
                if let Some(value) = get_attr(out, key) { params[key] = json!(value); }
            }
        }
        if is_serial_hil {
            for key in ["device", "baud", "data_bits", "parity", "stop_bits", "flow_control",
                        "mavlink_version", "system_id", "component_id"] {
                if let Some(value) = get_attr(out, key) { params[key] = json!(value); }
            }
        }
        if is_uavcan {
            for key in ["interface", "node_id", "subject_id", "dsdl_path", "dsdl_type", "sensor_type"] {
                if let Some(value) = get_attr(out, key) {
                    params[key] = json!(value);
                }
            }
        }
        if let Some(port) = get_attr(out, "port").and_then(|s| s.parse::<i64>().ok()) {
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
                if get_attr(out, "type") == Some("HIL_SENSOR") && prop_names.len() >= 12 {
                    for (key, property) in [
                        "hil_imu_accel_x", "hil_imu_accel_y", "hil_imu_accel_z",
                        "hil_imu_gyro_x", "hil_imu_gyro_y", "hil_imu_gyro_z",
                        "hil_imu_mag_x", "hil_imu_mag_y", "hil_imu_mag_z",
                        "hil_pressure_abs", "hil_pressure_diff", "hil_pressure_alt",
                    ].iter().zip(&prop_names) {
                        params[*key] = json!(property);
                    }
                } else if get_attr(out, "type") == Some("HIL_GPS") && prop_names.len() >= 6 {
                    let velocity_offset = if prop_names.len() >= 8 { 5 } else { 3 };
                    for (key, property) in [
                        ("hil_gps_lat", &prop_names[0]),
                        ("hil_gps_lon", &prop_names[1]),
                        ("hil_gps_alt", &prop_names[2]),
                        ("hil_gps_vn", &prop_names[velocity_offset]),
                        ("hil_gps_ve", &prop_names[velocity_offset + 1]),
                        ("hil_gps_vd", &prop_names[velocity_offset + 2]),
                    ] {
                        params[key] = json!(property);
                    }
                } else if get_attr(out, "type") == Some("VIZTRA_UDP_JSON") && prop_names.len() == 3 {
                    for (key, property) in ["viztra_north", "viztra_east", "viztra_down"]
                        .iter().zip(&prop_names) {
                        params[*key] = json!(property);
                    }
                }
            }
        }

        if is_serial_hil {
            let property_key = if get_attr(out, "type") == Some("HIL_GPS") {
                params["gps_rate"] = params.get("rate").cloned().unwrap_or(json!(10));
                "gps_properties"
            } else {
                params["sensor_rate"] = params.get("rate").cloned().unwrap_or(json!(250));
                "sensor_properties"
            };
            params[property_key] = params.get("properties").cloned().unwrap_or(json!(""));
            if let Some(existing) = nodes.iter_mut().find(|node|
                node["data"]["componentType"] == "serial_hil" &&
                node["data"]["params"]["device"] == params["device"])
            {
                if let (Some(target), Some(source)) =
                    (existing["data"]["params"].as_object_mut(), params.as_object()) {
                    for (key, value) in source { target.insert(key.clone(), value.clone()); }
                }
            } else {
                let id = layout.next_id();
                nodes.push(json!({"id": id, "type": "aircraftComponent",
                    "data": {"label": "PX4 Serial HIL", "componentType": "serial_hil", "params": params},
                    "position": layout.next_position()}));
            }
            continue;
        }

        let id = layout.next_id();
        let name = params["name"].as_str().unwrap_or("localhost");
        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": format!("Output: {}", name),
                "componentType": if is_uavcan { "uavcan" } else { "output" },
                "params": params
            },
            "position": layout.next_position()
        }));
    }
}

fn parse_input(fdm_config: &XmlElement, nodes: &mut Vec<Value>, layout: &mut LayoutState) {
    for input in find_children(fdm_config, "input") {
        let mut params = json!({
            "name": get_attr(input, "name").unwrap_or("0.0.0.0"),
            "type": get_attr(input, "type").unwrap_or("SOCKET")
        });
        if let Some(port) = get_attr(input, "port").and_then(|value| value.parse::<i64>().ok()) {
            params["port"] = json!(port);
        }
        if let Some(rate) = get_attr(input, "rate").and_then(|value| value.parse::<f64>().ok()) {
            params["rate"] = json!(rate);
        }
        let properties: Vec<String> = find_children(input, "property")
            .iter()
            .map(|property| get_text(property))
            .filter(|property| !property.is_empty())
            .collect();
        let is_serial_hil = get_attr(input, "transport") == Some("SERIAL") &&
            get_attr(input, "type") == Some("HIL_ACTUATOR_CONTROLS") &&
            get_attr(input, "editor_module") != Some("input");
        if get_attr(input, "transport") == Some("SERIAL") {
            params["transport"] = json!("SERIAL");
            for key in ["device", "baud"] {
                if let Some(value) = get_attr(input, key) { params[key] = json!(value); }
            }
        }
        if is_serial_hil {
            for key in ["device", "baud", "data_bits", "parity", "stop_bits", "flow_control", "mavlink_version"] {
                if let Some(value) = get_attr(input, key) { params[key] = json!(value); }
            }
            params["actuator_properties"] = json!(properties.join(","));
            if let Some(existing) = nodes.iter_mut().find(|node|
                node["data"]["componentType"] == "serial_hil" &&
                node["data"]["params"]["device"] == params["device"])
            {
                if let (Some(target), Some(source)) =
                    (existing["data"]["params"].as_object_mut(), params.as_object()) {
                    for (key, value) in source { target.insert(key.clone(), value.clone()); }
                }
            } else {
                let id = layout.next_id();
                nodes.push(json!({"id": id, "type": "aircraftComponent",
                    "data": {"label": "PX4 Serial HIL", "componentType": "serial_hil", "params": params},
                    "position": layout.next_position()}));
            }
            continue;
        }
        if !properties.is_empty() {
            params["properties"] = json!(properties.join(","));
        }
        let id = layout.next_id();
        let name = params["name"].as_str().unwrap_or("0.0.0.0");
        nodes.push(json!({
            "id": id,
            "type": "aircraftComponent",
            "data": {
                "label": format!("Input: {}", name),
                "componentType": "input",
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
            "point_mass", "system", "input", "output", "aero_coefficients",
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
        "point_mass", "system", "input", "output", "aero_coefficients",
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

/// Add the two presentation-only JSBSim dynamics cards after parsing. These
/// are always part of FGFDMExec, even if no Aero component or model is
/// available. Keeping this in the parser is deliberate: a
/// project imported by the web UI, a cached project and a Tauri project all
/// receive the same closed-loop view before any frontend store path runs.
/// These nodes carry `virtual: true` and are filtered before XML/project
/// serialization by the frontend.
fn append_builtin_flight_dynamics(nodes: &mut Vec<Value>) {
    if nodes.iter().any(|node| node["data"]["virtual"].as_bool() == Some(true)) {
        return;
    }
    let aero = nodes.iter().find(|node| node["data"]["componentType"] == "aero_coefficients");
    let x = aero.and_then(|node| node["position"]["x"].as_f64()).unwrap_or(175.0);
    let y = aero.and_then(|node| node["position"]["y"].as_f64()).unwrap_or(120.0);
    nodes.push(json!({
        "id": "builtin-forces-moments",
        "type": "aircraftComponent",
        "position": { "x": x + 245.0, "y": y + 12.0 },
        "data": {
            "label": "力和力矩计算",
            "componentType": "force_moment",
            "virtual": true,
            "readOnly": true,
            "params": { "mode": "系统内置 · 只读", "formula": "ΣF / ΣM" }
        }
    }));
    nodes.push(json!({
        "id": "builtin-six-dof",
        "type": "aircraftComponent",
        "position": { "x": x + 485.0, "y": y + 72.0 },
        "data": {
            "label": "JSBSim 六自由度模型",
            "componentType": "six_dof",
            "virtual": true,
            "readOnly": true,
            "params": { "mode": "系统内置 · 只读", "solver": "6DOF Dynamics" }
        }
    }));
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
                                // Keep the source reference on the expanded
                                // section. parse_component_section() uses it
                                // to assign the node to systems/<file>.xml;
                                // without this, the signal flow is parsed but
                                // later treated as part of the main model.
                                merged.attrs.insert("file".to_string(), file.to_string());
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
    crate::xml_diagnostics::validate_references(xml, "model.xml", file_map)?;
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
    parse_input(&fdm_config, &mut nodes, &mut layout);
    parse_output(&fdm_config, &mut nodes, &mut layout);

    // Create logical edges
    create_logical_edges(&nodes, &mut edges);

    // Apply location-based layout
    apply_location_layout(&mut nodes);
    append_builtin_flight_dynamics(&mut nodes);

    // Every parsed node gets an explicit file owner.  This metadata is part
    // of the v3 project format; the generator can therefore keep referenced
    // systems/engines out of the main aircraft XML.
    let model_name = aircraft["name"].as_str().unwrap_or("aircraft").to_string();
    let main_path = format!("aircraft/{model_name}/{model_name}.xml");
    let mut owned_paths = std::collections::BTreeSet::new();
    owned_paths.insert(main_path.clone());
    for node in &mut nodes {
        let data = node.get_mut("data").and_then(|v| v.as_object_mut());
        let Some(data) = data else { continue };
        let component_type = data.get("componentType").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let params = data.get_mut("params").and_then(|v| v.as_object_mut());
        let Some(params) = params else { continue };
        let source = params.get("_source_file").and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_string);
        let path = source.map(|raw| {
            let with_ext = if raw.to_ascii_lowercase().ends_with(".xml") { raw } else { format!("{raw}.xml") };
            if with_ext.contains('/') {
                with_ext
            } else if component_type == "system" || component_type == "flight_control" {
                format!("systems/{with_ext}")
            } else if component_type == "engine" || component_type == "propeller" {
                format!("engine/{with_ext}")
            } else {
                with_ext
            }
        }).unwrap_or_else(|| main_path.clone());
        owned_paths.insert(path.clone());
        if path != main_path {
            params.insert("referencePath".into(), json!(path.clone()));
        }
        let category = if path == main_path { "main" } else if path.starts_with("engine/") { "engine" } else { "system" };
        params.insert("source".into(), json!({
            "fileId": format!("{category}:{path}"), "path": path, "category": category
        }));
    }
    let xml_files: Vec<Value> = owned_paths.into_iter().map(|path| {
        let category = if path == main_path { "main" } else if path.starts_with("systems/") { "system" } else if path.starts_with("engine/") { "engine" } else { "system" };
        let original = if path == main_path {
            xml.to_string()
        } else {
            file_map.get(&path).or_else(|| file_map.get(path.rsplit('/').next().unwrap_or(&path))).cloned().unwrap_or_default()
        };
        json!({ "id": format!("{category}:{path}"), "path": path, "category": category, "originalXml": original, "currentXml": original, "dirty": false })
    }).collect();

    Ok(json!({
        "aircraft": aircraft,
        "nodes": nodes,
        "edges": edges,
        "xmlFiles": xml_files,
        "format": "jsbsim-model-project",
        "version": 3
    }))
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    fn node<'a>(graph: &'a Value, component_type: &str) -> &'a Value {
        graph["nodes"].as_array().unwrap().iter()
            .find(|item| item["data"]["componentType"] == component_type)
            .unwrap_or_else(|| panic!("missing component {component_type}"))
    }

    #[test]
    fn viztra_udp_json_output_round_trips_property_mapping() {
        let xml = r#"<fdm_config name="H7" version="2.0">
  <output name="Viztra JSON" type="VIZTRA_UDP_JSON" host="192.168.3.100" port="9870" rate="20">
    <property>px4/viztra/relative-n-m</property>
    <property>px4/viztra/relative-e-m</property>
    <property>px4/viztra/relative-d-m</property>
  </output>
</fdm_config>"#;
        let mut graph = parse_xml(xml, &HashMap::new()).expect("parse Viztra output");
        let output = graph["nodes"].as_array_mut().unwrap().iter_mut()
            .find(|item| item["data"]["componentType"] == "output").unwrap();
        let params = &mut output["data"]["params"];
        assert_eq!(params["type"], "VIZTRA_UDP_JSON");
        assert_eq!(params["host"], "192.168.3.100");
        assert_eq!(params["viztra_down"], "px4/viztra/relative-d-m");
        params["viztra_east"] = json!("px4/viztra/new-east");
        let saved = crate::xml_generator::generate_xml(&graph).expect("save Viztra output");
        assert!(saved.contains("type=\"VIZTRA_UDP_JSON\""));
        assert!(saved.contains("host=\"192.168.3.100\""));
        assert!(saved.contains("<property>px4/viztra/new-east</property>"));
        assert!(!saved.contains("<property>px4/viztra/relative-e-m</property>"));
    }

    #[test]
    fn hil_output_mapping_edits_are_written_to_xml() {
        let xml = r#"<fdm_config name="F450_PX4" version="2.0">
  <output name="PX4" type="HIL_SENSOR" port="14560" rate="250">
    <property>imu/ax</property><property>imu/ay</property><property>imu/az</property>
    <property>imu/gx</property><property>imu/gy</property><property>imu/gz</property>
    <property>imu/mx</property><property>imu/my</property><property>imu/mz</property>
    <property>baro/pressure</property><property>aero/qbar</property><property>position/alt</property>
  </output>
  <output name="PX4" type="HIL_GPS" port="14560" rate="10">
    <property>gps/lat</property><property>gps/lon</property><property>gps/alt</property>
    <property>gps/speed</property><property>gps/course</property>
    <property>gps/vn</property><property>gps/ve</property><property>gps/vd</property>
  </output>
</fdm_config>"#;
        let mut graph = parse_xml(xml, &HashMap::new()).expect("parse HIL output");
        let mut outputs: Vec<&mut Value> = graph["nodes"].as_array_mut().unwrap().iter_mut()
            .filter(|item| item["data"]["componentType"] == "output")
            .collect();
        assert_eq!(outputs[0]["data"]["params"]["hil_pressure_abs"], "baro/pressure");
        assert_eq!(outputs[1]["data"]["params"]["hil_gps_vd"], "gps/vd");
        outputs[0]["data"]["params"]["hil_pressure_abs"] = json!("baro/new_pressure");
        outputs[1]["data"]["params"]["hil_gps_vd"] = json!("gps/new_vd");

        let saved = crate::xml_generator::generate_xml(&graph).expect("save HIL output");
        assert!(saved.contains("<property>baro/new_pressure</property>"));
        assert!(saved.contains("<property>gps/new_vd</property>"));
        assert!(saved.contains("<property>gps/speed</property>"));
        assert!(saved.contains("<property>gps/course</property>"));
        assert!(!saved.contains("<property>baro/pressure</property>"));
        assert!(!saved.contains("<property>gps/vd</property>"));
    }

    #[test]
    fn file_backed_sensor_is_owned_by_systems_xml() {
        let xml = r#"<?xml version="1.0"?>
<fdm_config name="F450" version="2.0" release="PRODUCTION">
  <system file="SensorImu.xml"/>
</fdm_config>"#;
        let parsed = parse_xml(xml, &HashMap::new()).expect("parse F450");
        let node = parsed["nodes"].as_array().unwrap().iter()
            .find(|node| node["data"]["componentType"] == "system")
            .expect("system node");
        assert_eq!(node["data"]["params"]["referencePath"], "systems/SensorImu.xml");
        assert_eq!(node["data"]["params"]["source"]["path"], "systems/SensorImu.xml");
        assert_eq!(node["data"]["params"]["source"]["category"], "system");
    }

    #[test]
    fn file_backed_aero_adds_read_only_dynamics_nodes() {
        let xml = r#"<fdm_config name="F450" version="2.0" release="PRODUCTION">
  <aerodynamics file="Aero.xml"/>
</fdm_config>"#;
        let mut files = HashMap::new();
        files.insert("Aero.xml".to_string(), r#"<aerodynamics>
  <function name="aero/coefficient/CL"><value>0.2</value></function>
</aerodynamics>"#.to_string());

        let parsed = parse_xml(xml, &files).expect("parse referenced Aero.xml");
        node(&parsed, "aero_coefficients");
        let virtual_nodes: Vec<&Value> = parsed["nodes"].as_array().unwrap().iter()
            .filter(|item| item["data"]["virtual"].as_bool() == Some(true))
            .collect();
        assert_eq!(virtual_nodes.len(), 2);
        assert!(virtual_nodes.iter().any(|item| item["data"]["componentType"] == "force_moment"));
        assert!(virtual_nodes.iter().any(|item| item["data"]["componentType"] == "six_dof"));
    }

    #[test]
    fn model_without_aero_still_adds_read_only_dynamics_nodes() {
        let xml = r#"<fdm_config name="NoModel" version="2.0" release="TEST"/>"#;

        let parsed = parse_xml(xml, &HashMap::new()).expect("parse model without sections");
        let virtual_nodes: Vec<&Value> = parsed["nodes"].as_array().unwrap().iter()
            .filter(|item| item["data"]["virtual"].as_bool() == Some(true))
            .collect();
        assert_eq!(virtual_nodes.len(), 2);
        assert!(virtual_nodes.iter().any(|item|
            item["id"] == "builtin-forces-moments"
                && item["data"]["readOnly"] == true));
        assert!(virtual_nodes.iter().any(|item|
            item["id"] == "builtin-six-dof"
                && item["data"]["readOnly"] == true));
    }

    #[test]
    fn inline_aero_ball_adds_read_only_dynamics_nodes() {
        let ball = include_str!("../../../sdcard/jsbsim/aircraft/ball/ball.xml");

        let parsed = parse_xml(ball, &HashMap::new()).expect("parse ball with inline aerodynamics");
        node(&parsed, "aero_coefficients");
        assert!(parsed["nodes"].as_array().unwrap().iter()
            .any(|item| item["id"] == "builtin-forces-moments"
                && item["data"]["componentType"] == "force_moment"
                && item["data"]["virtual"] == true
                && item["data"]["readOnly"] == true));
        assert!(parsed["nodes"].as_array().unwrap().iter()
            .any(|item| item["id"] == "builtin-six-dof"
                && item["data"]["componentType"] == "six_dof"
                && item["data"]["virtual"] == true
                && item["data"]["readOnly"] == true));
    }

    #[test]
    fn f450_px4_aero_xml_adds_read_only_dynamics_nodes() {
        let f450 = include_str!("../../../sdcard/jsbsim/aircraft/F450_PX4/F450_PX4.xml");
        let aero = include_str!("../../../sdcard/jsbsim/aircraft/F450_PX4/Aero.xml");
        let mut files = HashMap::new();
        files.insert("Aero.xml".to_string(), aero.to_string());

        let parsed = parse_xml(f450, &files).expect("parse F450_PX4 with Aero.xml");
        node(&parsed, "aero_coefficients");
        assert!(parsed["nodes"].as_array().unwrap().iter()
            .any(|item| item["id"] == "builtin-forces-moments" && item["data"]["virtual"] == true));
        assert!(parsed["nodes"].as_array().unwrap().iter()
            .any(|item| item["id"] == "builtin-six-dof" && item["data"]["virtual"] == true));
    }

    #[test]
    fn every_library_component_survives_edit_save_reload() {
        let xml = r#"<?xml version="1.0"?>
<fdm_config name="RoundTrip" version="2.0" release="TEST">
  <metrics>
    <wingarea unit="FT2">10</wingarea><wingspan unit="FT">4</wingspan>
    <chord unit="FT">2</chord><wing_incidence unit="DEG">1</wing_incidence>
    <htailarea unit="FT2">3</htailarea><htailarm unit="FT">5</htailarm>
    <vtailarea unit="FT2">2</vtailarea><vtailarm unit="FT">6</vtailarm>
    <location name="AERORP" unit="IN"><x>1</x><y>2</y><z>3</z></location>
  </metrics>
  <mass_balance>
    <ixx unit="SLUG*FT2">1</ixx><iyy unit="SLUG*FT2">2</iyy><izz unit="SLUG*FT2">3</izz>
    <emptywt unit="LBS">20</emptywt>
    <location name="CG" unit="IN"><x>4</x><y>5</y><z>6</z></location>
    <pointmass name="Payload"><weight unit="LBS">7</weight><location unit="IN"><x>8</x><y>9</y><z>10</z></location></pointmass>
  </mass_balance>
  <ground_reactions><contact name="MAIN" type="BOGEY">
    <location unit="IN"><x>1</x><y>0</y><z>-1</z></location>
    <static_friction>0.8</static_friction><dynamic_friction>0.5</dynamic_friction><rolling_friction>0.02</rolling_friction>
  </contact></ground_reactions>
  <propulsion>
    <engine name="Motor"><feed>0</feed><thruster name="Prop"><sense>1</sense><p_factor>2</p_factor></thruster></engine>
    <tank name="Tank 0" type="FUEL"><capacity unit="LBS">12</capacity><contents unit="LBS">11</contents></tank>
  </propulsion>
  <system name="Inline System"><property>test/system</property></system>
  <flight_control name="Inline FCS"><property>test/fcs</property></flight_control>
  <aerodynamics><axis name="LIFT"><function name="aero/coefficient/CL"><value>0.2</value></function></axis></aerodynamics>
  <input name="192.0.2.1" type="HIL_ACTUATOR_CONTROLS" port="14560" rate="250"><property>fcs/throttle-cmd-norm[0]</property></input>
  <output name="PX4" type="HIL_SENSOR" port="14560" rate="250"><property>sensor/imu/x</property></output>
  <output name="can" type="UAVCAN" interface="can0" node_id="42" subject_id="1000" rate="50"><property>sensor/can/x</property></output>
</fdm_config>"#;

        let mut graph = parse_xml(xml, &HashMap::new()).expect("initial parse");
        let expected = [
            "fuselage", "wing", "htail", "vtail", "engine", "propeller",
            "landing_gear", "fuel_tank", "point_mass", "inertia",
            "aero_coefficients", "system", "flight_control", "input", "uavcan", "output",
        ];
        for component_type in expected {
            node(&graph, component_type);
        }

        // Simulate edits made in the property panel before Save.
        for item in graph["nodes"].as_array_mut().unwrap() {
            let kind = item["data"]["componentType"].as_str().unwrap_or("").to_string();
            let params = &mut item["data"]["params"];
            match kind.as_str() {
                "wing" => params["wingarea"] = json!({"value": 12.5, "unit": "FT2"}),
                "htail" => params["htailarea"] = json!({"value": 3.5, "unit": "FT2"}),
                "vtail" => params["vtailarm"] = json!({"value": 6.5, "unit": "FT"}),
                "landing_gear" => params["rolling_friction"] = json!(0.031),
                "input" => params["port"] = json!(14561),
                "output" => params["rate"] = json!(251),
                _ => {}
            }
        }

        let saved = crate::xml_generator::generate_xml(&graph).expect("save XML");
        let reloaded = parse_xml(&saved, &HashMap::new()).expect("reload saved XML");
        for component_type in expected {
            node(&reloaded, component_type);
        }
        assert_eq!(node(&reloaded, "wing")["data"]["params"]["wingarea"]["value"], 12.5);
        assert_eq!(node(&reloaded, "htail")["data"]["params"]["htailarea"]["value"], 3.5);
        assert_eq!(node(&reloaded, "vtail")["data"]["params"]["vtailarm"]["value"], 6.5);
        assert_eq!(node(&reloaded, "landing_gear")["data"]["params"]["rolling_friction"], 0.031);
        assert_eq!(node(&reloaded, "input")["data"]["params"]["port"], 14561);
        assert_eq!(node(&reloaded, "output")["data"]["params"]["rate"], 251.0);
        assert_eq!(node(&reloaded, "engine")["data"]["params"]["name"], "Motor");
        assert_eq!(node(&reloaded, "fuel_tank")["data"]["params"]["name"], "Tank 0");
    }

    #[test]
    fn serial_hil_round_trip_merges_three_mavlink_channels() {
        let xml = r#"<fdm_config name="Serial" version="2.0" release="TEST">
  <input name="PX4" type="HIL_ACTUATOR_CONTROLS" transport="SERIAL" device="/dev/ttyS1" baud="921600"><property>fcs/a</property></input>
  <output name="PX4" type="HIL_SENSOR" transport="SERIAL" device="/dev/ttyS1" baud="921600" rate="250"><property>sensor/imu/x</property></output>
  <output name="PX4" type="HIL_GPS" transport="SERIAL" device="/dev/ttyS1" baud="921600" rate="10"><property>sensor/gps/lat</property></output>
</fdm_config>"#;
        let graph = parse_xml(xml, &HashMap::new()).expect("parse serial HIL");
        let serial = node(&graph, "serial_hil");
        assert_eq!(serial["data"]["params"]["device"], "/dev/ttyS1");
        assert_eq!(serial["data"]["params"]["sensor_rate"], 250.0);
        assert_eq!(serial["data"]["params"]["gps_rate"], 10.0);
        assert_eq!(serial["data"]["params"]["actuator_properties"], "fcs/a");

        let saved = crate::xml_generator::generate_xml(&graph).expect("save serial HIL");
        assert!(saved.contains("type=\"HIL_SENSOR\" transport=\"SERIAL\""));
        assert!(saved.contains("type=\"HIL_GPS\" transport=\"SERIAL\""));
        assert!(saved.contains("type=\"HIL_ACTUATOR_CONTROLS\" transport=\"SERIAL\""));
        let reloaded = parse_xml(&saved, &HashMap::new()).expect("reload serial HIL");
        assert_eq!(reloaded["nodes"].as_array().unwrap().iter()
            .filter(|item| item["data"]["componentType"] == "serial_hil").count(), 1);
    }

    #[test]
    fn individual_hil_io_transport_survives_round_trip() {
        let xml = r#"<fdm_config name="HIL" version="2.0">
  <input name="0.0.0.0" type="HIL_ACTUATOR_CONTROLS" port="14560" rate="250" transport="SERIAL" editor_module="input" device="/dev/ttyS5" baud="921600"><property>fcs/a</property><property>fcs/b</property><property>fcs/c</property><property>fcs/d</property></input>
  <output name="PX4" type="HIL_SENSOR" port="14560" rate="250" transport="SERIAL" editor_module="output" device="/dev/ttyS5" baud="921600"><property>imu/ax</property></output>
  <output name="PX4" type="HIL_GPS" port="14561" rate="10" host="192.168.1.2"><property>gps/lat</property></output>
</fdm_config>"#;
        let graph = parse_xml(xml, &HashMap::new()).expect("parse individual HIL I/O");
        assert_eq!(node(&graph, "input")["data"]["params"]["transport"], "SERIAL");
        let outputs: Vec<&Value> = graph["nodes"].as_array().unwrap().iter()
            .filter(|item| item["data"]["componentType"] == "output").collect();
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0]["data"]["params"]["device"], "/dev/ttyS5");
        assert_eq!(outputs[1]["data"]["params"]["host"], "192.168.1.2");

        let saved = crate::xml_generator::generate_xml(&graph).expect("save individual HIL I/O");
        assert!(saved.contains("editor_module=\"input\""));
        assert!(saved.contains("editor_module=\"output\""));
        assert!(saved.contains("host=\"192.168.1.2\""));
        let reloaded = parse_xml(&saved, &HashMap::new()).expect("reload individual HIL I/O");
        assert_eq!(reloaded["nodes"].as_array().unwrap().iter()
            .filter(|item| item["data"]["componentType"] == "serial_hil").count(), 0);
        assert_eq!(node(&reloaded, "input")["data"]["params"]["device"], "/dev/ttyS5");
    }
}
