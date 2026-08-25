//! Aircraft library — list, load, and generate aircraft from JSBSim library.

use std::collections::HashMap;
use serde_json::Value;
use crate::file_index;

/// Generate aircraft XML from wizard data (ported from server/index.js POST /api/generate-aircraft).
pub fn generate_aircraft_xml(data: &Value) -> Result<String, String> {
    let ind = |n: usize| "  ".repeat(n);
    let d = data;

    let unit_system = d["unitSystem"].as_str().unwrap_or("METRIC");
    let u_len = if unit_system == "METRIC" { "M" } else { "IN" };
    let u_ft = if unit_system == "METRIC" { "M" } else { "FT" };
    let u_ft2 = if unit_system == "METRIC" { "M2" } else { "FT2" };
    let u_wt = if unit_system == "METRIC" { "KG" } else { "LBS" };
    let u_in = if unit_system == "METRIC" { "KG*M2" } else { "SLUG*FT2" };

    let name = d["name"].as_str().unwrap_or("Unnamed");
    let version = d["version"].as_str().unwrap_or("1.0");
    let release = d["release"].as_str().unwrap_or("ALPHA");
    let author = d["author"].as_str().unwrap_or("");
    let description = d["description"].as_str().unwrap_or("");
    let aircraft_type = d["aircraftType"].as_str().unwrap_or("fixed_wing");

    let loc = |name: &str, obj: &Value| -> String {
        format!(
            "{}<location name=\"{}\" unit=\"{}\">\n{}<x> {} </x>\n{}<y> {} </y>\n{}<z> {} </z>\n{}</location>\n",
            ind(2), name, u_len,
            ind(3), obj["x"],
            ind(3), obj["y"],
            ind(3), obj["z"],
            ind(2)
        )
    };

    let mut x = format!(
        "<?xml version=\"1.0\"?>\n<fdm_config name=\"{}\" version=\"{}\" release=\"{}\">\n",
        name, version, release
    );

    // File header
    x += &format!("{}<fileheader>\n", ind(1));
    if !author.is_empty() {
        x += &format!("{}<author>{}</author>\n", ind(2), author);
    }
    x += &format!("{}<filecreationdate>{}</filecreationdate>\n", ind(2), chrono_date());
    x += &format!("{}<version>1.0</version>\n", ind(2));
    if !description.is_empty() {
        x += &format!("{}<description>{}</description>\n", ind(2), description);
    }
    x += &format!("{}</fileheader>\n", ind(1));

    // Metrics
    x += &format!("{}<metrics>\n", ind(1));
    x += &format!("{}<wingarea unit=\"{}\"> {} </wingarea>\n", ind(2), u_ft2, d["wingarea"]);
    x += &format!("{}<wingspan unit=\"{}\"> {} </wingspan>\n", ind(2), u_ft, d["wingspan"]);
    x += &format!("{}<chord unit=\"{}\"> {} </chord>\n", ind(2), u_ft, d["chord"]);
    if aircraft_type == "helicopter" {
        if let Some(inc) = d["wingIncidence"].as_f64() {
            x += &format!("{}<wing_incidence unit=\"DEG\"> {} </wing_incidence>\n", ind(2), inc);
        }
    }
    if aircraft_type != "multirotor" {
        x += &format!("{}<htailarea unit=\"{}\"> {} </htailarea>\n", ind(2), u_ft2, d["htailarea"]);
        x += &format!("{}<htailarm unit=\"{}\"> {} </htailarm>\n", ind(2), u_ft, d["htailarm"]);
        x += &format!("{}<vtailarea unit=\"{}\"> {} </vtailarea>\n", ind(2), u_ft2, d["vtailarea"]);
        x += &format!("{}<vtailarm unit=\"{}\"> {} </vtailarm>\n", ind(2), u_ft, d["vtailarm"]);
    }
    x += &loc("AERORP", &d["aerorp"]);
    x += &loc("EYEPOINT", &d["eyepoint"]);
    x += &loc("VRP", &d["vrp"]);
    x += &format!("{}</metrics>\n", ind(1));

    // Mass balance
    x += &format!("{}<mass_balance>\n", ind(1));
    x += &format!("{}<ixx unit=\"{}\"> {} </ixx>\n", ind(2), u_in, d["ixx"]);
    x += &format!("{}<iyy unit=\"{}\"> {} </iyy>\n", ind(2), u_in, d["iyy"]);
    x += &format!("{}<izz unit=\"{}\"> {} </izz>\n", ind(2), u_in, d["izz"]);
    x += &format!("{}<ixz unit=\"{}\"> {} </ixz>\n", ind(2), u_in, d["ixz"]);
    x += &format!("{}<emptywt unit=\"{}\"> {} </emptywt>\n", ind(2), u_wt, d["emptywt"]);
    x += &loc("CG", &d["cg"]);
    if let Some(pms) = d["pointmasses"].as_array() {
        for pm in pms {
            let pm_name = pm["name"].as_str().unwrap_or("");
            x += &format!("{}<pointmass name=\"{}\">\n", ind(2), pm_name);
            x += &format!("{}<weight unit=\"{}\"> {} </weight>\n", ind(3), u_wt, pm["weight"]);
            x += &format!("{}<location unit=\"{}\">\n", ind(3), u_len);
            x += &format!("{}<x> {} </x>\n", ind(4), pm["x"]);
            x += &format!("{}<y> {} </y>\n", ind(4), pm["y"]);
            x += &format!("{}<z> {} </z>\n", ind(4), pm["z"]);
            x += &format!("{}</location>\n", ind(3));
            x += &format!("{}</pointmass>\n", ind(2));
        }
    }
    x += &format!("{}</mass_balance>\n", ind(1));

    // Ground reactions
    x += &format!("{}<ground_reactions>\n", ind(1));
    if let Some(contacts) = d["contacts"].as_array() {
        for c in contacts {
            let c_name = c["name"].as_str().unwrap_or("");
            let c_type = c["type"].as_str().unwrap_or("BOGEY");
            x += &format!("{}<contact name=\"{}\" type=\"{}\">\n", ind(2), c_name, c_type);
            x += &format!("{}<location unit=\"{}\">\n", ind(3), u_len);
            x += &format!("{}<x> {} </x>\n", ind(4), c["x"]);
            x += &format!("{}<y> {} </y>\n", ind(4), c["y"]);
            x += &format!("{}<z> {} </z>\n", ind(4), c["z"]);
            x += &format!("{}</location>\n", ind(3));
            x += &format!("{}<static_friction> {} </static_friction>\n", ind(3), c["staticFriction"]);
            x += &format!("{}<dynamic_friction> {} </dynamic_friction>\n", ind(3), c["dynamicFriction"]);
            x += &format!("{}<rolling_friction> {} </rolling_friction>\n", ind(3), c["rollingFriction"]);
            x += &format!("{}<spring_coeff> {} </spring_coeff>\n", ind(3), c["spring"]);
            x += &format!("{}<damping_coeff> {} </damping_coeff>\n", ind(3), c["damping"]);
            if let Some(ms) = c["maxSteer"].as_f64() {
                if ms > 0.0 {
                    x += &format!("{}<max_steer> {} </max_steer>\n", ind(3), ms);
                }
            }
            x += &format!("{}<brake_group> {} </brake_group>\n", ind(3), c["brakeGroup"].as_str().unwrap_or("NONE"));
            let retractable = if c["retractable"].as_bool().unwrap_or(false) { 1 } else { 0 };
            x += &format!("{}<retractable> {} </retractable>\n", ind(3), retractable);
            x += &format!("{}</contact>\n", ind(2));
        }
    }
    x += &format!("{}</ground_reactions>\n", ind(1));

    // Propulsion
    x += &format!("{}<propulsion>\n", ind(1));
    if let Some(engines) = d["engines"].as_array() {
        for eng in engines {
            let eng_file = eng["file"].as_str().unwrap_or("");
            let eng_name = eng["name"].as_str().unwrap_or("");
            x += &format!("{}<engine file=\"{}\" name=\"{}\">\n", ind(2), eng_file, eng_name);
            x += &format!("{}<location unit=\"{}\">\n", ind(3), u_len);
            x += &format!("{}<x> {} </x>\n", ind(4), eng["x"]);
            x += &format!("{}<y> {} </y>\n", ind(4), eng["y"]);
            x += &format!("{}<z> {} </z>\n", ind(4), eng["z"]);
            x += &format!("{}</location>\n", ind(3));
            x += &format!("{}<orient unit=\"DEG\">\n", ind(3));
            x += &format!("{}<roll> 0 </roll>\n", ind(4));
            x += &format!("{}<pitch> {} </pitch>\n", ind(4), eng["pitch"]);
            x += &format!("{}<yaw> {} </yaw>\n", ind(4), eng["yaw"]);
            x += &format!("{}</orient>\n", ind(3));
            if let Some(feed) = eng["feed"].as_array() {
                for f in feed {
                    x += &format!("{}<feed> {} </feed>\n", ind(3), f);
                }
            }
            if let Some(thruster_file) = eng["thrusterFile"].as_str() {
                if !thruster_file.is_empty() {
                    x += &format!("{}<thruster file=\"{}\">\n", ind(3), thruster_file);
                    x += &format!("{}<location unit=\"{}\">\n", ind(4), u_len);
                    x += &format!("{}<x> {} </x>\n", ind(5), eng["x"]);
                    x += &format!("{}<y> {} </y>\n", ind(5), eng["y"]);
                    x += &format!("{}<z> {} </z>\n", ind(5), eng["z"]);
                    x += &format!("{}</location>\n", ind(4));
                    x += &format!("{}<orient unit=\"DEG\">\n", ind(4));
                    x += &format!("{}<roll> 0 </roll>\n", ind(5));
                    x += &format!("{}<pitch> {} </pitch>\n", ind(5), eng["pitch"]);
                    x += &format!("{}<yaw> {} </yaw>\n", ind(5), eng["yaw"]);
                    x += &format!("{}</orient>\n", ind(4));
                    x += &format!("{}<sense> {} </sense>\n", ind(4), eng["sense"].as_str().unwrap_or("1"));
                    if let Some(pf) = eng["pFactor"].as_f64() {
                        if pf != 0.0 {
                            x += &format!("{}<p_factor> {} </p_factor>\n", ind(4), pf);
                        }
                    }
                    x += &format!("{}</thruster>\n", ind(3));
                }
            }
            x += &format!("{}</engine>\n", ind(2));
        }
    }
    if let Some(tanks) = d["tanks"].as_array() {
        for t in tanks {
            let t_type = t["type"].as_str().unwrap_or("FUEL_TANK");
            let t_num = t["number"].as_u64().unwrap_or(0);
            x += &format!("{}<tank type=\"{}\" number=\"{}\">\n", ind(2), t_type, t_num);
            x += &format!("{}<location unit=\"{}\">\n", ind(3), u_len);
            x += &format!("{}<x> {} </x>\n", ind(4), t["x"]);
            x += &format!("{}<y> {} </y>\n", ind(4), t["y"]);
            x += &format!("{}<z> {} </z>\n", ind(4), t["z"]);
            x += &format!("{}</location>\n", ind(3));
            x += &format!("{}<radius> {} </radius>\n", ind(3), t["radius"]);
            x += &format!("{}<capacity unit=\"{}\"> {} </capacity>\n", ind(3), u_wt, t["capacity"]);
            x += &format!("{}<contents unit=\"{}\"> {} </contents>\n", ind(3), u_wt, t["contents"]);
            x += &format!("{}</tank>\n", ind(2));
        }
    }
    x += &format!("{}</propulsion>\n", ind(1));

    // System references
    if let Some(sensors) = d["sensors"].as_object() {
        if sensors.get("imu").and_then(|v| v.as_bool()).unwrap_or(false) {
            x += &format!("{}<system file=\"SensorImu\"/>\n", ind(1));
        }
        if sensors.get("baro").and_then(|v| v.as_bool()).unwrap_or(false) {
            x += &format!("{}<system file=\"SensorBaro\"/>\n", ind(1));
        }
        if sensors.get("gps").and_then(|v| v.as_bool()).unwrap_or(false) {
            x += &format!("{}<system file=\"SensorGps\"/>\n", ind(1));
        }
    }
    if aircraft_type == "multirotor" {
        if let Some(effectors) = d["effectors"].as_object() {
            if !effectors.is_empty() {
                x += &format!("{}<system file=\"Effectors\"/>\n", ind(1));
            }
        }
    }

    // Flight control (placeholder)
    x += &format!("{}<flight_control name=\"Autogenerated\">\n", ind(1));
    x += &format!("{}<channel name=\"Placeholder\">\n", ind(2));
    x += &format!("{}<!-- Add flight control channels here -->\n", ind(3));
    x += &format!("{}</channel>\n", ind(2));
    x += &format!("{}</flight_control>\n", ind(1));

    // Aerodynamics (placeholder)
    x += &format!("{}<aerodynamics>\n", ind(1));
    let axes: Vec<&str> = if aircraft_type == "helicopter" {
        vec!["LIFT", "DRAG", "SIDE", "PITCH", "YAW"]
    } else {
        vec!["LIFT", "DRAG", "SIDE", "ROLL", "PITCH", "YAW"]
    };
    for axis in &axes {
        x += &format!("{}<axis name=\"{}\">\n", ind(2), axis);
        x += &format!("{}<!-- Add {} coefficients here -->\n", ind(3), axis.to_lowercase());
        x += &format!("{}</axis>\n", ind(2));
    }
    x += &format!("{}</aerodynamics>\n", ind(1));

    // Output
    if let Some(output_name) = d["outputName"].as_str() {
        if !output_name.is_empty() {
            let output_type = d["outputType"].as_str().unwrap_or("CSV");
            let output_rate = d["outputRate"].as_u64().unwrap_or(10);
            x += &format!("{}<output name=\"{}\" type=\"{}\" rate=\"{}\">\n", ind(1), output_name, output_type, output_rate);
            for tag in &["simulation", "atmosphere", "massprops", "rates", "velocities", "forces", "moments", "position", "propulsion", "aerosurfaces", "fcs", "ground_reactions"] {
                let val = if *tag == "simulation" { "OFF" } else { "ON" };
                x += &format!("{}<{}> {} </{}>\n", ind(2), tag, val, tag);
            }
            x += &format!("{}</output>\n", ind(1));
        }
    }

    x += "</fdm_config>\n";
    Ok(x)
}

