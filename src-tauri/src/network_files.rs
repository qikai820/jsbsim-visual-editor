//! Managed SD/eMMC files over the board's existing Telnet NSH service.
//! Binary data uses hexdump/printf rather than a text cat round trip. Writes
//! are staged, read back, and renamed only after size and CRC verification.
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use crate::romfs_network::{with_session, NshSession};
use crate::usb_file::{crc32_fold, managed_volume, UsbFileEntry};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
const READ_CHUNK: usize = 16 * 1024;

fn absolute(path: &str, allow_root: bool) -> Result<String, String> {
    if allow_root && matches!(path, "sd" | "data") {
        return Ok(if path == "sd" { "/mnt/sdcard" } else { "/data" }.into());
    }
    let volume = managed_volume(path)?;
    let tail = path.split_once('/').unwrap().1;
    Ok(format!("{}/{tail}", if volume == "sd" { "/mnt/sdcard" } else { "/data" }))
}

// All caller-controlled paths are validated before quoting. NSH expands
// variables inside double quotes, so quote expansion characters explicitly.
fn quote(path: &str) -> String {
    format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\"")
        .replace('$', "\\$").replace('`', "\\`"))
}

fn checked(session: &mut NshSession<'_>, command: &str) -> Result<String, String> {
    // The shipping board's NSH LINE_MAX is 80, including the terminator.
    // Oversized input is executed as separate truncated commands by readline.
    if command.len() >= 80 { return Err("网络文件命令超过板端行长度限制".into()); }
    let output = session.command(command)?;
    if output.lines().any(|line| line.starts_with("nsh: ") || line.contains(": command not found")) {
        return Err(output.trim().to_string());
    }
    Ok(output)
}

fn set_path(session: &mut NshSession<'_>, variable: char, path: &str) -> Result<String, String> {
    checked(session, &format!("set {variable} ''"))?;
    let mut chunk = String::new();
    for ch in path.chars() {
        if chunk.len() + ch.len_utf8() > 24 {
            let escaped = quote(&chunk);
            checked(session, &format!("set {variable} \"${{{variable}}}{}\"", &escaped[1..escaped.len()-1]))?;
            chunk.clear();
        }
        chunk.push(ch);
    }
    if !chunk.is_empty() {
        let escaped = quote(&chunk);
        checked(session, &format!("set {variable} \"${{{variable}}}{}\"", &escaped[1..escaped.len()-1]))?;
    }
    Ok(format!("\"${variable}\""))
}

fn ensure_mounted(session: &mut NshSession<'_>, path: &str) -> Result<(), String> {
    let root = absolute(path.split('/').next().unwrap_or(""), true)?;
    let volumes = crate::storage_usage::parse(&checked(session, crate::storage_usage::COMMAND)?)?;
    if !volumes.iter().any(|volume| volume.mount_path == root && volume.total_bytes.is_some()) {
        return Err(format!("{} 未挂载，无法访问文件 ({root})", if root == "/data" { "eMMC data" } else { "SD 卡" }));
    }
    Ok(())
}

pub fn storage() -> Result<Vec<crate::storage_usage::StorageUsage>, String> {
    with_session(|session| crate::storage_usage::parse(&checked(session, crate::storage_usage::COMMAND)?))
}

fn take_field<'a>(rest: &mut &'a str) -> &'a str {
    *rest = rest.trim_start();
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let field = &rest[..end];
    *rest = &rest[end..];
    field
}

fn modified_epoch(date: &str, time: &str) -> Option<u64> {
    let parts = date.split('-').chain(time.split(':')).map(str::parse::<i64>).collect::<Result<Vec<_>, _>>().ok()?;
    let [year, month, day, hour, minute] = parts[..] else { return None; };
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) ||
        !(0..24).contains(&hour) || !(0..60).contains(&minute) { return None; }
    let y = year - i64::from(month <= 2);
    let era = y / 400;
    let yoe = y - era * 400;
    let m = month + if month > 2 { -3 } else { 9 };
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * m + 2) / 5 + day - 1 - 719468;
    u64::try_from(days * 86400 + hour * 3600 + minute * 60).ok()
}

