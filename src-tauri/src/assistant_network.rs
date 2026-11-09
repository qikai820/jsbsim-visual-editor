//! Socket transports for the local serial/network debugging assistant.
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

const IO_TIMEOUT: Duration = Duration::from_millis(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
pub const MAX_DATAGRAM: usize = 65_507;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum NetworkMode { TcpClient, TcpServer, Udp }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    pub mode: NetworkMode,
    pub host: String,
    pub port: u16,
    pub local_host: String,
    pub local_port: u16,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub datagram: bool,
}

pub enum NetworkRead {
    Idle,
    Endpoint,
    Data(usize, PacketMeta),
}

pub enum NetworkTransport {
    TcpClient(TcpStream),
    TcpServer { listener: TcpListener, peer: Option<TcpStream>, epoch: u64 },
    Udp { socket: UdpSocket, target: Option<SocketAddr>, last_sender: Option<SocketAddr> },
}

fn configure_stream(stream: &TcpStream) -> Result<(), String> {
    stream.set_nonblocking(false).map_err(|error| error.to_string())?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(|error| error.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(1))).map_err(|error| error.to_string())?;
    stream.set_nodelay(true).map_err(|error| error.to_string())
}

fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    if host.trim().is_empty() || port == 0 { return Err("请输入目标地址和 1～65535 的目标端口".into()); }
    let addresses: Vec<_> = (host.trim(), port).to_socket_addrs()
        .map_err(|error| format!("目标地址无效：{error}"))?.collect();
    if addresses.is_empty() { return Err("目标地址未解析到 IP".into()); }
    Ok(addresses)
}

impl NetworkTransport {
    pub fn pin_peer(&mut self, address: SocketAddr) -> Result<(), String> {
        match self {
            Self::Udp { socket, target, .. } => {
                if socket.local_addr().map_err(|e| e.to_string())?.is_ipv4() != address.is_ipv4() {
                    return Err("UDP 目标地址的 IP 版本不匹配".into());
                }
                *target = Some(address);
                Ok(())
            }
            _ => Err("仅 UDP 通道支持固定回复目标".into()),
        }
    }

    pub fn open(config: &NetworkConfig) -> Result<Self, String> {
        if config.mode == NetworkMode::TcpClient {
            let addresses = resolve(&config.host, config.port)?;
            let deadline = Instant::now() + CONNECT_TIMEOUT;
            let mut last_error = "连接超时".to_string();
            for address in addresses {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() { break; }
                match TcpStream::connect_timeout(&address, remaining) {
                    Ok(stream) => { configure_stream(&stream)?; return Ok(Self::TcpClient(stream)); }
                    Err(error) => last_error = error.to_string(),
                }
            }
            return Err(format!("TCP 连接失败：{last_error}"));
        }
        let local_ip: IpAddr = config.local_host.trim().parse().map_err(|_| "本地地址须为 IPv4 或 IPv6 地址".to_string())?;
        let local = SocketAddr::new(local_ip, config.local_port);
        if config.mode == NetworkMode::TcpServer {
            let listener = TcpListener::bind(local).map_err(|error| format!("TCP 监听失败：{error}"))?;
            listener.set_nonblocking(true).map_err(|error| error.to_string())?;
            return Ok(Self::TcpServer { listener, peer: None, epoch: 0 });
        }
        let target = if config.host.trim().is_empty() { None } else {
            Some(resolve(&config.host, config.port)?.into_iter().find(|address| address.is_ipv4() == local.is_ipv4())
                .ok_or("目标地址与本地地址的 IP 版本不一致")?)
        };
        let socket = UdpSocket::bind(local).map_err(|error| format!("UDP 绑定失败：{error}"))?;
        socket.set_read_timeout(Some(IO_TIMEOUT)).map_err(|error| error.to_string())?;
        socket.set_write_timeout(Some(Duration::from_secs(1))).map_err(|error| error.to_string())?;
        socket.set_broadcast(true).map_err(|error| error.to_string())?;
        Ok(Self::Udp { socket, target, last_sender: None })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        match self {
            Self::TcpClient(stream) => stream.local_addr(),
            Self::TcpServer { listener, .. } => listener.local_addr(),
            Self::Udp { socket, .. } => socket.local_addr(),
        }
    }

