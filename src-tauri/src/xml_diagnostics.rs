//! Source-aware syntax checks before the editor mutates its project graph.
use quick_xml::{events::Event, Reader};
use std::collections::{HashMap, HashSet, VecDeque};

pub fn diagnostic(xml: &str, path: &str, offset: usize, message: &str) -> String {
    let mut offset = offset.min(xml.len());
    while !xml.is_char_boundary(offset) { offset -= 1; }
    let before = &xml[..offset];
    let line = before.replace("\r\n", "\n").replace('\r', "\n").lines().count()
        + usize::from(before.is_empty() || before.ends_with(['\r', '\n']));
    let line_start = before.rfind(['\r', '\n']).map_or(0, |p| p + 1);
    let column = xml[line_start..offset].chars().count() + 1;
    let source = xml[line_start..].split(['\r', '\n']).next().unwrap_or("");
    let skip = column.saturating_sub(61);
    let excerpt: String = source.chars().skip(skip).take(160)
        .map(|c| if c.is_control() { ' ' } else { c }).collect();
    let prefix = format!("{line} | {}", if skip > 0 { "..." } else { "" });
    format!("{path}:{line}:{column}:\n{prefix}{excerpt}\n{}^\nXML: {message}",
        " ".repeat(prefix.len() + column - 1 - skip))
}

/// Validate reachable indexed files too: section/engine expansion historically
/// ignored parse failures. Unrelated global library files must not block import.
pub fn validate_references(xml: &str, path: &str, files: &HashMap<String, String>) -> Result<(), String> {
    let mut pending = VecDeque::from([(path.to_string(), xml)]);
    let mut seen = HashSet::new();
    while let Some((path, xml)) = pending.pop_front() {
        if !seen.insert(path.clone()) { continue; }
        if seen.len() > 256 { return Err(format!("{path}: XML 引用超过 256 个文件")); }
        validate(xml, &path)?;
        let mut reader = Reader::from_str(xml);
        loop {
            match reader.read_event() {
                Ok(Event::Start(element) | Event::Empty(element)) => {
                    for attr in element.attributes().flatten() {
                        if attr.key.as_ref() != b"file" { continue; }
                        let key = attr.unescape_value().map_err(|e| e.to_string())?;
                        let Some(content) = files.get(key.as_ref()) else { continue; };
                        let name = files.iter().filter(|(name, value)| name.ends_with(".xml") && *value == content)
                            .map(|(name, _)| name).min_by_key(|name| (!name.contains('/'), name.as_str()))
                            .cloned().unwrap_or_else(|| key.to_string());
                        pending.push_back((name, content.as_str()));
                    }
                }
                Ok(Event::Eof) => break,
                Err(error) => return Err(error.to_string()), // already validated
                _ => {}
            }
        }
    }
    Ok(())
}

pub fn validate(xml: &str, path: &str) -> Result<(), String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_comments = true;
    let mut depth = 0usize;
    let mut roots = 0usize;
    loop {
        let position = reader.buffer_position() as usize;
        let fail = |message: &str| diagnostic(xml, path, position, message);
        match reader.read_event() {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                if depth == 0 {
                    roots += 1;
                    if roots > 1 { return Err(fail("文档只能有一个根元素")); }
                }
                for attr in e.attributes() {
                    let attr = attr.map_err(|e| fail(&e.to_string()))?;
                    attr.unescape_value().map_err(|e| fail(&e.to_string()))?;
                }
                // Event data borrows the input, so examine its closing delimiter.
                let end = reader.buffer_position() as usize;
                if !xml[..end].trim_end().ends_with("/>") { depth += 1; }
            }
            Ok(Event::End(_)) => { depth = depth.saturating_sub(1); }
            Ok(Event::Text(text)) if depth == 0 => {
                if !text.decode().map_err(|e| fail(&e.to_string()))?.trim().is_empty() {
                    return Err(fail("根元素之外存在文本"));
                }
            }
            Ok(Event::CData(_)) if depth == 0 => return Err(fail("根元素之外存在 CDATA")),
            Ok(Event::GeneralRef(reference)) => {
                let name = reference.decode().map_err(|e| fail(&e.to_string()))?;
                if depth == 0 { return Err(fail("根元素之外存在实体引用")); }
                if reference.resolve_char_ref().map_err(|e| fail(&e.to_string()))?.is_none()
                    && !matches!(name.as_ref(), "amp" | "lt" | "gt" | "apos" | "quot") {
                    return Err(fail(&format!("未知实体 &{name};")));
                }
            }
            Ok(Event::Eof) => {
                if depth != 0 { return Err(fail("文件结束，但仍有未闭合的 XML 元素")); }
                if roots == 0 { return Err(fail("XML 文档为空或没有根元素")); }
                return Ok(());
            }
            Err(error) => return Err(diagnostic(xml, path, reader.error_position() as usize, &error.to_string())),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_positions_and_malformed_documents() {
        for xml in ["<a>", "<a/><b/>", "<a x='1' x='2'/>", "<a>&bad;</a>", "text<a/>", ""] {
            let error = validate(xml, "test.xml").unwrap_err();
            assert!(error.contains("test.xml:"));
            assert!(error.contains('^'));
        }
        let error = validate("<a>\r\n  <b></bad>\r\n</a>", "子文件.xml").unwrap_err();
        assert!(error.contains("子文件.xml:2:6:"), "{error}");
        validate("<?xml version='1.0'?><a x='&amp;'>中文&#x41;<b/></a>", "ok.xml").unwrap();
    }
    #[test]
    fn referenced_error_reports_actual_path_without_scanning_unrelated_files() {
        let files = HashMap::from([
            ("metrics".into(), "<metrics>\n  <a></wrong></metrics>".into()),
            ("aircraft/test/metrics.xml".into(), "<metrics>\n  <a></wrong></metrics>".into()),
            ("unrelated.xml".into(), "broken".into()),
        ]);
        let error = validate_references("<fdm_config><metrics file='metrics'/></fdm_config>", "main.xml", &files).unwrap_err();
        assert!(error.contains("aircraft/test/metrics.xml:2:6:"), "{error}");
        validate_references("<fdm_config/>", "main.xml", &files).unwrap();
        assert!(diagnostic("<a>\r  <b>", "cr.xml", 6, "bad").contains("cr.xml:2:3:"));
    }
}