fn parse_listing(output: &str) -> Result<Vec<UsbFileEntry>, String> {
    let mut entries = Vec::new();
    for line in output.lines() {
        let mut rest = line.trim_start();
        if rest.is_empty() || rest.ends_with(':') { continue; }
        let mode = take_field(&mut rest);
        if mode.len() != 10 || !matches!(mode.as_bytes()[0], b'd' | b'-') {
            return Err(format!("无法识别目录项目: {line}"));
        }
        let size = take_field(&mut rest).parse::<u64>().map_err(|_| format!("无效文件大小: {line}"))?;
        rest = rest.trim_start();
        let mut modified = None;
        let possible_date = rest.split_whitespace().next().unwrap_or("");
        if possible_date.len() == 10 && possible_date.as_bytes()[4] == b'-' && possible_date.as_bytes()[7] == b'-' {
            let date = take_field(&mut rest);
            let time = take_field(&mut rest);
            modified = modified_epoch(date, time);
        }
        let name = rest.trim_start().trim_end_matches('/');
        if name.is_empty() || matches!(name, "." | "..") { continue; }
        entries.push(UsbFileEntry { name: name.into(), directory: mode.starts_with('d'), size, modified });
    }
    Ok(entries)
}

fn list_in(session: &mut NshSession<'_>, path: &str) -> Result<Vec<UsbFileEntry>, String> {
    let target = set_path(session, 'A', &absolute(path, true)?)?;
    let output = checked(session, &format!("ls -l {target}"))?;
    let entries = parse_listing(&output)?;
    // Validate board-returned names as well as UI paths before recursion.
    for entry in &entries { managed_volume(&format!("{path}/{}", entry.name))?; }
    Ok(entries)
}

pub fn list(path: &str) -> Result<Vec<UsbFileEntry>, String> {
    absolute(path, true)?;
    with_session(|session| { ensure_mounted(session, path)?; list_in(session, path) })
}

fn stat_in(session: &mut NshSession<'_>, path: &str) -> Result<UsbFileEntry, String> {
    absolute(path, true)?;
    if matches!(path, "sd" | "data") {
        return Ok(UsbFileEntry { name: path.into(), directory: true, size: 0, modified: None });
    }
    let (parent, name) = path.rsplit_once('/').ok_or("invalid file path")?;
    list_in(session, parent)?.into_iter().find(|entry| entry.name == name)
        .ok_or_else(|| format!("文件不存在: {path} (errno 2)"))
}

pub fn stat(path: &str) -> Result<UsbFileEntry, String> {
    absolute(path, true)?;
    with_session(|session| { ensure_mounted(session, path)?; stat_in(session, path) })
}

fn parse_hex(output: &str, expected: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(expected);
    for line in output.lines() {
        let Some((offset, values)) = line.split_once(':') else { continue; };
        if offset.len() < 4 || !offset.bytes().all(|byte| byte.is_ascii_hexdigit()) { continue; }
        // NSH renders at most 16 hex bytes, followed by an ASCII column.
        // Split the fixed-width hex column so ASCII such as "ab" is never
        // mistaken for an additional byte on a short final row.
        let column = values.get(..values.len().min(49)).unwrap_or(values);
        for value in column.split_whitespace().take(16) {
            if value.len() != 2 { return Err("无效网络文件十六进制数据".into()); }
            bytes.push(u8::from_str_radix(value, 16).map_err(|_| "无效网络文件十六进制数据")?);
        }
    }
    if bytes.len() != expected { return Err(format!("网络文件读取长度不符: {} / {expected}", bytes.len())); }
    Ok(bytes)
}

