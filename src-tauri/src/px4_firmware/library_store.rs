//! Bounded binary FTP access to the selected simulator's persistent home.
//! No desktop download files, firmware account, rediscovery or URL redirects.
use super::library::Store;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::sync::MutexGuard;
use std::time::Duration;

pub struct FtpStore {
    control: BufReader<TcpStream>,
    address: SocketAddr,
    ready: bool,
    pub root: String,
    _guard: MutexGuard<'static, ()>,
}
fn safe(path: &str) -> Result<(), String> {
    if path.len() > 200
        || path.split('/').any(|s| {
            s.is_empty()
                || s == "."
                || s == ".."
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("无效固件库路径".into());
    }
    Ok(())
}
impl FtpStore {
    pub fn open(host: Ipv4Addr) -> Result<Self, String> {
        let volumes = crate::romfs_network::with_host_session(host, |s| {
            crate::storage_usage::parse(&s.command(crate::storage_usage::COMMAND)?)
        })?;
        let root = if volumes
            .iter()
            .any(|v| v.mount_path == "/mnt/home" && v.total_bytes.is_some())
        {
            "/mnt/home/px4-firmware"
        } else if volumes
            .iter()
            .any(|v| v.mount_path == "/mnt/sdcard" && v.total_bytes.is_some())
        {
            "/mnt/sdcard/px4-firmware"
        } else {
            return Err("仿真机持久存储未挂载，无法保存固件；未开始刷写".into());
        };
        Self::connect((host, 21).into(), root.into())
    }
    fn connect(address: SocketAddr, root: String) -> Result<Self, String> {
        let guard = crate::ftp_sync::FTP_LOCK
            .lock()
            .map_err(|e| e.to_string())?;
        let stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
            .map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        let mut s = Self {
            control: BufReader::new(stream),
            address,
            ready: false,
            root,
            _guard: guard,
        };
        if s.reply()?.0 != 220 {
            return Err("固件库 FTP 服务未就绪".into());
        }
        let user = std::env::var("NUTTX_FTP_USER").unwrap_or_else(|_| "root".into());
        let password = std::env::var("NUTTX_FTP_PASSWORD").unwrap_or_else(|_| "abc123".into());
        if [user.as_str(), password.as_str()]
            .iter()
            .any(|s| s.contains(['\r', '\n']))
        {
            return Err("FTP 账号配置无效".into());
        }
        if s.command(&format!("USER {user}"), &[230, 331])?.0 == 331 {
            s.command(&format!("PASS {password}"), &[230])?;
        }
        s.command("TYPE I", &[200])?;
        s.ready = s.command("CWD px4-firmware", &[250, 550])?.0 == 250;
        Ok(s)
    }
    fn reply(&mut self) -> Result<(u16, String), String> {
        let mut text = String::new();
        let mut first = None;
        for _ in 0..32 {
            let mut line = String::new();
            let n = self
                .control
                .by_ref()
                .take(4097)
                .read_line(&mut line)
                .map_err(|e| e.to_string())?;
            if n == 0 || n > 4096 || !line.ends_with('\n') {
                return Err("FTP 响应不完整或过长".into());
            }
            if line.len() >= 4 && line.as_bytes()[..3].iter().all(u8::is_ascii_digit) {
                let code = line[..3].parse().map_err(|_| "FTP 状态无效")?;
                if first.is_none() {
                    first = Some(code);
                }
                if first == Some(code) && line.as_bytes()[3] == b' ' {
                    text.push_str(&line);
                    return Ok((code, text));
                }
            }
            text.push_str(&line);
        }
        Err("FTP 响应行数过多".into())
    }
    fn command(&mut self, command: &str, codes: &[u16]) -> Result<(u16, String), String> {
        self.control
            .get_mut()
            .write_all(format!("{command}\r\n").as_bytes())
            .map_err(|e| e.to_string())?;
        let result = self.reply()?;
        if !codes.contains(&result.0) {
            return Err(format!("固件库 FTP 操作失败 ({})", result.0));
        }
        Ok(result)
    }
    fn data(&mut self) -> Result<TcpStream, String> {
        let text = self.command("PASV", &[227])?.1;
        let values = text
            .split_once('(')
            .and_then(|(_, s)| s.split_once(')'))
            .ok_or("无效 FTP 被动端口")?
            .0
            .split(',')
            .map(|s| s.trim().parse::<u8>())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无效 FTP 被动端口")?;
        if values.len() != 6 {
            return Err("无效 FTP 被动端口".into());
        }
        let port = u16::from(values[4]) * 256 + u16::from(values[5]);
        if port == 0 {
            return Err("无效 FTP 被动端口".into());
        }
        let data = TcpStream::connect_timeout(
            &SocketAddr::new(self.address.ip(), port),
            Duration::from_secs(3),
        )
        .map_err(|e| e.to_string())?;
        data.set_read_timeout(Some(Duration::from_secs(15)))
            .map_err(|e| e.to_string())?;
        data.set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| e.to_string())?;
        data.set_nodelay(true).map_err(|e| e.to_string())?;
        Ok(data)
    }
    fn receive(&mut self, command: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
        let mut data = self.data()?;
        if self.command(command, &[125, 150, 550])?.0 == 550 {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut data)
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        drop(data);
        if bytes.len() > limit {
            return Err("固件库数据超过读取限制".into());
        }
        let code = self.reply()?.0;
        if code != 226 && code != 250 {
            return Err(format!("固件库数据传输未完成 ({code})"));
        }
        Ok(Some(bytes))
    }
}
impl Store for FtpStore {
    fn list(&mut self, path: &str) -> Result<Vec<String>, String> {
        if !self.ready {
            return Ok(Vec::new());
        }
        if !path.is_empty() {
            safe(path)?;
        }
        let command = if path.is_empty() {
            "NLST".into()
        } else {
            format!("NLST {path}")
        };
        let bytes = self.receive(&command, 1024 * 1024)?.unwrap_or_default();
        let text = std::str::from_utf8(&bytes).map_err(|_| "固件库目录编码无效")?;
        Ok(text
            .lines()
            .map(|s| {
                s.trim_end_matches('/')
                    .rsplit('/')
                    .next()
                    .unwrap_or("")
                    .to_string()
            })
            .collect())
    }
    fn get(&mut self, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
        safe(path)?;
        if !self.ready {
            return Ok(None);
        }
        // NuttX sends 550 for a missing RETR, then closes the control socket.
        // An empty listing of the existing parent is safe on that server.
        let (parent, name) = path.rsplit_once('/').ok_or("固件库文件路径无效")?;
        if !self.list(parent)?.iter().any(|entry| entry == name) {
            return Ok(None);
        }
        self.receive(&format!("RETR {path}"), limit)
    }
    fn mkdir(&mut self, path: &str) -> Result<(), String> {
        if !self.ready {
            self.command("MKD px4-firmware", &[250, 257])?;
            self.command("CWD px4-firmware", &[250])?;
            self.ready = true;
        }
        safe(path)?;
        if self.command(&format!("CWD {path}"), &[250, 550])?.0 == 250 {
            self.command("CWD ..", &[250])?;
        } else {
            self.command(&format!("MKD {path}"), &[250, 257])?;
        }
        Ok(())
    }
    fn put(&mut self, path: &str, bytes: &[u8]) -> Result<(), String> {
        safe(path)?;
        let mut data = self.data()?;
        self.command(&format!("STOR {path}"), &[125, 150])?;
        for chunk in bytes.chunks(4096) {
            data.write_all(chunk).map_err(|e| e.to_string())?;
            if bytes.len() > 4096 {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        data.shutdown(Shutdown::Write).map_err(|e| e.to_string())?;
        drop(data);
        let code = self.reply()?.0;
        if code != 226 && code != 250 {
            return Err(format!("固件库写入未完成 ({code})"));
        }
        Ok(())
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        safe(from)?;
        safe(to)?;
        self.command(&format!("RNFR {from}"), &[350])?;
        self.command(&format!("RNTO {to}"), &[250])?;
        Ok(())
    }
}
impl Drop for FtpStore {
    fn drop(&mut self) {
        let _ = self
            .control
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(500)));
        let _ = self.command("QUIT", &[221]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, net::TcpListener};
    #[test]
    fn binary_ftp_is_pinned_verified_and_requires_completion() {
        for incomplete in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                stream.set_nodelay(true).unwrap();
                let mut input = BufReader::new(stream.try_clone().unwrap());
                let mut output = stream;
                output.write_all(b"220 test\r\n").unwrap();
                let mut data = None;
                let mut files = BTreeMap::<String, Vec<u8>>::new();
                let mut rename = String::new();
                loop {
                    let mut line = String::new();
                    if input.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    let (cmd, path) = line
                        .trim_end()
                        .split_once(' ')
                        .unwrap_or((line.trim_end(), ""));
                    let reply = match cmd {
                        "USER" => "331 password\r\n",
                        "PASS" => "230 ok\r\n",
                        "TYPE" => "200 ok\r\n",
                        "CWD" => {
                            if path == "px4-firmware" || path == ".." {
                                "250 ok\r\n"
                            } else {
                                "550 missing\r\n"
                            }
                        }
                        "MKD" => "257 created\r\n",
                        "PASV" => {
                            let port = TcpListener::bind("127.0.0.1:0").unwrap();
                            let n = port.local_addr().unwrap().port();
                            data = Some(port);
                            // The advertised IP is intentionally wrong; connect to the pinned peer.
                            output
                                .write_all(
                                    format!("227 (203,0,113,99,{},{})\r\n", n / 256, n % 256)
                                        .as_bytes(),
                                )
                                .unwrap();
                            continue;
                        }
                        "STOR" => {
                            output.write_all(b"150 ready\r\n").unwrap();
                            let (mut channel, _) = data.take().unwrap().accept().unwrap();
                            let mut bytes = Vec::new();
                            channel.read_to_end(&mut bytes).unwrap();
                            files.insert(path.into(), bytes);
                            drop(channel);
                            if incomplete {
                                "426 incomplete\r\n"
                            } else {
                                "226 done\r\n"
                            }
                        }
                        "RETR" => {
                            if let Some(bytes) = files.get(path) {
                                output.write_all(b"150 ready\r\n").unwrap();
                                let (mut channel, _) = data.take().unwrap().accept().unwrap();
                                channel.write_all(bytes).unwrap();
                                drop(channel);
                                "226 done\r\n"
                            } else {
                                panic!("must not RETR a missing file on NuttX")
                            }
                        }
                        "NLST" => {
                            output.write_all(b"150 ready\r\n").unwrap();
                            let (mut channel, _) = data.take().unwrap().accept().unwrap();
                            let prefix = if path.is_empty() {
                                String::new()
                            } else {
                                format!("{path}/")
                            };
                            let names = files
                                .keys()
                                .filter_map(|k| k.strip_prefix(&prefix))
                                .map(|s| s.split('/').next().unwrap().to_string())
                                .collect::<std::collections::BTreeSet<_>>();
                            channel
                                .write_all(
                                    names
                                        .into_iter()
                                        .collect::<Vec<_>>()
                                        .join("\r\n")
                                        .as_bytes(),
                                )
                                .unwrap();
                            drop(channel);
                            "226 done\r\n"
                        }
                        "RNFR" => {
                            rename = path.into();
                            "350 ready\r\n"
                        }
                        "RNTO" => {
                            let bytes = files.remove(&rename).unwrap();
                            files.insert(path.into(), bytes);
                            "250 renamed\r\n"
                        }
                        "QUIT" => {
                            output.write_all(b"221 bye\r\n").unwrap();
                            break;
                        }
                        _ => panic!("unexpected FTP operation"),
                    };
                    output.write_all(reply.as_bytes()).unwrap();
                }
                files
            });
            {
                let mut store = FtpStore::connect(address, "test".into()).unwrap();
                store.mkdir("entry").unwrap();
                let bytes = (0..10000).map(|v| v as u8).collect::<Vec<_>>();
                if incomplete {
                    assert!(store.put("entry/part", &bytes).is_err());
                } else {
                    store.put("entry/part", &bytes).unwrap();
                    assert_eq!(store.get("entry/part", 10000).unwrap(), Some(bytes.clone()));
                    store.rename("entry/part", "entry/firmware.px4").unwrap();
                    assert_eq!(store.get("entry/firmware.px4", 10000).unwrap(), Some(bytes));
                    assert_eq!(store.get("entry/missing", 32).unwrap(), None);
                    assert_eq!(store.list("").unwrap(), vec!["entry"]);
                }
            }
            let files = server.join().unwrap();
            assert_eq!(files.contains_key("entry/firmware.px4"), !incomplete);
        }
    }
}