/// List available aircraft in the JSBSim library.
pub fn get_aircraft_library() -> Result<Vec<Value>, String> {
    let jsbsim_root = file_index::jsbsim_root();
    let aircraft_dir = jsbsim_root.join("aircraft");

    if !aircraft_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = std::fs::read_dir(&aircraft_dir)
        .map_err(|e| format!("Failed to read aircraft directory: {}", e))?;

    let mut library = Vec::new();

    for entry in entries.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();

        // Find XML files in this aircraft directory
        let xml_files: Vec<String> = match std::fs::read_dir(&dir_path) {
            Ok(rd) => rd
                .flatten()
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|ext| ext == "xml")
                        .unwrap_or(false)
                })
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect(),
            Err(_) => continue,
        };

        // Find main aircraft file (contains <fdm_config>)
        let mut main_file = None;
        for f in &xml_files {
            let fpath = dir_path.join(f);
            if let Ok(content) = std::fs::read_to_string(&fpath) {
                if content.contains("<fdm_config") {
                    main_file = Some((f.clone(), content));
                    break;
                }
            }
        }

        let (main_file_name, content) = match main_file {
            Some(v) => v,
            None => continue,
        };

        let file_path = dir_path.join(&main_file_name);
        let stat_size = std::fs::metadata(&file_path)
            .map(|m| m.len())
            .unwrap_or(0);

        // Extract metadata from XML
        let name = extract_attr(&content, "fdm_config", "name").unwrap_or_else(|| dir_name.clone());
        let version = extract_attr(&content, "fdm_config", "version").unwrap_or_default();
        let release = extract_attr(&content, "fdm_config", "release").unwrap_or_default();
        let description = extract_element(&content, "description").unwrap_or_default();
        let author = extract_element(&content, "author").unwrap_or_default();
        let rel_path = file_path
            .strip_prefix(&jsbsim_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        // Detect aircraft type
        let aircraft_type = if content.contains("<rotor") || content.contains("rotor") {
            "helicopter"
        } else if dir_name == "F450" || content.contains("brushless_dc_motor") {
            "multirotor"
        } else if content.contains("<rocket_engine") {
            "rocket"
        } else {
            "fixed_wing"
        };

        // Sub-files
        let sub_files: Vec<String> = xml_files
            .iter()
            .filter(|f| *f != &main_file_name)
            .cloned()
            .collect();
        let sub_file_count = sub_files.len();
        let sub_files_preview: Vec<String> = sub_files.iter().take(10).cloned().collect();

        library.push(serde_json::json!({
            "id": dir_name,
            "name": name,
            "directory": dir_name,
            "mainFile": main_file_name,
            "filePath": rel_path,
            "version": version,
            "release": release,
            "description": description,
            "author": author,
            "type": aircraft_type,
            "size": stat_size,
            "subFileCount": sub_file_count,
            "subFiles": sub_files_preview,
        }));
    }

    library.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });

    Ok(library)
}