fn read_into(session: &mut NshSession<'_>, path: &str, writer: &mut impl Write, limit: u64) -> Result<(u64, u32), String> {
    let info = stat_in(session, path)?;
    if info.directory { return Err("请选择普通文件".into()); }
    if info.size > limit { return Err(format!("文件大小超过读取限制 ({limit} bytes)")); }
    let mut offset = 0u64;
    let mut checksum = u32::MAX;
    let target = set_path(session, 'A', &absolute(path, false)?)?;
    while offset < info.size {
        let count = (info.size - offset).min(READ_CHUNK as u64) as usize;
        let output = checked(session, &format!("hexdump {target} skip={offset} count={count}"))?;
        let bytes = parse_hex(&output, count)?;
        writer.write_all(&bytes).map_err(|error| error.to_string())?;
        checksum = crc32_fold(checksum, &bytes);
        offset += bytes.len() as u64;
    }
    if stat_in(session, path)?.size != info.size { return Err("设备上的文件在读取期间发生变化".into()); }
    Ok((offset, !checksum))
}

pub fn read_limited(path: &str, limit: usize) -> Result<Vec<u8>, String> {
    absolute(path, false)?;
    with_session(|session| {
        ensure_mounted(session, path)?;
        let mut bytes = Vec::new();
        read_into(session, path, &mut bytes, limit as u64)?;
        Ok(bytes)
    })
}

pub fn download_to_fingerprint(path: &str, target: &Path) -> Result<(u64, u32), String> {
    absolute(path, false)?;
    with_session(|session| {
        ensure_mounted(session, path)?;
        let mut file = std::fs::File::create(target).map_err(|error| error.to_string())?;
        let result = read_into(session, path, &mut file, u64::MAX)?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(result)
    })
}

pub fn fingerprint(path: &str) -> Result<(u64, u32), String> {
    absolute(path, false)?;
    with_session(|session| { ensure_mounted(session, path)?; read_into(session, path, &mut std::io::sink(), u64::MAX) })
}

fn temporary(session: &mut NshSession<'_>, parent: &str) -> Result<String, String> {
    let entries = list_in(session, parent)?;
    for _ in 0..16 {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let name = format!(".netpart{:x}{id:x}", std::process::id());
        let path = format!("{parent}/{name}");
        absolute(&path, false)?;
        if !entries.iter().any(|entry| entry.name == name) { return Ok(path); }
    }
    Err("无法分配网络传输临时文件".into())
}

fn printf_arguments(bytes: &[u8], budget: usize) -> (String, usize) {
    let mut used = 0;
    let mut arguments = Vec::new();
    while used < bytes.len() && arguments.len() < 4 {
        let tail = &bytes[used..];
        // NSH scans redirection before removing quotes. Encode shell syntax
        // even inside a quoted printf argument (notably XML '<' and '>').
        let printable = tail.iter().take(24).take_while(|&&byte| (32..=126).contains(&byte) &&
            !matches!(byte, b'\'' | b'\\' | b'"' | b'<' | b'>' | b'$' | b'`' | b'#' | b';' | b'|' | b'&')).count();
        let (argument, count) = if printable > 0 {
            (format!("'{}'", std::str::from_utf8(&tail[..printable]).unwrap()), printable)
        } else {
            // NuttX printf emits a little-endian 1, 2, or 4 byte value for
            // each \x argument; it does not implement POSIX printf escapes.
            let count = if tail.len() >= 4 { 4 } else if tail.len() >= 2 { 2 } else { 1 };
            let hex = tail[..count].iter().rev().map(|byte| format!("{byte:02x}")).collect::<String>();
            (format!("'\\x{hex}'"), count)
        };
        if arguments.iter().map(String::len).sum::<usize>() + arguments.len() + argument.len() > budget { break; }
        arguments.push(argument);
        used += count;
    }
    (arguments.join(" "), used)
}

