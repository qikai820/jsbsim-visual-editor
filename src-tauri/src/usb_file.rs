//! Private file RPC over the LMX93 vendor-specific USB bulk interface.
//!
//! The interface binds to WinUSB on Windows and usbfs/libusb on Linux.  It is
//! deliberately not MTP or mass storage, so Explorer and desktop file
//! managers cannot browse the board.

use rusb::{Context, DeviceHandle, UsbContext};
use serde::Serialize;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, Instant};
use std::{io::{Read, Seek, SeekFrom, Write}, path::Path};

const VID: u16 = 0x1209;
const PID: u16 = 0x93a1;
const INTERFACE: u8 = 0;
const FILE_OUT: u8 = 0x03;
const FILE_IN: u8 = 0x83;
const SIM_OUT: u8 = 0x02;
const SIM_IN: u8 = 0x82;
const MAGIC: u32 = 0x3153_424a;
const VERSION: u16 = 1;
const HEADER_SIZE: usize = 32;
const MAX_PAYLOAD: usize = 16 * 1024;
const TIMEOUT: Duration = Duration::from_secs(3);
const LIST_TIMEOUT: Duration = Duration::from_secs(8);
const FIRMWARE_UPDATE_TIMEOUT: Duration = Duration::from_secs(120);
/* Automatic transport selection must never hold the live simulation link for
 * a file-service timeout.  Probe with a short PING before choosing USB;
 * a directory LIST can legitimately take longer on a busy SD card. */
const AUTO_FILE_TIMEOUT: Duration = Duration::from_millis(300);
const AUTO_LOCK_WAIT: Duration = Duration::from_millis(150);
/* The simulation connection is a live UI transport, not a file transfer.
 * Keep disconnect/re-enumeration failures short so they can never stall a
 * heartbeat or occupy the desktop runtime's blocking pool for seconds. */
const SIM_TIMEOUT: Duration = Duration::from_millis(250);
const SIM_READ_TIMEOUT: Duration = Duration::from_millis(100);

const PING: u16 = 1;
const LIST: u16 = 2;
const STAT: u16 = 3;
const READ: u16 = 4;
const WRITE_BEGIN: u16 = 5;
const WRITE_DATA: u16 = 6;
const WRITE_COMMIT: u16 = 7;
const DELETE: u16 = 8;
const MKDIR: u16 = 9;
const WRITE_ABORT: u16 = 10;
const UPDATE: u16 = 11;
const NSH_EXEC: u16 = 12;
const RENAME: u16 = 13;
const CONSOLE_READ: u16 = 14;
const NSH_EXEC_TIMEOUT: Duration = Duration::from_secs(8);

static REQUEST_ID: OnceLock<AtomicU32> = OnceLock::new();
static USB_ACCESS: UsbAccess = UsbAccess::new();
// EP3 responses have no independent reader. Keep one file request in flight
// even when a slow NSH command releases the interface for EP2 telemetry.
static FILE_ACCESS: Mutex<()> = Mutex::new(());

// std::sync::Mutex does not guarantee fairness: a continuous telemetry reader
// can reacquire it ahead of a sleeping file writer indefinitely. Announce
// waiting operations so the next telemetry poll yields, and bound lock waits
// separately from the libusb I/O timeouts (which only start after acquisition).
struct UsbAccess {
    lock: Mutex<()>,
    waiting: AtomicUsize,
}

struct UsbWaiter<'a>(&'a AtomicUsize);
impl Drop for UsbWaiter<'_> {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); }
}

impl UsbAccess {
    const fn new() -> Self {
        Self { lock: Mutex::new(()), waiting: AtomicUsize::new(0) }
    }

    fn acquire(&self, timeout: Duration) -> Result<MutexGuard<'_, ()>, String> {
        self.waiting.fetch_add(1, Ordering::SeqCst);
        let _waiter = UsbWaiter(&self.waiting);
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match self.lock.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(_)) => return Err("USB transport lock poisoned".into()),
                Err(TryLockError::WouldBlock) => {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        return Err("USB 通道忙，等待超时；本次请求尚未发送，请稍后重试 (USB transport busy: lock wait timed out)".into());
                    }
                    std::thread::sleep(remaining.min(Duration::from_millis(5)));
                    if std::time::Instant::now() >= deadline {
                        return Err("USB 通道忙，等待超时；本次请求尚未发送，请稍后重试 (USB transport busy: lock wait timed out)".into());
                    }
                }
            }
        }
    }

    fn telemetry(&self) -> Result<MutexGuard<'_, ()>, String> {
        if self.waiting.load(Ordering::SeqCst) != 0 {
            return Err("simulation USB transport is busy".into());
        }
        self.lock.try_lock().map_err(|_| "simulation USB transport is busy".into())
    }
}
// Keep incomplete EP3 responses across timeouts. The next transaction must
// consume their complete frames before looking for its own request ID.
static FILE_RX: Mutex<Vec<u8>> = Mutex::new(Vec::new());

fn next_request_id() -> u32 {
    REQUEST_ID.get_or_init(|| {
        // Restarting the app must not reuse request 1 while an old request 1
        // response remains queued on the board. No new dependency is needed.
        let seed = std::collections::hash_map::RandomState::new().build_hasher().finish() as u32;
        AtomicU32::new(seed)
    }).fetch_add(1, Ordering::Relaxed)
}
/* USB bulk preserves byte order, not application-message boundaries.  A
 * visual SIM1 record can be larger than the endpoint's 512-byte max packet,
 * so retain partial data across libusb reads until its complete length is
 * available. */
static SIM_RX: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[derive(Debug)]
struct Response {
    status: i32,
    offset: u64,
    payload: Vec<u8>,
}