/// Load an aircraft from the library and parse it.
pub fn load_aircraft(
    aircraft_id: &str,
    jsbsim_index: &HashMap<String, String>,
) -> Result<Value, String> {
    let jsbsim_root = file_index::jsbsim_root();
    let aircraft_dir = jsbsim_root.join("aircraft").join(aircraft_id);

    if !aircraft_dir.exists() {
        return Err("Aircraft not found".to_string());
    }

    // Find main XML file (contains <fdm_config>)
    let xml_files: Vec<String> = std::fs::read_dir(&aircraft_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().map(|ext| ext == "xml").unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();

    let mut main_file = None;
    for f in &xml_files {
        let fpath = aircraft_dir.join(f);
        if let Ok(content) = std::fs::read_to_string(&fpath) {
            if content.contains("<fdm_config") {
                main_file = Some((f.clone(), content));
                break;
            }
        }
    }

    let (main_file_name, main_xml) = main_file
        .ok_or_else(|| "No valid aircraft XML found".to_string())?;

    // Collect sub-files for reference resolution
    let mut ref_files: Vec<(String, String)> = Vec::new();
    // Check subdirectories too
    let mut dirs_to_scan = vec![aircraft_dir.clone()];
    if let Ok(sub_entries) = std::fs::read_dir(&aircraft_dir) {
        for entry in sub_entries.flatten() {
            if entry.path().is_dir() {
                dirs_to_scan.push(entry.path());
            }
        }
    }

    for dir in &dirs_to_scan {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "xml").unwrap_or(false) {
                    let fname = entry.file_name().to_string_lossy().to_string();
                    if fname != main_file_name {
                        if let Ok(content) = std::fs::read_to_string(&path) {
                            ref_files.push((fname, content));
                        }
                    }
                }
            }
        }
    }

    // Build file map: JSBSim index first, then aircraft sub-files (higher priority)
    let mut file_map: HashMap<String, String> = HashMap::new();
    for (key, content) in jsbsim_index.iter() {
        file_map.insert(key.clone(), content.clone());
    }
    for (name, content) in &ref_files {
        file_map.insert(name.clone(), content.clone());
        let base = name.split('/').last().unwrap_or(name);
        file_map.insert(base.to_string(), content.clone());
        let no_ext = base.trim_end_matches(".xml");
        file_map.insert(no_ext.to_string(), content.clone());
    }

    // Parse using the XML parser
    crate::xml_parser::parse_xml(&main_xml, &file_map)
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Extract an attribute value from an XML element, e.g. extract_attr(xml, "fdm_config", "name")
fn extract_attr(xml: &str, element: &str, attr: &str) -> Option<String> {
    // Look for <element ... attr="value" ...>
    let pattern = format!("<{}", element);
    if let Some(start) = xml.find(&pattern) {
        let rest = &xml[start..];
        // Find the closing > of this tag
        if let Some(end) = rest.find('>') {
            let tag_content = &rest[..end];
            // Search for attr="..."
            let attr_pattern = format!("{}=\"", attr);
            if let Some(attr_start) = tag_content.find(&attr_pattern) {
                let value_start = attr_start + attr_pattern.len();
                let value_rest = &tag_content[value_start..];
                if let Some(attr_end) = value_rest.find('"') {
                    return Some(value_rest[..attr_end].to_string());
                }
            }
        }
    }
    None
}

/// Extract text content of an XML element, e.g. extract_element(xml, "description")
fn extract_element(xml: &str, element: &str) -> Option<String> {
    let open = format!("<{}>", element);
    let close = format!("</{}>", element);
    if let Some(start) = xml.find(&open) {
        let content_start = start + open.len();
        if let Some(end) = xml[content_start..].find(&close) {
            return Some(xml[content_start..content_start + end].trim().to_string());
        }
    }
    None
}

/// Get current date as YYYY-MM-DD string (simple, no chrono dependency).
fn chrono_date() -> String {
    // Use a simple approach: read from system or use a fallback
    // In production, we'd use chrono, but to avoid adding a dependency:
    use std::time::SystemTime;
    if let Ok(duration) = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
        let secs = duration.as_secs();
        // Simple date calculation (good enough for file creation date)
        let days = secs / 86400;
        let (y, m, d) = days_to_ymd(days as i64);
        return format!("{:04}-{:02}-{:02}", y, m, d);
    }
    "2024-01-01".to_string()
}

fn days_to_ymd(mut days: i64) -> (i64, i64, i64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    days += 719468;
    let era = if days >= 0 { days } else { days - 146096 } / 146097;
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