    pub fn peer_addr(&self) -> Option<SocketAddr> {
        match self {
            Self::TcpClient(stream) => stream.peer_addr().ok(),
            Self::TcpServer { peer, .. } => peer.as_ref().and_then(|stream| stream.peer_addr().ok()),
            Self::Udp { target, last_sender, .. } => target.or(*last_sender),
        }
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<PacketMeta, String> {
        let peer = self.peer_addr().map(|address| address.to_string());
        let (result, stream_id, datagram) = match self {
            Self::TcpClient(stream) => (stream.write_all(bytes), Some(0), false),
            Self::TcpServer { peer: Some(stream), epoch, .. } => (stream.write_all(bytes), Some(*epoch), false),
            Self::TcpServer { .. } => return Err("TCP 服务端正在等待客户端连接".into()),
            Self::Udp { socket, target, last_sender } => {
                if bytes.len() > MAX_DATAGRAM { return Err("单个 UDP 报文最多 65507 字节".into()); }
                let address = target.or(*last_sender).ok_or("请设置 UDP 目标地址，或先接收一个报文后回复来源")?;
                let result = socket.send_to(bytes, address).and_then(|sent| {
                    if sent == bytes.len() { Ok(()) } else { Err(io::Error::new(io::ErrorKind::WriteZero, "UDP 报文未完整发送")) }
                });
                (result, None, true)
            }
        };
        result.map_err(|error| format!("网口发送失败：{error}"))?;
        Ok(PacketMeta { peer, stream_id, datagram })
    }

    pub fn read(&mut self, buffer: &mut [u8]) -> io::Result<NetworkRead> {
        match self {
            Self::TcpClient(stream) => match stream.read(buffer) {
                Ok(0) => Err(io::Error::new(io::ErrorKind::UnexpectedEof, "TCP 对端已关闭连接")),
                Ok(count) => Ok(NetworkRead::Data(count, PacketMeta { peer: stream.peer_addr().ok().map(|a| a.to_string()), stream_id: Some(0), datagram: false })),
                Err(error) if idle_error(&error) => Ok(NetworkRead::Idle),
                Err(error) => Err(error),
            },
            Self::TcpServer { listener, peer, epoch } => {
                if peer.is_none() {
                    match listener.accept() {
                        Ok((stream, _)) => { configure_stream(&stream).map_err(io::Error::other)?; *peer = Some(stream); *epoch += 1; return Ok(NetworkRead::Endpoint); }
                        Err(error) if idle_error(&error) => { std::thread::sleep(IO_TIMEOUT); return Ok(NetworkRead::Idle); }
                        Err(error) => return Err(error),
                    }
                }
                let stream = peer.as_mut().unwrap();
                match stream.read(buffer) {
                    Ok(0) => { *peer = None; Ok(NetworkRead::Endpoint) }
                    Ok(count) => Ok(NetworkRead::Data(count, PacketMeta { peer: stream.peer_addr().ok().map(|a| a.to_string()), stream_id: Some(*epoch), datagram: false })),
                    Err(error) if idle_error(&error) => Ok(NetworkRead::Idle),
                    Err(error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted | io::ErrorKind::BrokenPipe) => {
                        *peer = None; Ok(NetworkRead::Endpoint)
                    }
                    Err(error) => Err(error),
                }
            }
            Self::Udp { socket, last_sender, .. } => match socket.recv_from(buffer) {
                Ok((count, address)) => {
                    *last_sender = Some(address);
                    Ok(NetworkRead::Data(count, PacketMeta { peer: Some(address.to_string()), stream_id: None, datagram: true }))
                }
                Err(error) if idle_error(&error) => Ok(NetworkRead::Idle),
                Err(error) => Err(error),
            },
        }
    }
}

fn idle_error(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted)
}