#[derive(Debug, Serialize)]
pub struct UsbFileEntry {
    pub name: String,
    pub directory: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct UsbStatus {
    pub connected: bool,
    pub identity: Option<String>,
    pub vid: u16,
    pub pid: u16,
}

#[derive(Debug, Clone, Copy)]
pub enum FirmwareUpdatePhase {
    Write,
    Verify,
}

#[derive(Debug, Clone, Copy)]
pub struct FirmwareUpdateProgress {
    pub phase: FirmwareUpdatePhase,
    pub completed: u64,
    pub total: u64,
}

pub fn crc32(data: &[u8]) -> u32 {
    !crc32_fold(u32::MAX, data)
}

pub(crate) fn crc32_fold(mut crc: u32, data: &[u8]) -> u32 {
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    crc
}

fn open() -> Result<DeviceHandle<Context>, String> {
    let context = Context::new()
        .map_err(|error| format!("cannot initialize libusb: {error}"))?;
    let handle = context.open_device_with_vid_pid(VID, PID)
        .ok_or_else(|| format!("USB device {VID:04x}:{PID:04x} not found"))?;
    let _ = handle.set_auto_detach_kernel_driver(true);
    handle
        .claim_interface(INTERFACE)
        .map_err(|error| format!("cannot claim USB interface {INTERFACE}: {error}"))?;
    Ok(handle)
}

fn write_exact(handle: &DeviceHandle<Context>, mut data: &[u8], timeout: Duration) -> Result<(), String> {
    while !data.is_empty() {
        let count = handle
            .write_bulk(FILE_OUT, data, timeout)
            .map_err(|error| format!("USB bulk write failed: {error}"))?;
        if count == 0 {
            return Err("USB bulk write returned zero bytes".into());
        }
        data = &data[count..];
    }
    Ok(())
}

fn take_file_response(buffer: &mut Vec<u8>, opcode: u16, request_id: u32) -> Result<Option<Response>, String> {
    loop {
        // A previous process may have consumed only a header before timing
        // out. Scan past its orphaned payload, retaining a partial magic word.
        let Some(start) = buffer.windows(4).position(|bytes| bytes == MAGIC.to_le_bytes()) else {
            let discard = buffer.len().saturating_sub(3);
            buffer.drain(..discard);
            return Ok(None);
        };
        buffer.drain(..start);
        if buffer.len() < HEADER_SIZE { return Ok(None); }
        let version = u16::from_le_bytes(buffer[4..6].try_into().unwrap());
        let response_opcode = u16::from_le_bytes(buffer[6..8].try_into().unwrap());
        let response_id = u32::from_le_bytes(buffer[8..12].try_into().unwrap());
        let status = i32::from_le_bytes(buffer[12..16].try_into().unwrap());
        let length = u32::from_le_bytes(buffer[16..20].try_into().unwrap()) as usize;
        let offset = u64::from_le_bytes(buffer[20..28].try_into().unwrap());
        let checksum = u32::from_le_bytes(buffer[28..32].try_into().unwrap());
        if version != VERSION || response_opcode & 0x8000 == 0 || length > MAX_PAYLOAD {
            buffer.drain(..1);
            continue;
        }
        if buffer.len() < HEADER_SIZE + length { return Ok(None); }
        let payload = buffer[HEADER_SIZE..HEADER_SIZE + length].to_vec();
        buffer.drain(..HEADER_SIZE + length);
        if response_id != request_id {
            // Never interpret a late response as the current operation, and
            // never resend writes automatically after an ambiguous timeout.
            continue;
        }
        if response_opcode != (opcode | 0x8000) {
            return Err("USB response opcode does not match current request".into());
        }
        if crc32(&payload) != checksum {
            return Err("USB response CRC32 mismatch".into());
        }
        return Ok(Some(Response { status, offset, payload }));
    }
}

fn poll_file_response(
    handle: &DeviceHandle<Context>,
    opcode: u16,
    request_id: u32,
    timeout: Duration,
) -> Result<Option<Response>, String> {
    let mut buffer = FILE_RX.lock().map_err(|_| "USB file receive buffer lock poisoned")?;
    let deadline = std::time::Instant::now() + timeout;
    // Always read multiples of the endpoint's 512-byte packet size. Reading
    // a 304-byte queued payload into a 32-byte header buffer causes Overflow.
    // One max-size packet also avoids waiting for a short packet/ZLP when
    // the board finishes a payload whose size is exactly divisible by 512.
    let mut packet = [0u8; 512];
    loop {
        if let Some(response) = take_file_response(&mut buffer, opcode, request_id)? {
            return Ok(Some(response));
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        // libusb interprets a zero millisecond timeout as infinite.
        if remaining.as_millis() == 0 {
            return Ok(None);
        }
        match handle.read_bulk(FILE_IN, &mut packet, remaining) {
            Ok(count) => buffer.extend_from_slice(&packet[..count]),
            Err(rusb::Error::Timeout) => return Ok(None),
            Err(error) => return Err(format!("USB bulk read failed (opcode={opcode}): {error}")),
        }
    }
}

fn read_file_response(
    handle: &DeviceHandle<Context>, opcode: u16, request_id: u32,
    timeout: Duration,
) -> Result<Response, String> {
    poll_file_response(handle, opcode, request_id, timeout)?.ok_or_else(|| {
        let buffered = FILE_RX.lock().map(|buffer| buffer.len()).unwrap_or(0);
        format!("USB file response timed out (opcode={opcode}, request={request_id}, buffered={buffered} bytes)")
    })
}

fn write_file_request(
    handle: &DeviceHandle<Context>,
    opcode: u16,
    status: i32,
    offset: u64,
    payload: &[u8],
    request_id: u32,
    timeout: Duration,
) -> Result<(), String> {
    if payload.len() > MAX_PAYLOAD {
        return Err(format!("USB payload exceeds {MAX_PAYLOAD} bytes"));
    }

    let mut header = [0u8; HEADER_SIZE];
    header[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    header[4..6].copy_from_slice(&VERSION.to_le_bytes());
    header[6..8].copy_from_slice(&opcode.to_le_bytes());
    header[8..12].copy_from_slice(&request_id.to_le_bytes());
    header[12..16].copy_from_slice(&status.to_le_bytes());
    header[16..20].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    header[20..28].copy_from_slice(&offset.to_le_bytes());
    header[28..32].copy_from_slice(&if payload.is_empty() { 0 } else { crc32(payload) }.to_le_bytes());

    write_exact(handle, &header, timeout)?;
    if !payload.is_empty() {
        write_exact(handle, payload, timeout)?;
    }
    Ok(())
}

fn transaction_locked_with_timeout(
    handle: &DeviceHandle<Context>, opcode: u16, status: i32, offset: u64,
    payload: &[u8], timeout: Duration,
) -> Result<Response, String> {
    let request_id = next_request_id();
    write_file_request(handle, opcode, status, offset, payload, request_id, timeout)?;
    let response = read_file_response(handle, opcode, request_id, timeout)?;
    if response.status < 0 {
        return Err(format!("board file operation failed: errno {}", -response.status));
    }
    Ok(response)
}

fn transaction_locked(
    handle: &DeviceHandle<Context>, opcode: u16, status: i32, offset: u64,
    payload: &[u8],
) -> Result<Response, String> {
    transaction_locked_with_timeout(handle, opcode, status, offset, payload, TIMEOUT)
}

fn with_device<T>(operation: impl FnOnce(&DeviceHandle<Context>) -> Result<T, String>) -> Result<T, String> {
    let _file_guard = FILE_ACCESS.lock().map_err(|_| "USB file request lock poisoned")?;
    let _guard = USB_ACCESS.acquire(TIMEOUT)?;
    let handle = open()?;
    operation(&handle)
}

/* Best-effort EP3 operations (Auto discovery and console polling). Leave
 * EP2 a short read interval, but never queue behind another file request.
 * Simulation control must NOT use this helper: FILE_ACCESS serializes
 * EP3 replies, and has no relationship to EP2 control frames. */
fn with_device_quick<T>(operation: impl FnOnce(&DeviceHandle<Context>) -> Result<T, String>) -> Result<T, String> {
    let _file_guard = FILE_ACCESS.try_lock().map_err(|_| "USB file transport is busy")?;
    let _guard = USB_ACCESS.acquire(AUTO_LOCK_WAIT)?;
    let handle = open()?;
    operation(&handle)
}

pub fn status() -> UsbStatus {
    match with_device(|handle| transaction_locked(handle, PING, 0, 0, &[])) {
        Ok(response) => UsbStatus {
            connected: true,
            identity: Some(String::from_utf8_lossy(&response.payload).into_owned()),
            vid: VID,
            pid: PID,
        },
        Err(_) => UsbStatus { connected: false, identity: None, vid: VID, pid: PID },
    }
}

pub fn ping() -> Result<String, String> {
    with_device(|handle| {
        let response = transaction_locked(handle, PING, 0, 0, &[])?;
        Ok(String::from_utf8_lossy(&response.payload).into_owned())
    })
}

/// Execute one non-interactive NSH command through EP3.  The board runs it
/// in a short-lived shell task and returns its stdout/stderr in the matching
/// response frame, so USB mode does not depend on Ethernet Telnet.
pub fn nsh_execute(command: &str) -> Result<String, String> {
    if command.is_empty() || command.len() > 512 || command.contains(['\r', '\n']) {
        return Err("NSH command must be one non-empty line of at most 512 bytes".into());
    }
    let _file_guard = FILE_ACCESS.lock().map_err(|_| "USB file request lock poisoned")?;
    let request_id = next_request_id();
    {
        let _guard = USB_ACCESS.acquire(TIMEOUT)?;
        let handle = open()?;
        write_file_request(&handle, NSH_EXEC, 0, 0, command.as_bytes(), request_id, TIMEOUT)?;
    }
    let deadline = std::time::Instant::now() + NSH_EXEC_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!("USB file response timed out (opcode={NSH_EXEC}, request={request_id})"));
        }
        let response = {
            let _guard = USB_ACCESS.acquire(TIMEOUT)?;
            let handle = open()?;
            poll_file_response(&handle, NSH_EXEC, request_id, remaining.min(SIM_READ_TIMEOUT))?
        };
        if let Some(response) = response {
            if response.status < 0 {
                return Err(format!("board file operation failed: errno {}", -response.status));
            }
            return Ok(String::from_utf8_lossy(&response.payload).into_owned());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[derive(Serialize)]
pub struct ConsoleChunk {
    pub data: Vec<u8>,
    pub next: u64,
    pub lost: bool,
}

/// Read a bounded piece of the board's debug UART output over the existing
/// vendor bulk endpoint.  A busy endpoint is retried by the caller later.
pub fn console_read(cursor: u64) -> Result<ConsoleChunk, String> {
    with_device_quick(|handle| {
        let response = transaction_locked_with_timeout(
            handle, CONSOLE_READ, 0, cursor, &[], AUTO_FILE_TIMEOUT,
        )?;
        Ok(ConsoleChunk {
            data: response.payload,
            next: response.offset,
            lost: response.status != 0,
        })
    })
}

/// Probe USB without letting a missing or occupied endpoint suspend the
/// realtime transport.  It is intentionally not used for explicit USB mode.
pub fn available_quick() -> bool {
    with_device_quick(|handle| {
        let response = transaction_locked_with_timeout(
            handle, PING, 0, 0, &[], AUTO_FILE_TIMEOUT,
        )?;
        Ok(String::from_utf8_lossy(&response.payload).into_owned())
    }).is_ok()
}

fn parse_list(payload: &[u8]) -> Result<Vec<UsbFileEntry>, String> {
    let text = std::str::from_utf8(payload)
        .map_err(|_| "board returned a non-UTF-8 directory listing")?;
    text.lines().map(|line| {
        let mut fields = line.splitn(3, '\t');
        let kind = fields.next().ok_or("directory entry has no type")?;
        let name = fields.next().ok_or("directory entry has no name")?;
        let size = fields.next().ok_or("directory entry has no size")?
            .parse::<u64>().map_err(|_| "directory entry has invalid size")?;
        Ok(UsbFileEntry { name: name.to_owned(), directory: kind == "D", size, modified: None })
    }).collect()
}

fn list_locked(handle: &DeviceHandle<Context>, path: &str) -> Result<Vec<UsbFileEntry>, String> {
    let response = transaction_locked_with_timeout(handle, LIST, 0, 0, path.as_bytes(), LIST_TIMEOUT)
        .map_err(|error| format!("USB LIST {path}: {error}"))?;
    parse_list(&response.payload)
}

pub fn list(path: &str) -> Result<Vec<UsbFileEntry>, String> {
    with_device(|handle| list_locked(handle, path))
}

fn parse_stat(path: &str, payload: &[u8]) -> Result<UsbFileEntry, String> {
    let text = std::str::from_utf8(payload).map_err(|_| "invalid stat response")?;
    let mut fields = text.trim_end().split('\t');
    let kind = fields.next().ok_or("stat response has no type")?;
    let size = fields.next().ok_or("stat response has no size")?
        .parse::<u64>().map_err(|_| "stat response has invalid size")?;
    let modified = fields.next().and_then(|value| value.parse::<u64>().ok()).filter(|value| *value > 0);
    Ok(UsbFileEntry {
        name: path.rsplit('/').next().unwrap_or(path).to_owned(),
        directory: kind == "D",
        size,
        modified,
    })
}

fn stat_locked(handle: &DeviceHandle<Context>, path: &str, timeout: Duration) -> Result<UsbFileEntry, String> {
    let response = transaction_locked_with_timeout(handle, STAT, 0, 0, path.as_bytes(), timeout)?;
    parse_stat(path, &response.payload)
}

pub fn stat(path: &str) -> Result<UsbFileEntry, String> {
    with_device(|handle| stat_locked(handle, path, TIMEOUT))
}

/// Used by the visible file manager only.  Keep ordinary LIST inexpensive for
/// folder uploads, copy operations and model-library discovery.
pub fn list_with_modified(path: &str) -> Result<Vec<UsbFileEntry>, String> {
    let mut entries = list(path)?;
    // Release the USB lock between small groups so live simulation traffic can
    // continue while a large directory's timestamps are being fetched.
    for group in entries.chunks_mut(4) {
        let complete = with_device(|handle| {
            for entry in group {
                let child = format!("{path}/{}", entry.name);
                if child.len() > 220 { continue; }
                match stat_locked(handle, &child, Duration::from_millis(750)) {
                    Ok(info) => entry.modified = info.modified,
                    // A missing file or slow storage must not hide the directory.
                    Err(error) if error.contains("errno 2") => continue,
                    Err(_) => return Ok(false),
                }
            }
            Ok(true)
        });
        if !matches!(complete, Ok(true)) { break; }
        std::thread::yield_now();
    }
    Ok(entries)
}

pub fn read_all(path: &str) -> Result<Vec<u8>, String> {
    with_device(|handle| {
        let mut result = Vec::new();
        let mut offset = 0u64;
        loop {
            let response = transaction_locked(handle, READ, MAX_PAYLOAD as i32, offset, path.as_bytes())?;
            let count = response.payload.len();
            result.extend_from_slice(&response.payload);
            offset = response.offset;
            if count < MAX_PAYLOAD { break; }
        }
        Ok(result)
    })
}

pub fn read_prefix(path: &str, length: usize) -> Result<Vec<u8>, String> {
    if length == 0 || length > MAX_PAYLOAD {
        return Err("invalid USB file prefix length".into());
    }
    with_device(|handle| {
        let response = transaction_locked(handle, READ, length as i32, 0, path.as_bytes())?;
        if response.offset != response.payload.len() as u64 {
            return Err("board returned wrong file prefix offset".into());
        }
        Ok(response.payload)
    })
}

pub fn read_limited(path: &str, limit: usize) -> Result<Vec<u8>, String> {
    with_device(|handle| {
        let mut result = Vec::new();
        let mut offset = 0u64;
        loop {
            let response = transaction_locked(handle, READ, MAX_PAYLOAD as i32, offset, path.as_bytes())?;
            let count = response.payload.len();
            if response.offset != offset + count as u64 {
                return Err(format!("board returned wrong read offset at byte {offset}"));
            }
            if count > limit.saturating_sub(result.len()) {
                return Err(format!("文件超过内置编辑器的 {} MiB 限制", limit / 1024 / 1024));
            }
            result.extend_from_slice(&response.payload);
            offset = response.offset;
            if count < MAX_PAYLOAD { break; }
        }
        Ok(result)
    })
}

pub fn read_text(path: &str) -> Result<String, String> {
    String::from_utf8(read_all(path)?).map_err(|error| format!("remote file is not UTF-8: {error}"))
}

pub fn download_to(path: &str, target: &Path) -> Result<u64, String> {
    download_to_fingerprint(path, target).map(|(size, _)| size)
}

pub fn download_to_fingerprint(path: &str, target: &Path) -> Result<(u64, u32), String> {
    with_device(|handle| {
        let mut file = std::fs::File::create(target)
            .map_err(|error| format!("cannot create download file: {error}"))?;
        let mut offset = 0u64;
        let mut checksum = u32::MAX;
        loop {
            let response = transaction_locked(handle, READ, MAX_PAYLOAD as i32, offset, path.as_bytes())?;
            let count = response.payload.len();
            if response.offset != offset + count as u64 {
                return Err(format!("board returned wrong download offset at byte {offset}"));
            }
            file.write_all(&response.payload)
                .map_err(|error| format!("cannot write download file: {error}"))?;
            checksum = crc32_fold(checksum, &response.payload);
            offset = response.offset;
            if count < MAX_PAYLOAD { break; }
        }
        file.sync_all().map_err(|error| format!("cannot flush download file: {error}"))?;
        Ok((offset, !checksum))
    })
}

pub fn fingerprint(path: &str) -> Result<(u64, u32), String> {
    with_device(|handle| {
        let mut offset = 0u64;
        let mut checksum = u32::MAX;
        loop {
            let response = transaction_locked(handle, READ, MAX_PAYLOAD as i32, offset, path.as_bytes())?;
            let count = response.payload.len();
            if response.offset != offset + count as u64 {
                return Err(format!("board returned wrong read offset at byte {offset}"));
            }
            checksum = crc32_fold(checksum, &response.payload);
            offset = response.offset;
            if count < MAX_PAYLOAD { break; }
        }
        Ok((offset, !checksum))
    })
}

pub fn validate_editable_file(path: &str) -> Result<(), String> {
    managed_volume(path)?;
    if stat(path)?.directory {
        return Err("只能使用电脑编辑器打开文件".into());
    }
    Ok(())
}

pub fn write_all(path: &str, data: &[u8]) -> Result<(), String> {
    write_all_with_progress(path, data, |_, _| {})
}

pub fn write_all_with_progress(
    path: &str,
    data: &[u8],
    progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    write_stream_with_progress(path, &mut std::io::Cursor::new(data), data.len() as u64, progress)
}

pub fn upload_from(path: &str, source: &Path) -> Result<u64, String> {
    let mut file = std::fs::File::open(source)
        .map_err(|error| format!("cannot open upload file: {error}"))?;
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    write_stream_with_progress(path, &mut file, size, |_, _| {})?;
    Ok(size)
}

fn write_stream_with_progress<R: Read + Seek>(
    path: &str,
    source: &mut R,
    total: u64,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    if path.is_empty() || path.len() > 220 {
        return Err("remote path must contain 1 to 220 bytes".into());
    }
    if total > i64::MAX as u64 {
        return Err("upload file is too large".into());
    }
    with_device(|handle| {
        // Older board firmware acknowledges an upload without checking its
        // length or checksum and deletes the old SD file before renaming it.
        // Firmware staging on eMMC must remain possible so it can be updated.
        if !path.starts_with("fireware/") {
            let response = transaction_locked(handle, PING, 0, 0, &[])?;
            if response.payload != b"lmx93-usb-file/3" && response.payload != b"lmx93-usb-file/4" && response.payload != b"lmx93-usb-file/5" && response.payload != b"lmx93-usb-file/6" {
                return Err("板端 FAT 文件名修复尚未生效，已阻止 SD 写入。请先升级至 lmx93-usb-file/3 固件并重启仿真机".into());
            }
            if has_long_component(path) && response.payload != b"lmx93-usb-file/5" && response.payload != b"lmx93-usb-file/6" {
                return Err("文件名超过 32 字节，需要升级至 lmx93-usb-file/5 板端固件".into());
            }
        }
        transaction_locked(handle, WRITE_BEGIN, 0, 0, path.as_bytes())?;
        let chunk_size = MAX_PAYLOAD.saturating_sub(path.len() + 2);
        let mut chunk = vec![0u8; chunk_size];
        let mut offset = 0u64;
        let mut checksum = u32::MAX;
        progress(0, total);
        let result = (|| {
            while offset < total {
                let count = chunk_size.min((total - offset) as usize);
                source.read_exact(&mut chunk[..count])
                    .map_err(|error| format!("cannot read upload file: {error}"))?;
                checksum = crc32_fold(checksum, &chunk[..count]);
                let mut payload = Vec::with_capacity(2 + path.len() + count);
                payload.extend_from_slice(&(path.len() as u16).to_le_bytes());
                payload.extend_from_slice(path.as_bytes());
                payload.extend_from_slice(&chunk[..count]);
                let response = transaction_locked(handle, WRITE_DATA, 0, offset, &payload)?;
                if response.offset != offset + count as u64 {
                    return Err(format!("board acknowledged wrong upload offset at byte {offset}"));
                }
                offset += count as u64;
                progress(offset, total);
            }
            transaction_locked(handle, WRITE_COMMIT, (!checksum) as i32, offset, path.as_bytes())?;
            // Check the final pathname too: a successful USB transfer only
            // proves delivery to the board, not that the card can read it.
            source.seek(SeekFrom::Start(0)).map_err(|error| error.to_string())?;
            let mut verified = 0u64;
            let mut expected = vec![0u8; MAX_PAYLOAD];
            while verified < total {
                let count = (total - verified).min(MAX_PAYLOAD as u64) as usize;
                source.read_exact(&mut expected[..count])
                    .map_err(|error| format!("cannot verify upload source: {error}"))?;
                let response = transaction_locked(handle, READ, count as i32,
                                                  verified, path.as_bytes())?;
                if response.payload != expected[..count] ||
                   response.offset != verified + count as u64 {
                    return Err(format!("SD upload readback mismatch at byte {verified}"));
                }
                verified += count as u64;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = transaction_locked(handle, WRITE_ABORT, 0, 0, path.as_bytes());
        }
        result
    })
}

pub fn delete(path: &str) -> Result<(), String> {
    with_device(|handle| transaction_locked(handle, DELETE, 0, 0, path.as_bytes()).map(|_| ()))
}

// Read the complete tree before removing anything. LIST fails rather than
// returning a partial result when the board's response buffer is too small.
fn plan_directory_delete(
    root: &str,
    mut list_children: impl FnMut(&str) -> Result<Vec<UsbFileEntry>, String>,
) -> Result<Vec<String>, String> {
    managed_volume(root)?; // Also excludes the sd and data volume roots.
    let mut pending = vec![root.to_owned()];
    let mut directories = Vec::new();
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        let entries = list_children(&directory)?;
        directories.push(directory.clone());
        for entry in entries {
            let child = format!("{directory}/{}", entry.name);
            managed_volume(&child)?;
            if entry.directory {
                pending.push(child);
            } else {
                files.push(child);
            }
        }
    }
    files.extend(directories.into_iter().rev());
    Ok(files)
}

pub fn delete_directory_tree(path: &str) -> Result<(), String> {
    managed_volume(path)?;
    if !stat(path)?.directory {
        return Err(format!("{path} is not a directory"));
    }
    let paths = plan_directory_delete(path, list)?;
    for (index, target) in paths.iter().enumerate() {
        delete(target).map_err(|error| {
            format!("could not delete {target}: {error} ({index}/{} entries removed)", paths.len())
        })?;
    }
    Ok(())
}

pub fn mkdir(path: &str) -> Result<(), String> {
    managed_volume(path)?;
    if has_long_component(path) && !matches!(ping()?.as_str(), "lmx93-usb-file/5" | "lmx93-usb-file/6") {
        return Err("文件名超过 32 字节，需要升级至 lmx93-usb-file/5 板端固件".into());
    }
    with_device(|handle| transaction_locked(handle, MKDIR, 0, 0, path.as_bytes()).map(|_| ()))
}

pub(crate) fn has_long_component(path: &str) -> bool {
    path.split('/').skip(1).any(|part| part.len() > 32)
}

pub(crate) fn managed_volume(path: &str) -> Result<&str, String> {
    if path.len() > 220 {
        return Err("文件路径超过板端 220 字节限制".into());
    }
    let (volume, remainder) = path.split_once('/').ok_or("不能操作 SD 或 data 根目录")?;
    if !matches!(volume, "sd" | "data") || remainder.split('/').any(|part| {
        part.is_empty() || part == "." || part == ".." || part.len() > 64 ||
        part.contains(['\\', '\0', ':', '*', '?', '"', '<', '>', '|']) ||
        part.bytes().any(|byte| byte < 32)
    }) {
        return Err("文件路径无效，名称不能超过 64 字节".into());
    }
    Ok(volume)
}

fn validate_transfer_paths<'a>(source: &'a str, destination: &'a str) -> Result<(&'a str, &'a str), String> {
    let source_volume = managed_volume(source)?;
    let destination_volume = managed_volume(destination)?;
    if source == destination || destination.starts_with(&format!("{source}/")) {
        return Err("目标不能是源目录本身或其子目录".into());
    }
    Ok((source_volume, destination_volume))
}

fn rename_remote(source: &str, destination: &str) -> Result<(), String> {
    let mut payload = Vec::with_capacity(2 + source.len() + destination.len());
    payload.extend_from_slice(&(source.len() as u16).to_le_bytes());
    payload.extend_from_slice(source.as_bytes());
    payload.extend_from_slice(destination.as_bytes());
    with_device(|handle| transaction_locked(handle, RENAME, 0, 0, &payload).map(|_| ()))
}

pub(crate) fn remove_tree(path: &str, directory: bool) -> Result<(), String> {
    if directory {
        for entry in list(path)? {
            remove_tree(&format!("{path}/{}", entry.name), entry.directory)?;
        }
    }
    delete(path)
}

fn copy_tree(source: &str, destination: &str, directory: bool, local_file: &Path) -> Result<(), String> {
    if directory {
        mkdir(destination)?;
        for entry in list(source)? {
            copy_tree(&format!("{source}/{}", entry.name),
                      &format!("{destination}/{}", entry.name), entry.directory, local_file)?;
        }
    } else {
        download_to(source, local_file)?;
        let result = upload_from(destination, local_file);
        let _ = std::fs::remove_file(local_file);
        result?;
    }
    Ok(())
}

/// Copy or move a file or directory in the two managed volumes. Copies are
/// staged under a hidden destination name, then published by board rename.
/// A cross-volume move removes the source only after the published copy passes
/// the normal upload readback checks.
pub fn transfer(source: &str, destination: &str, move_source: bool) -> Result<(), String> {
    let (source_volume, destination_volume) = validate_transfer_paths(source, destination)?;

    let (parent, name) = destination.rsplit_once('/').ok_or("目标路径无效")?;
    if !stat(parent)?.directory {
        return Err("目标父目录不存在".into());
    }
    if list(parent)?.iter().any(|entry| entry.name == name) {
        return Err("目标位置已有同名文件或目录".into());
    }
    let source_info = stat(source)?;
    let identity = ping()?;
    if identity != "lmx93-usb-file/4" && identity != "lmx93-usb-file/5" && identity != "lmx93-usb-file/6" {
        return Err("重命名、拷贝和移动需要 lmx93-usb-file/4 或更新板端固件".into());
    }
    if (has_long_component(source) || has_long_component(destination)) && identity != "lmx93-usb-file/5" && identity != "lmx93-usb-file/6" {
        return Err("文件名超过 32 字节，需要升级至 lmx93-usb-file/5 板端固件".into());
    }

    if move_source && source_volume == destination_volume {
        return rename_remote(source, destination);
    }

    let mut staging = None;
    for _ in 0..16 {
        let candidate = format!("{parent}/.usbpartcopy{:08x}", next_request_id());
        if candidate.len() > 220 { return Err("目标路径过长，无法创建临时目录".into()); }
        match stat(&candidate) {
            Ok(_) => continue,
            Err(error) if error.contains("errno 2") => { staging = Some(candidate); break; }
            Err(error) => return Err(error),
        }
    }
    let staging = staging.ok_or("无法分配临时目标目录")?;
    let local_dir = std::env::temp_dir().join(format!("jsbsim-usb-copy-{}-{:08x}",
                                                         std::process::id(), next_request_id()));
    std::fs::create_dir(&local_dir).map_err(|error| format!("创建本地临时目录失败: {error}"))?;
    let local_file = local_dir.join("transfer.part");
    let result = (|| {
        copy_tree(source, &staging, source_info.directory, &local_file)?;
        rename_remote(&staging, destination)
    })();
    let _ = std::fs::remove_dir_all(&local_dir);
    if let Err(error) = result {
        let cleanup = match stat(&staging) {
            Ok(entry) => remove_tree(&staging, entry.directory),
            Err(missing) if missing.contains("errno 2") => Ok(()),
            Err(other) => Err(other),
        };
        if let Err(cleanup_error) = cleanup {
            return Err(format!("{error}; 临时目标 {staging} 清理失败: {cleanup_error}"));
        }
        return Err(error);
    }

    if move_source {
        remove_tree(source, source_info.directory).map_err(|error| {
            format!("目标已完整拷贝，但清理原位置失败: {error}")
        })?;
    }
    Ok(())
}

/// Ask the board to install a staged firmware file and report eMMC write and
/// readback verification progress frames sent by the board.
pub fn apply_firmware_with_progress(
    path: &str,
    mut progress: impl FnMut(FirmwareUpdateProgress),
) -> Result<String, String> {
    with_device(|handle| {
        let request_id = next_request_id();
        let mut header = [0u8; HEADER_SIZE];
        header[0..4].copy_from_slice(&MAGIC.to_le_bytes());
        header[4..6].copy_from_slice(&VERSION.to_le_bytes());
        header[6..8].copy_from_slice(&UPDATE.to_le_bytes());
        header[8..12].copy_from_slice(&request_id.to_le_bytes());
        header[16..20].copy_from_slice(&(path.len() as u32).to_le_bytes());
        header[28..32].copy_from_slice(&crc32(path.as_bytes()).to_le_bytes());

        write_exact(handle, &header, FIRMWARE_UPDATE_TIMEOUT)?;
        write_exact(handle, path.as_bytes(), FIRMWARE_UPDATE_TIMEOUT)?;

        loop {
            let response = read_file_response(handle, UPDATE, request_id, FIRMWARE_UPDATE_TIMEOUT)?;
            let response_status = response.status;
            let response_offset = response.offset;
            let payload = response.payload;

            if response_status == -libc::EINPROGRESS {
                let text = std::str::from_utf8(&payload)
                    .map_err(|_| "firmware progress is not UTF-8")?;
                let mut fields = text.split('\t');
                if fields.next() != Some("progress") {
                    return Err("invalid firmware progress response".into());
                }
                let phase = match fields.next() {
                    Some("write") => FirmwareUpdatePhase::Write,
                    Some("verify") => FirmwareUpdatePhase::Verify,
                    _ => return Err("firmware progress has an unknown phase".into()),
                };
                let completed = fields.next()
                    .ok_or("firmware progress has no completed byte count")?
                    .parse::<u64>()
                    .map_err(|_| "firmware progress has an invalid completed byte count")?;
                let total = fields.next()
                    .ok_or("firmware progress has no total byte count")?
                    .parse::<u64>()
                    .map_err(|_| "firmware progress has an invalid total byte count")?;
                if fields.next().is_some() || completed != response_offset || completed > total {
                    return Err("firmware progress response is inconsistent".into());
                }

                progress(FirmwareUpdateProgress { phase, completed, total });
                continue;
            }

            if response_status < 0 {
                return Err(format!("board firmware update failed: errno {}", -response_status));
            }

            return Ok(String::from_utf8_lossy(&payload).into_owned());
        }
    })
}

// Serialize only physical interface access, independent of an outstanding
// EP3 file/NSH response. The callback also lets contention tests exercise the
// actual framing and send-once path without claiming a connected board.
fn sim_write_control_with(
    access: &UsbAccess,
    payload: &[u8],
    write: impl FnOnce(&[u8], Duration) -> Result<usize, String>,
) -> Result<(), String> {
    if payload.len() > 4096 {
        return Err("simulation USB record is too large".into());
    }
    // A user action can wait through a 300 ms console read. Keep the 1 Hz
    // heartbeat bounded separately so a busy interface cannot stall it for
    // seconds. No operation is queued to execute after its wait expires.
    let lock_wait = if payload == b"VCMD\x07" { SIM_TIMEOUT } else { TIMEOUT };
    let _guard = access.acquire(lock_wait)?;
    let mut frame = Vec::with_capacity(payload.len() + 8);
    frame.extend_from_slice(b"SIM1");
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    let count = write(&frame, SIM_TIMEOUT)?;
    if count != frame.len() {
        return Err(format!("short simulation USB write: {count}/{}", frame.len()));
    }
    Ok(())
}

/// EP2 controls wait for interface ownership, never for the EP3 file lock.
/// A write error/short write is returned without replaying the command.
pub fn sim_write_control(payload: &[u8]) -> Result<(), String> {
    sim_write_control_with(&USB_ACCESS, payload, |frame, timeout| {
        let handle = open()?;
        handle.write_bulk(SIM_OUT, frame, timeout)
            .map_err(|error| format!("simulation USB write failed: {error}"))
    })
}

fn take_sim_frame(buffer: &mut Vec<u8>) -> Result<Option<Vec<u8>>, String> {
    if buffer.len() < 8 {
        return Ok(None);
    }
    if &buffer[..4] != b"SIM1" {
        buffer.clear();
        return Err("invalid simulation USB record header".into());
    }
    let length = u32::from_le_bytes(buffer[4..8].try_into().unwrap()) as usize;
    if length > 4096 {
        buffer.clear();
        return Err(format!("simulation USB record is too large: {length}"));
    }
    let frame_size = length + 8;
    if buffer.len() < frame_size {
        return Ok(None);
    }
    let frame: Vec<u8> = buffer.drain(..frame_size).collect();
    Ok(Some(frame[8..].to_vec()))
}

fn read_sim_frame_with(
    buffer: &mut Vec<u8>, timeout: Duration,
    mut read_packet: impl FnMut(&mut [u8], Duration) -> Result<usize, rusb::Error>,
) -> Result<Option<Vec<u8>>, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(frame) = take_sim_frame(buffer)? {
            return Ok(Some(frame));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        /* Complete one SIM1 record under the same interface claim.  The
         * caller sleeps after Ok(None), so yielding for each 512-byte chunk
         * throttled an eight-instance stream even while USB data was ready. */
        let mut packet = [0u8; 512];
        match read_packet(&mut packet, remaining) {
            Ok(0) => return Ok(None),
            Ok(count) => buffer.extend_from_slice(&packet[..count]),
            Err(rusb::Error::Timeout) => return Ok(None),
            Err(error) => return Err(format!("simulation USB read failed: {error}")),
        }
    }
}

fn read_sim_frame(handle: &DeviceHandle<Context>, buffer: &mut Vec<u8>,
                  timeout: Duration) -> Result<Option<Vec<u8>>, String> {
    read_sim_frame_with(buffer, timeout, |packet, remaining| {
        handle.read_bulk(SIM_IN, packet, remaining)
    })
}

pub fn sim_read() -> Result<Option<Vec<u8>>, String> {
    let _guard = USB_ACCESS.telemetry()?;
    let mut buffer = SIM_RX.lock().map_err(|_| "simulation USB receive lock poisoned".to_string())?;
    let handle = match open() {
        Ok(handle) => handle,
        Err(error) => {
            /* A disconnect may occur after a partial multi-packet record.
             * Never join that stale prefix to data from the next device. */
            buffer.clear();
            return Err(error);
        }
    };
    let prior_length = buffer.len();
    match read_sim_frame(&handle, &mut buffer, SIM_READ_TIMEOUT) {
        Ok(Some(frame)) => Ok(Some(frame)),
        Ok(None) => {
            /* Bulk packets for one record arrive back-to-back.  A timeout
             * after an unchanged partial prefix means the cable was removed
             * or that transfer was abandoned; discard it before replug. */
            if !buffer.is_empty() && buffer.len() == prior_length {
                buffer.clear();
            }
            Ok(None)
        }
        Err(error) => {
            buffer.clear();
            Err(error)
        }
    }
}

/// Verify the complete simulation transport, not merely the independent
/// model-file service.  The board must answer the VCMD heartbeat over EP2 IN
/// with a SIM1-wrapped JSON heartbeat within the timeout.
pub fn simulation_self_test() -> Result<String, String> {
    let _guard = USB_ACCESS.acquire(TIMEOUT)?;
    let handle = open()?;
    let payload = [b'V', b'C', b'M', b'D', 7u8];
    let mut request = Vec::with_capacity(payload.len() + 8);
    request.extend_from_slice(b"SIM1");
    request.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    request.extend_from_slice(&payload);

    let written = handle.write_bulk(SIM_OUT, &request, TIMEOUT)
        .map_err(|error| format!("simulation USB heartbeat write failed: {error}"))?;
    if written != request.len() {
        return Err(format!("short simulation USB heartbeat write: {written}/{}", request.len()));
    }

    let deadline = std::time::Instant::now() + TIMEOUT;
    let mut buffer = Vec::new();
    let mut heartbeat_state = None;
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let Some(frame) = read_sim_frame(&handle, &mut buffer, remaining)? else {
            break;
        };
        let text = std::str::from_utf8(&frame)
            .map_err(|_| "simulation heartbeat is not UTF-8 JSON".to_string())?;
        let value: serde_json::Value = serde_json::from_str(text)
            .map_err(|error| format!("simulation heartbeat is not JSON: {error}"))?;
        if value.get("kind").and_then(serde_json::Value::as_str) == Some("heartbeat") {
            heartbeat_state = Some(value.get("state").and_then(serde_json::Value::as_str)
                .unwrap_or("unknown").to_string());
        }
        if value.get("timestamp").and_then(serde_json::Value::as_f64).is_some() &&
           value.get("altitude_m").and_then(serde_json::Value::as_f64).is_some() {
            return Ok(format!("{}; telemetry=ok",
                heartbeat_state.as_deref().unwrap_or("unknown")));
        }
    }
    if let Some(state) = heartbeat_state {
        Err(format!("simulation USB heartbeat received (state={state}), but visual telemetry timed out"))
    } else {
        Err("simulation USB heartbeat timed out: firmware did not return telemetry".into())
    }
}

#[cfg(test)]
mod response_tests {
    use super::*;

