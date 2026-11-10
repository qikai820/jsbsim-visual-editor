use std::io::Read;

pub const MAX_METADATA: usize = 16 * 1024 * 1024;
// PX4's preset-9 XZ streams need a 64 MiB dictionary plus decoder overhead.
const MAX_DECODER_MEMORY: u64 = 128 * 1024 * 1024;

pub fn decode(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() > MAX_METADATA { return Err("元数据超过 16 MiB".into()); }
    let data = if bytes.starts_with(b"\xfd7zXZ\0") {
        let stream = xz2::stream::Stream::new_stream_decoder(
            MAX_DECODER_MEMORY, xz2::stream::CONCATENATED,
        ).map_err(|error| format!("无法初始化 XZ 元数据解压器：{error}"))?;
        let mut data = Vec::new();
        xz2::read::XzDecoder::new_stream(bytes.as_slice(), stream)
            .take((MAX_METADATA + 1) as u64)
            .read_to_end(&mut data)
            .map_err(|error| format!("XZ 元数据解压失败：{error}"))?;
        if data.len() > MAX_METADATA { return Err("元数据解压后超过 16 MiB".into()); }
        data
    } else { bytes };
    String::from_utf8(data).map_err(|_| "元数据不是有效 UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn px4_preset9_metadata_and_plain_json() {
        let plain = br#"{"version":1,"metadataTypes":[]}"#;
        let compressed = include_bytes!("../../tests/fixtures/px4-general-preset9.json.xz");
        // This is the same independent Python lzma preset used by PX4's generator.
        assert_eq!(decode(compressed.to_vec()).unwrap().as_bytes(), plain);
        assert_eq!(decode(plain.to_vec()).unwrap().as_bytes(), plain);
    }

    #[test]
    fn invalid_and_truncated_streams_report_xz_failure() {
        assert!(decode(b"\xfd7zXZ\0broken".to_vec()).unwrap_err().contains("XZ 元数据解压失败"));
        let compressed = include_bytes!("../../tests/fixtures/px4-general-preset9.json.xz");
        assert!(decode(compressed[..compressed.len()-4].to_vec()).is_err());
        assert!(decode(vec![0xff, 0xfe]).unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn decompressed_metadata_keeps_size_limit() {
        let mut encoder = xz2::write::XzEncoder::new(Vec::new(), 0);
        encoder.write_all(&vec![b' '; MAX_METADATA + 1]).unwrap();
        assert!(decode(encoder.finish().unwrap()).unwrap_err().contains("超过 16 MiB"));
    }
}