fn upload_in(session: &mut NshSession<'_>, path: &str, reader: &mut impl Read) -> Result<u64, String> {
    let (parent, name) = path.rsplit_once('/').ok_or("invalid file path")?;
    if list_in(session, parent)?.iter().any(|entry| entry.name == name && entry.directory) {
        return Err("目标已有同名目录".into());
    }
    let staging = temporary(session, parent)?;
    let parent_arg = set_path(session, 'A', &absolute(parent, true)?)?;
    checked(session, &format!("cd {parent_arg}"))?;
    let quoted = quote(staging.rsplit('/').next().unwrap());
    let result = (|| {
        checked(session, &format!("printf '' > {quoted}"))?;
        let mut checksum = u32::MAX;
        let mut size = 0u64;
        let mut buffer = [0u8; 576];
        loop {
            let count = reader.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 { break; }
            checksum = crc32_fold(checksum, &buffer[..count]);
            size += count as u64;
            let mut offset = 0;
            while offset < count {
                let (arguments, used) = printf_arguments(&buffer[offset..count], 79 - "printf  >> ".len() - quoted.len());
                if used == 0 { return Err("网络文件命令无法容纳数据".into()); }
                checked(session, &format!("printf {arguments} >> {quoted}"))?;
                offset += used;
            }
        }
        let actual = read_into(session, &staging, &mut std::io::sink(), size)?;
        if actual != (size, !checksum) { return Err("网络上传读回校验失败，未替换目标文件".into()); }
        let destination = set_path(session, 'B', &absolute(path, false)?)?;
        checked(session, &format!("mv {quoted} {destination}"))?;
        Ok(size)
    })();
    if result.is_err() { let _ = checked(session, &format!("rm {quoted}")); }
    result
}

pub fn write_all(path: &str, bytes: &[u8]) -> Result<(), String> {
    absolute(path, false)?;
    with_session(|session| {
        ensure_mounted(session, path)?;
        upload_in(session, path, &mut std::io::Cursor::new(bytes)).map(|_| ())
    })
}

pub fn upload_from(path: &str, source: &Path) -> Result<u64, String> {
    absolute(path, false)?;
    let mut file = std::fs::File::open(source).map_err(|error| error.to_string())?;
    with_session(|session| { ensure_mounted(session, path)?; upload_in(session, path, &mut file) })
}

fn remove_in(session: &mut NshSession<'_>, path: &str, recursive: bool) -> Result<(), String> {
    absolute(path, false)?;
    let info = stat_in(session, path)?;
    if info.directory && recursive {
        // Read the complete tree before deleting any entries.
        let mut pending = vec![path.to_string()];
        let mut directories = Vec::new();
        let mut files = Vec::new();
        while let Some(parent) = pending.pop() {
            for entry in list_in(session, &parent)? {
                let child = format!("{parent}/{}", entry.name);
                if entry.directory { pending.push(child); } else { files.push(child); }
            }
            directories.push(parent);
        }
        for file in files {
            let target = set_path(session, 'A', &absolute(&file, false)?)?;
            checked(session, &format!("rm {target}"))?;
        }
        for directory in directories.into_iter().rev() {
            let target = set_path(session, 'A', &absolute(&directory, false)?)?;
            checked(session, &format!("rmdir {target}"))?;
        }
    } else {
        let target = set_path(session, 'A', &absolute(path, false)?)?;
        checked(session, &format!("{} {target}", if info.directory { "rmdir" } else { "rm" }))?;
    }
    Ok(())
}

pub fn delete(path: &str) -> Result<(), String> {
    absolute(path, false)?;
    with_session(|session| { ensure_mounted(session, path)?; remove_in(session, path, false) })
}

pub fn delete_directory_tree(path: &str) -> Result<(), String> {
    absolute(path, false)?;
    with_session(|session| { ensure_mounted(session, path)?; remove_in(session, path, true) })
}

pub fn mkdir(path: &str) -> Result<(), String> {
    let target = absolute(path, false)?;
    with_session(|session| {
        ensure_mounted(session, path)?;
        let target = set_path(session, 'A', &target)?;
        checked(session, &format!("mkdir {target}")).map(|_| ())
    })
}

