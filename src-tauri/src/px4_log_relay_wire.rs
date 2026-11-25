use serde::Serialize;
use std::{
    io::{ErrorKind, Read},
    time::{Duration, Instant},
};

pub(super) fn start_commands(request: &str) -> Result<(String, &'static str), String> {
    // The board's NSH has an 80-byte line buffer. Its 72-character request
    // fits in a short assignment and expands after the launch line is read.
    if request.len() != 72 || !request.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("任务机日志缓存启动参数无效".into());
    }
    Ok((format!("set L {request}"), "jsbsim router log $L"))
}

#[derive(Clone, Copy, Default, Serialize)]
pub struct Progress {
    pub(super) staged: u32,
    pub(super) saved: u32,
    pub(super) copying: bool,
}

fn read_exact(
    reader: &mut impl Read,
    mut remaining: &mut [u8],
    check: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut last = Instant::now();
    while !remaining.is_empty() {
        check()?;
        match reader.read(remaining) {
            Ok(0) => return Err("任务机日志连接提前关闭".into()),
            Ok(n) => {
                remaining = &mut remaining[n..];
                last = Instant::now();
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                ) =>
            {
                if last.elapsed() >= Duration::from_secs(20) {
                    return Err("等待任务机日志数据超时".into());
                }
            }
            Err(error) => return Err(format!("读取任务机日志失败：{error}")),
        }
    }
    Ok(())
}

pub(super) fn receive(
    reader: &mut impl Read,
    expected: u32,
    check: impl Fn() -> Result<(), String>,
    write: impl Fn(u32, &[u8]) -> Result<(), String>,
    report: impl Fn(Progress),
) -> Result<(), String> {
    let mut progress = Progress::default();
    loop {
        let mut header = [0; 5];
        read_exact(reader, &mut header, &check)?;
        let value = u32::from_le_bytes(header[1..].try_into().unwrap());
        match header[0] {
            b'P' if (progress.staged..=expected).contains(&value) => {
                progress.staged = value;
                report(progress);
            }
            b'E' if (1..=256).contains(&value) => {
                let mut error = vec![0; value as usize];
                read_exact(reader, &mut error, &check)?;
                return Err(format!(
                    "任务机日志下载失败：{}",
                    String::from_utf8_lossy(&error)
                ));
            }
            b'D' if value == expected && progress.staged == expected => break,
            _ => return Err("任务机日志响应格式或文件大小不匹配".into()),
        }
    }
    progress.copying = true;
    report(progress);
    let mut buffer = vec![0; 65536];
    while progress.saved < expected {
        let count = ((expected - progress.saved) as usize).min(buffer.len());
        read_exact(reader, &mut buffer[..count], &check)?;
        write(progress.saved, &buffer[..count])?;
        progress.saved += count as u32;
        report(progress);
    }
    check()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn cache_start_preserves_the_full_request_within_the_board_line_buffer() {
        let request = "0123456789abcdef".repeat(4) + "01234567";
        let (assignment, launch) = start_commands(&request).unwrap();
        for command in [assignment.as_str(), launch] {
            assert!(command.len() + 2 <= 80, "line must include LF and NUL");
        }
        let value = assignment.strip_prefix("set L ").unwrap();
        assert_eq!(
            launch.replace("$L", value),
            format!("jsbsim router log {request}")
        );
        assert!(start_commands(&request[..71]).is_err());
        assert!(start_commands(&format!("x{}", &request[1..])).is_err());
    }

    fn record(bytes: &mut Vec<u8>, kind: u8, value: u32) {
        bytes.push(kind);
        bytes.extend(value.to_le_bytes());
    }

    #[test]
    fn stages_then_copies_exact_binary_bytes() {
        let content: Vec<u8> = (0..70001).map(|i| (i % 251) as u8).collect();
        let expected = content.len() as u32;
        let mut stream = Vec::new();
        record(&mut stream, b'P', 500);
        record(&mut stream, b'P', expected);
        record(&mut stream, b'D', expected);
        stream.extend(&content);
        let output = RefCell::new(Vec::new());
        let progress = RefCell::new(Vec::new());
        receive(
            &mut stream.as_slice(),
            expected,
            || Ok(()),
            |offset, bytes| {
                let mut output = output.borrow_mut();
                assert_eq!(offset as usize, output.len());
                output.extend_from_slice(bytes);
                Ok(())
            },
            |value| progress.borrow_mut().push(value),
        )
        .unwrap();
        assert_eq!(output.into_inner(), content);
        let progress = progress.into_inner();
        assert_eq!(progress[1].staged, expected);
        assert!(!progress[1].copying);
        assert!(progress[2].copying);
        assert_eq!(progress.last().unwrap().saved, expected);
    }

    #[test]
    fn rejects_early_copy_wrong_length_and_truncated_body() {
        for (staged, announced, actual) in [(12, 16, 16), (16, 17, 16), (16, 16, 15)] {
            let mut stream = Vec::new();
            record(&mut stream, b'P', staged);
            record(&mut stream, b'D', announced);
            stream.extend(vec![0; actual]);
            assert!(receive(
                &mut stream.as_slice(),
                16,
                || Ok(()),
                |_, _| panic!("incomplete file reached the writer"),
                |_| {},
            )
            .is_err());
        }
    }
}