    #[test]
    fn simulation_usb_reads_a_complete_frame_without_pausing_between_chunks() {
        for payload_length in [1016, 1392] {
            let payload = vec![b'x'; payload_length];
            let mut wire = b"SIM1".to_vec();
            wire.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            wire.extend_from_slice(&payload);
            let mut chunks = wire.chunks(512);
            let mut reads = 0;
            let frame = read_sim_frame_with(&mut Vec::new(), Duration::from_secs(1),
                |packet, _| {
                    let chunk = chunks.next().expect("read past the complete frame");
                    packet[..chunk.len()].copy_from_slice(chunk);
                    reads += 1;
                    Ok(chunk.len())
                }).unwrap().unwrap();
            assert_eq!(frame, payload);
            assert_eq!(reads, wire.len().div_ceil(512));
        }
    }

    #[test]
    fn startup_controls_and_heartbeat_do_not_take_the_file_response_lock() {
        // Reproduce an NSH/MCAP preview still owning EP3 while it yields the
        // interface for EP2. The old quick-file path failed immediately here.
        let _file_request = FILE_ACCESS.lock().unwrap();
        let access = UsbAccess::new();
        for payload in [b"VCMD\x09clock".as_slice(), b"VCMD\x05H7_USB", b"VCMD\x01", b"VCMD\x07"] {
            let mut writes = 0;
            sim_write_control_with(&access, payload, |frame, timeout| {
                writes += 1;
                assert!(matches!(FILE_ACCESS.try_lock(), Err(TryLockError::WouldBlock)));
                assert!(matches!(access.lock.try_lock(), Err(TryLockError::WouldBlock)));
                assert_eq!(&frame[..4], b"SIM1");
                assert_eq!(u32::from_le_bytes(frame[4..8].try_into().unwrap()) as usize, payload.len());
                assert_eq!(&frame[8..], payload);
                assert_eq!(timeout, SIM_TIMEOUT);
                Ok(frame.len())
            }).unwrap();
            assert_eq!(writes, 1);
        }
    }