fn copy_in(session: &mut NshSession<'_>, source: &str, destination: &str) -> Result<(), String> {
    if stat_in(session, source)?.directory {
        let target = set_path(session, 'A', &absolute(destination, false)?)?;
        checked(session, &format!("mkdir {target}"))?;
        for entry in list_in(session, source)? {
            copy_in(session, &format!("{source}/{}", entry.name), &format!("{destination}/{}", entry.name))?;
        }
    } else {
        let before = read_into(session, source, &mut std::io::sink(), u64::MAX)?;
        let from = set_path(session, 'A', &absolute(source, false)?)?;
        let to = set_path(session, 'B', &absolute(destination, false)?)?;
        checked(session, &format!("cp {from} {to}"))?;
        if read_into(session, destination, &mut std::io::sink(), u64::MAX)? != before ||
            read_into(session, source, &mut std::io::sink(), u64::MAX)? != before {
            return Err("拷贝读回校验失败，原文件已保留".into());
        }
    }
    Ok(())
}

pub fn transfer(source: &str, destination: &str, move_source: bool) -> Result<(), String> {
    let source_volume = managed_volume(source)?;
    let destination_volume = managed_volume(destination)?;
    if source == destination || destination.starts_with(&format!("{source}/")) { return Err("目标不能是源目录本身或其子目录".into()); }
    with_session(|session| {
        ensure_mounted(session, source)?;
        ensure_mounted(session, destination)?;
        let (parent, name) = destination.rsplit_once('/').unwrap();
        if list_in(session, parent)?.iter().any(|entry| entry.name == name) { return Err("目标位置已有同名文件或目录".into()); }
        if move_source && source_volume == destination_volume {
            let from = set_path(session, 'A', &absolute(source, false)?)?;
            let to = set_path(session, 'B', &absolute(destination, false)?)?;
            checked(session, &format!("mv {from} {to}"))?;
            return Ok(());
        }
        let staging = temporary(session, parent)?;
        let result = (|| {
            copy_in(session, source, &staging)?;
            let from = set_path(session, 'A', &absolute(&staging, false)?)?;
            let to = set_path(session, 'B', &absolute(destination, false)?)?;
            checked(session, &format!("mv {from} {to}"))?;
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            if let Err(cleanup) = remove_in(session, &staging, true) {
                return Err(format!("{error}; 临时文件清理失败: {cleanup}"));
            }
            return Err(error);
        }
        if move_source { remove_in(session, source, true).map_err(|error| format!("目标已拷贝，原位置清理失败: {error}"))?; }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nuttx_names_dates_and_root_pseudo_entry() {
        let entries = parse_listing("/data:\n -rw-rw-rw- 13 2026-09-19 07:35 a file.txt\n drw-rw-rw- 0 /\n drw-rw-rw- 0 folder/\n").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "a file.txt");
        assert_eq!(entries[0].size, 13);
        assert_eq!(entries[0].modified, Some(1789803300));
        assert!(entries[1].directory);
        assert!(parse_listing("nsh: ls: stat failed: 2").is_err());
    }

    #[test]
    fn binary_hex_does_not_parse_the_ascii_column() {
        assert_eq!(parse_hex("/data/a at 00000000:\n0000: 61 62                                            ab\n", 2).unwrap(), b"ab");
        assert!(parse_hex("0000: 61 62                                            ab\n", 3).is_err());
    }

    #[test]
    fn confines_paths_and_quotes_shell_expansions() {
        for path in ["sd", "data", "data/../etc/x", "/data/a", "data/a\nb"] { assert!(absolute(path, false).is_err(), "{path}"); }
        assert_eq!(absolute("data/a b's;$x`y`", false).unwrap(), "/data/a b's;$x`y`");
        assert_eq!(quote("/data/a b's;$x`y`"), "\"/data/a b's;\\$x\\`y\\`\"");
    }

    #[test]
    fn printf_uses_nuttx_little_endian_words_and_bounded_arguments() {
        assert_eq!(printf_arguments(&[0, 1, 2, 3, 4, 5, 6], 64), ("'\\x03020100' '\\x0504' '\\x06'".into(), 7));
        let (arguments, used) = printf_arguments(b"<xml>$value `text` %s</xml>\n", 40);
        assert!(!arguments.contains(['<', '>', '$', '`']));
        assert!(used > 0);
    }
}
