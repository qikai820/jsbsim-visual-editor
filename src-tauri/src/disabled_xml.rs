//! Versioned XML comment encoding shared by model loading and generation.

pub fn comment_out_xml(xml: &str) -> String {
    if !xml.contains("--") {
        return format!("<!-- jsbve-disabled:v1 encoding=\"plain\"\n{xml}\n-->");
    }
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::new();
    for chunk in xml.as_bytes().chunks(3) {
        let value = ((chunk[0] as u32) << 16) | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8) | chunk.get(2).copied().unwrap_or(0) as u32;
        encoded.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        encoded.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        encoded.push(if chunk.len() > 1 { ALPHABET[((value >> 6) & 63) as usize] as char } else { '=' });
        encoded.push(if chunk.len() > 2 { ALPHABET[(value & 63) as usize] as char } else { '=' });
    }
    format!("<!-- jsbve-disabled:v1 encoding=\"base64\"\n{encoded}\n-->")
}

pub fn decode_disabled_comment(text: &str) -> Result<Option<String>, String> {
    let text = text.trim_start();
    if !text.starts_with("jsbve-disabled:v1") { return Ok(None); }
    let (header, body) = text.split_once('\n').ok_or("已注释模块封装格式错误")?;
    let body = body.strip_suffix("\r\n").or_else(|| body.strip_suffix('\n')).ok_or("已注释模块封装格式错误")?;
    match header.trim_end() {
        "jsbve-disabled:v1 encoding=\"plain\"" => Ok(Some(body.to_string())),
        "jsbve-disabled:v1 encoding=\"base64\"" => {
            let encoded: Vec<u8> = body.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
            if encoded.len() % 4 != 0 { return Err("已注释模块 Base64 长度错误".into()); }
            let mut bytes = Vec::new();
            for (index, chunk) in encoded.chunks(4).enumerate() {
                let mut value = 0u32;
                let padding = chunk.iter().rev().take_while(|&&b| b == b'=').count();
                if padding > 2 || (padding > 0 && index + 1 != encoded.len() / 4) { return Err("已注释模块 Base64 填充错误".into()); }
                for (offset, b) in chunk.iter().enumerate() {
                    let digit = match b {
                        b'A'..=b'Z' => b - b'A', b'a'..=b'z' => b - b'a' + 26,
                        b'0'..=b'9' => b - b'0' + 52, b'+' => 62, b'/' => 63,
                        b'=' if offset >= 4 - padding => 0,
                        _ => return Err("已注释模块 Base64 编码错误".into()),
                    };
                    value = (value << 6) | digit as u32;
                }
                bytes.push((value >> 16) as u8);
                if padding < 2 { bytes.push((value >> 8) as u8); }
                if padding < 1 { bytes.push(value as u8); }
            }
            String::from_utf8(bytes).map(Some).map_err(|_| "已注释模块 UTF-8 编码错误".into())
        },
        _ => Err("已注释模块封装版本或编码不支持".into()),
    }
}