    #[test]
    fn startup_waits_through_a_console_read_and_sends_once() {
        use std::sync::Arc;
        let access = Arc::new(UsbAccess::new());
        let console = access.acquire(TIMEOUT).unwrap();
        let sender_access = Arc::clone(&access);
        let writes = Arc::new(AtomicUsize::new(0));
        let sender_writes = Arc::clone(&writes);
        let sender = std::thread::spawn(move || {
            sim_write_control_with(&sender_access, b"VCMD\x05H7_USB", |frame, _| {
                sender_writes.fetch_add(1, Ordering::SeqCst);
                Ok(frame.len())
            })
        });
        let deadline = std::time::Instant::now() + TIMEOUT;
        while access.waiting.load(Ordering::SeqCst) == 0 {
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        }
        std::thread::sleep(AUTO_FILE_TIMEOUT);
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        drop(console);
        sender.join().unwrap().unwrap();
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert!(access.telemetry().is_ok());
    }

    #[test]
    fn expired_heartbeat_does_not_send_after_interface_becomes_free() {
        let access = UsbAccess::new();
        let active = access.acquire(TIMEOUT).unwrap();
        let started = std::time::Instant::now();
        let mut writes = 0;
        let error = sim_write_control_with(&access, b"VCMD\x07", |frame, _| {
            writes += 1; Ok(frame.len())
        }).unwrap_err();
        assert!(error.contains("lock wait timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(active);
        assert_eq!(writes, 0);
        assert_eq!(access.waiting.load(Ordering::SeqCst), 0);
        assert!(access.telemetry().is_ok());
    }

    #[test]
    fn control_write_failure_is_not_replayed() {
        let access = UsbAccess::new();
        for short in [false, true] {
            let mut writes = 0;
            let result = sim_write_control_with(&access, b"VCMD\x05H7_USB", |frame, _| {
                writes += 1;
                if short { Ok(frame.len()-1) } else { Err("injected USB write failure".into()) }
            });
            assert!(result.is_err());
            assert_eq!(writes, 1);
            assert!(access.telemetry().is_ok());
        }
        assert!(sim_write_control_with(&access, &[0;4097], |_, _| panic!("oversized frame sent")).is_err());
    }

    #[test]
    fn file_request_gets_the_usb_channel_during_continuous_telemetry() {
        use std::sync::{Arc, mpsc};
        let access = Arc::new(UsbAccess::new());
        let telemetry = access.telemetry().unwrap();
        let writer_access = Arc::clone(&access);
        let (saved, result) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            let _guard = writer_access.acquire(Duration::from_secs(1)).unwrap();
            saved.send(()).unwrap();
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while access.waiting.load(Ordering::SeqCst) == 0 {
            assert!(std::time::Instant::now() < deadline, "writer did not queue");
            std::thread::yield_now();
        }
        drop(telemetry);
        // Keep polling just as the live receiver does when it has packets.
        // A queued writer must be served without waiting for telemetry to stop.
        loop {
            match result.try_recv() {
                Ok(()) => break,
                Err(mpsc::TryRecvError::Disconnected) => panic!("writer failed"),
                Err(mpsc::TryRecvError::Empty) => {},
            }
            let _poll = access.telemetry();
            assert!(std::time::Instant::now() < deadline, "telemetry starved writer");
            std::thread::yield_now();
        }
        writer.join().unwrap();
        assert_eq!(access.waiting.load(Ordering::SeqCst), 0);
        assert!(access.telemetry().is_ok(), "telemetry must resume after the save");
    }

    #[test]
    fn busy_usb_request_expires_without_running_later() {
        let access = UsbAccess::new();
        let active_transfer = access.acquire(Duration::from_secs(1)).unwrap();
        let started = std::time::Instant::now();
        let error = access.acquire(Duration::from_millis(30)).unwrap_err();
        assert!(error.contains("lock wait timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(access.waiting.load(Ordering::SeqCst), 0);
        drop(active_transfer);
        assert!(access.telemetry().is_ok(), "expired requests must leave the queue");
        assert!(access.acquire(Duration::from_millis(30)).is_ok(), "retry must work");
    }

    #[test]
    fn directory_delete_plans_children_before_parents_and_rejects_roots() {
        let paths = plan_directory_delete("sd/models", |path| Ok(match path {
            "sd/models" => vec![
                UsbFileEntry { name: "aircraft".into(), directory: true, size: 0, modified: None },
                UsbFileEntry { name: "root.xml".into(), directory: false, size: 1, modified: None },
            ],
            "sd/models/aircraft" => vec![
                UsbFileEntry { name: "jet.xml".into(), directory: false, size: 1, modified: None },
            ],
            _ => unreachable!(),
        })).unwrap();
        assert_eq!(paths, [
            "sd/models/root.xml", "sd/models/aircraft/jet.xml",
            "sd/models/aircraft", "sd/models",
        ]);
        assert!(plan_directory_delete("sd", |_| unreachable!()).is_err());
        assert!(plan_directory_delete("data", |_| unreachable!()).is_err());
        assert!(plan_directory_delete("sd/models", |_| Ok(vec![
            UsbFileEntry { name: "../other".into(), directory: false, size: 0, modified: None },
        ])).is_err());
    }

    #[test]
    fn transfer_paths_reject_roots_traversal_and_descendants() {
        assert_eq!(validate_transfer_paths("sd/models", "data/models").unwrap(), ("sd", "data"));
        assert_eq!(validate_transfer_paths("sd/a", "sd/b").unwrap(), ("sd", "sd"));
        for (source, target) in [
            ("sd", "data/a"), ("sd/a", "sd/a"), ("sd/a", "sd/a/b"),
            ("sd/a", "sd/../data/a"), ("sd/a", "romfs/a"),
            ("sd/a", "data/a/ bad"),
        ] {
            assert!(validate_transfer_paths(source, target).is_err(), "{source} -> {target}");
        }
    }

    #[test]
    fn streamed_crc_matches_single_buffer_crc() {
        let data = (0..20000).map(|index| (index % 251) as u8).collect::<Vec<_>>();
        let checksum = data.chunks(517).fold(u32::MAX, crc32_fold);
        assert_eq!(!checksum, crc32(&data));
    }

    #[test]
    fn accepts_long_library_names_within_board_limit() {
        let path = "sd/jsbsim/scripts/737_cruise_steady_turn_linearize.xml";
        assert_eq!(managed_volume(path).unwrap(), "sd");
        assert!(has_long_component(path));
        assert!(managed_volume(&format!("sd/{}", "a".repeat(64))).is_ok());
        assert!(managed_volume(&format!("sd/{}", "a".repeat(65))).is_err());
    }

    #[test]
    fn reads_existing_stat_modification_time() {
        let file = parse_stat("sd/scripts/flight.xml", b"F\t120\t1790496000\n").unwrap();
        assert_eq!(file.modified, Some(1790496000));
        assert_eq!(file.size, 120);
        let folder = parse_stat("sd/scripts", b"D\t0\t1790496001\n").unwrap();
        assert_eq!(folder.modified, Some(1790496001));
        assert!(folder.directory);
        assert_eq!(parse_stat("sd/empty", b"D\t0\t0\n").unwrap().modified, None);
        assert_eq!(parse_list(b"F\tflight.xml\t120\n").unwrap()[0].modified, None);
    }

    fn frame(opcode: u16, id: u32, status: i32, payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&MAGIC.to_le_bytes());
        bytes.extend_from_slice(&VERSION.to_le_bytes());
        bytes.extend_from_slice(&(opcode | 0x8000).to_le_bytes());
        bytes.extend_from_slice(&id.to_le_bytes());
        bytes.extend_from_slice(&status.to_le_bytes());
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&crc32(payload).to_le_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn skips_stale_frames_and_orphaned_payload_before_current_response() {
        let mut buffer = vec![b'x'; 304];
        buffer.extend(frame(LIST, 7, 0, &[b'a'; 304]));
        buffer.extend(frame(PING, 1, 0, b"old"));
        buffer.extend(frame(PING, 900, 0, b"current"));
        assert_eq!(take_file_response(&mut buffer, PING, 900).unwrap().unwrap().payload, b"current");
        assert!(buffer.is_empty());
    }

    #[test]
    fn handles_every_split_point_and_a_late_partial_frame() {
        let bytes = frame(LIST, 8, 0, &[42; 1300]);
        for split in 0..bytes.len() {
            let mut buffer = bytes[..split].to_vec();
            assert!(take_file_response(&mut buffer, LIST, 8).unwrap().is_none());
            buffer.extend_from_slice(&bytes[split..]);
            buffer.extend(frame(PING, 9, 0, b"new"));
            assert_eq!(take_file_response(&mut buffer, PING, 9).unwrap().unwrap().payload, b"new");
        }
    }

    #[test]
    fn rejects_corrupt_current_payload_and_wrong_opcode() {
        let mut buffer = frame(PING, 8, 0, b"good");
        *buffer.last_mut().unwrap() ^= 1;
        assert!(take_file_response(&mut buffer, PING, 8).unwrap_err().contains("CRC32"));
        let mut buffer = frame(LIST, 8, 0, b"wrong operation");
        assert!(take_file_response(&mut buffer, PING, 8).unwrap_err().contains("opcode"));
    }

    #[test]
    fn keeps_progress_frames_and_board_errors_intact() {
        let mut buffer = frame(UPDATE, 8, -libc::EINPROGRESS, b"progress");
        buffer.extend(frame(UPDATE, 8, 0, b"done"));
        assert_eq!(take_file_response(&mut buffer, UPDATE, 8).unwrap().unwrap().status, -libc::EINPROGRESS);
        assert_eq!(take_file_response(&mut buffer, UPDATE, 8).unwrap().unwrap().payload, b"done");
        let mut buffer = frame(STAT, 9, -2, b"");
        assert_eq!(take_file_response(&mut buffer, STAT, 9).unwrap().unwrap().status, -2);
    }

    #[test]
    fn resynchronizes_invalid_header_without_unbounded_buffering() {
        let mut buffer = frame(PING, 1, 0, b"");
        buffer[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
        buffer.extend(frame(PING, 9, 0, b"valid"));
        assert_eq!(take_file_response(&mut buffer, PING, 9).unwrap().unwrap().payload, b"valid");
        let mut noise = vec![b'x'; 16896];
        assert!(take_file_response(&mut noise, PING, 9).unwrap().is_none());
        assert_eq!(noise.len(), 3);
    }

    #[test]
    #[ignore = "requires the real board, an existing completed MCAP log and active USB telemetry"]
    fn live_mcap_preview_keeps_usb_telemetry_alive() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        use std::time::Instant;

        let file = list("LOG").unwrap().into_iter().find_map(|entry| {
            let folder = if entry.directory { format!("LOG/{}", entry.name) } else { "LOG".into() };
            let entries = if entry.directory { list(&folder).ok()? } else { vec![entry] };
            entries.into_iter().find(|item| !item.directory && item.name.ends_with(".mcap"))
                .map(|item| format!("{folder}/{}", item.name).trim_start_matches("LOG/").to_owned())
        }).expect("board has no completed MCAP log");
        let stop = Arc::new(AtomicBool::new(false));
        let seen = Arc::new(Mutex::new(Vec::<Instant>::new()));
        let receiver_stop = Arc::clone(&stop);
        let receiver_seen = Arc::clone(&seen);
        let receiver = std::thread::spawn(move || {
            while !receiver_stop.load(Ordering::Relaxed) {
                if matches!(sim_read(), Ok(Some(_))) {
                    receiver_seen.lock().unwrap().push(Instant::now());
                } else {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        });
        let warmup = Instant::now() + Duration::from_secs(5);
        while seen.lock().unwrap().is_empty() && Instant::now() < warmup {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!seen.lock().unwrap().is_empty(), "board is not sending USB telemetry");
        let start = Instant::now();
        let output = nsh_execute(&format!("jsbsim --mcap-info {file}")).unwrap();
        let end = Instant::now();
        std::thread::sleep(Duration::from_millis(300));
        stop.store(true, Ordering::Relaxed);
        receiver.join().unwrap();
        assert!(output.contains("MCAP_INFO:"), "unexpected MCAP result: {output}");
        let samples = seen.lock().unwrap();
        let during: Vec<_> = samples.iter().filter(|time| **time >= start && **time <= end).collect();
        assert!(!during.is_empty(), "USB telemetry stopped during MCAP preview");
        let largest_gap = samples.windows(2).filter(|pair| pair[0] <= end && pair[1] >= start)
            .map(|pair| pair[1].duration_since(pair[0])).max().unwrap_or_default();
        println!("MCAP {file}: preview {:?}, {} telemetry packets during, largest gap {:?}", end - start, during.len(), largest_gap);
        assert!(largest_gap < Duration::from_secs(2), "USB telemetry gap reached disconnect timeout");
    }

    #[test]
    #[ignore = "requires the real board and exclusive access; PING/LIST only"]
    fn live_file_queries_recover_queued_responses_without_writes() {
        with_device(|handle| {
            // Queue a reply without reading it, reproducing the state left
            // by a previous timed-out caller. Do not issue a write opcode.
            let mut request = frame(LIST, next_request_id(), 0, b"jsbsim/systems");
            request[6..8].copy_from_slice(&LIST.to_le_bytes());
            write_exact(handle, &request[..HEADER_SIZE], TIMEOUT)?;
            write_exact(handle, &request[HEADER_SIZE..], TIMEOUT)?;
            let response = transaction_locked(handle, PING, 0, 0, b"")?;
            assert_eq!(String::from_utf8_lossy(&response.payload), "lmx93-usb-file/4");
            Ok(())
        }).unwrap();
        println!("Recovered queued old LIST response; current PING verified");
        for _ in 0..5 {
            assert_eq!(ping().unwrap(), "lmx93-usb-file/4");
        }
        println!("Five subsequent file-service PINGs verified");
    }

    #[test]
    #[ignore = "requires the real board; tests storage separately from transport recovery"]
    fn live_directory_queries() {
        for path in ["sd", "data", "jsbsim", "jsbsim/aircraft", "jsbsim/systems", "jsbsim/engine"] {
            let entries = list(path).unwrap();
            println!("USB LIST {path}: {entries:?}");
        }
    }

    #[test]
    #[ignore = "requires updated board firmware and a mounted SD card; writes and removes one test file"]
    fn live_sd_upload_roundtrip() {
        let path = "jsbsim/usbtest.bin";
        for size in [0, 1, 511, 16_384, 32_771, 131_075] {
            let data: Vec<u8> = (0..size).map(|index| (index * 37 % 251) as u8).collect();
            write_all(path, &data).unwrap();
            assert_eq!(read_all(path).unwrap(), data, "readback failed for {size} bytes");
        }
        delete(path).unwrap();
    }
}
