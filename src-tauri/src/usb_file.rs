//! Private file RPC over the LMX93 vendor-specific USB bulk interface.
//!
//! The interface binds to WinUSB on Windows and usbfs/libusb on Linux.  It is
//! deliberately not MTP or mass storage, so Explorer and desktop file
//! managers cannot browse the board.

use rusb::{Context, DeviceHandle, UsbContext};
use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use std::{io::Write, path::Path};

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
const FIRMWARE_UPDATE_TIMEOUT: Duration = Duration::from_secs(120);
/* Automatic transport selection must never hold the live simulation link for
 * a file-service timeout.  A healthy vendor endpoint replies to PING/LIST in
 * a few milliseconds; use this small budget only when the caller may fall
 * back to Ethernet. */
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

static REQUEST_ID: AtomicU32 = AtomicU32::new(1);
static USB_LOCK: Mutex<()> = Mutex::new(());
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
    let mut crc = u32::MAX;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
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

fn read_exact(
    handle: &DeviceHandle<Context>,
    mut data: &mut [u8],
    timeout: Duration,
) -> Result<(), String> {
    while !data.is_empty() {
        let count = handle
            .read_bulk(FILE_IN, data, timeout)
            .map_err(|error| format!("USB bulk read failed: {error}"))?;
        if count == 0 {
            return Err("USB bulk read returned zero bytes".into());
        }
        data = &mut data[count..];
    }
    Ok(())
}

fn transaction_locked_with_timeout(
    handle: &DeviceHandle<Context>,
    opcode: u16,
    status: i32,
    offset: u64,
    payload: &[u8],
    timeout: Duration,
) -> Result<Response, String> {
    if payload.len() > MAX_PAYLOAD {
        return Err(format!("USB payload exceeds {MAX_PAYLOAD} bytes"));
    }

    let request_id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
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

    let mut response_header = [0u8; HEADER_SIZE];
    read_exact(handle, &mut response_header, timeout)?;
    let response_magic = u32::from_le_bytes(response_header[0..4].try_into().unwrap());
    let response_version = u16::from_le_bytes(response_header[4..6].try_into().unwrap());
    let response_opcode = u16::from_le_bytes(response_header[6..8].try_into().unwrap());
    let response_id = u32::from_le_bytes(response_header[8..12].try_into().unwrap());
    let response_status = i32::from_le_bytes(response_header[12..16].try_into().unwrap());
    let response_length = u32::from_le_bytes(response_header[16..20].try_into().unwrap()) as usize;
    let response_offset = u64::from_le_bytes(response_header[20..28].try_into().unwrap());
    let response_crc = u32::from_le_bytes(response_header[28..32].try_into().unwrap());

    if response_magic != MAGIC || response_version != VERSION ||
        response_opcode != (opcode | 0x8000) || response_id != request_id {
        return Err("invalid or out-of-sequence USB response".into());
    }
    if response_length > MAX_PAYLOAD {
        return Err("USB response payload is too large".into());
    }

    let mut response_payload = vec![0u8; response_length];
    if response_length > 0 {
        read_exact(handle, &mut response_payload, timeout)?;
        if crc32(&response_payload) != response_crc {
            return Err("USB response CRC32 mismatch".into());
        }
    }

    let response = Response {
        status: response_status,
        offset: response_offset,
        payload: response_payload,
    };
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
    let _guard = USB_LOCK.lock().map_err(|_| "USB transport lock poisoned".to_string())?;
    let handle = open()?;
    operation(&handle)
}

/* Used only by Auto-mode library discovery.  Leave the receiver one short
 * read interval to release EP2, but never queue behind it for seconds. */
fn with_device_quick<T>(operation: impl FnOnce(&DeviceHandle<Context>) -> Result<T, String>) -> Result<T, String> {
    let deadline = std::time::Instant::now() + AUTO_LOCK_WAIT;
    let _guard = loop {
        match USB_LOCK.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err("USB interface remained busy with simulation telemetry".into());
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err("USB transport lock poisoned".into());
            }
        }
    };
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

pub fn list(path: &str) -> Result<Vec<UsbFileEntry>, String> {
    with_device(|handle| {
        let response = transaction_locked(handle, LIST, 0, 0, path.as_bytes())?;
        let text = std::str::from_utf8(&response.payload)
            .map_err(|_| "board returned a non-UTF-8 directory listing")?;
        text.lines().map(|line| {
            let mut fields = line.splitn(3, '\t');
            let kind = fields.next().ok_or("directory entry has no type")?;
            let name = fields.next().ok_or("directory entry has no name")?;
            let size = fields.next().ok_or("directory entry has no size")?
                .parse::<u64>().map_err(|_| "directory entry has invalid size")?;
            Ok(UsbFileEntry { name: name.to_owned(), directory: kind == "D", size })
        }).collect()
    })
}

/// Short, non-queuing directory request for Auto mode.  A caller can safely
/// use network FTP when this returns an error.
pub fn list_quick(path: &str) -> Result<Vec<UsbFileEntry>, String> {
    with_device_quick(|handle| {
        let response = transaction_locked_with_timeout(
            handle, LIST, 0, 0, path.as_bytes(), AUTO_FILE_TIMEOUT,
        )?;
        let text = std::str::from_utf8(&response.payload)
            .map_err(|_| "board returned a non-UTF-8 directory listing")?;
        text.lines().map(|line| {
            let mut fields = line.splitn(3, '\t');
            let kind = fields.next().ok_or("directory entry has no type")?;
            let name = fields.next().ok_or("directory entry has no name")?;
            let size = fields.next().ok_or("directory entry has no size")?
                .parse::<u64>().map_err(|_| "directory entry has invalid size")?;
            Ok(UsbFileEntry { name: name.to_owned(), directory: kind == "D", size })
        }).collect()
    })
}

pub fn stat(path: &str) -> Result<UsbFileEntry, String> {
    with_device(|handle| {
        let response = transaction_locked(handle, STAT, 0, 0, path.as_bytes())?;
        let text = std::str::from_utf8(&response.payload).map_err(|_| "invalid stat response")?;
        let mut fields = text.trim_end().splitn(3, '\t');
        let kind = fields.next().ok_or("stat response has no type")?;
        let size = fields.next().ok_or("stat response has no size")?
            .parse::<u64>().map_err(|_| "stat response has invalid size")?;
        Ok(UsbFileEntry {
            name: path.rsplit('/').next().unwrap_or(path).to_owned(),
            directory: kind == "D",
            size,
        })
    })
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

pub fn read_text(path: &str) -> Result<String, String> {
    String::from_utf8(read_all(path)?).map_err(|error| format!("remote file is not UTF-8: {error}"))
}

pub fn download_to(path: &str, target: &Path) -> Result<u64, String> {
    with_device(|handle| {
        let mut file = std::fs::File::create(target)
            .map_err(|error| format!("cannot create download file: {error}"))?;
        let mut offset = 0u64;
        loop {
            let response = transaction_locked(handle, READ, MAX_PAYLOAD as i32, offset, path.as_bytes())?;
            let count = response.payload.len();
            file.write_all(&response.payload)
                .map_err(|error| format!("cannot write download file: {error}"))?;
            offset = response.offset;
            if count < MAX_PAYLOAD { break; }
        }
        file.sync_all().map_err(|error| format!("cannot flush download file: {error}"))?;
        Ok(offset)
    })
}

pub fn write_all(path: &str, data: &[u8]) -> Result<(), String> {
    write_all_with_progress(path, data, |_, _| {})
}

pub fn write_all_with_progress(
    path: &str,
    data: &[u8],
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    if path.len() > u16::MAX as usize { return Err("remote path is too long".into()); }
    with_device(|handle| {
        transaction_locked(handle, WRITE_BEGIN, 0, 0, path.as_bytes())?;
        let chunk_size = MAX_PAYLOAD.saturating_sub(path.len() + 2);
        let mut offset = 0usize;
        progress(0, data.len() as u64);
        let result = (|| {
            while offset < data.len() {
                let count = chunk_size.min(data.len() - offset);
                let mut payload = Vec::with_capacity(2 + path.len() + count);
                payload.extend_from_slice(&(path.len() as u16).to_le_bytes());
                payload.extend_from_slice(path.as_bytes());
                payload.extend_from_slice(&data[offset..offset + count]);
                transaction_locked(handle, WRITE_DATA, 0, offset as u64, &payload)?;
                offset += count;
                progress(offset as u64, data.len() as u64);
            }
            transaction_locked(handle, WRITE_COMMIT, 0, offset as u64, path.as_bytes())?;
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

pub fn mkdir(path: &str) -> Result<(), String> {
    with_device(|handle| transaction_locked(handle, MKDIR, 0, 0, path.as_bytes()).map(|_| ()))
}

/// Ask the board to install a staged firmware file and report eMMC write and
/// readback verification progress frames sent by the board.
pub fn apply_firmware_with_progress(
    path: &str,
    mut progress: impl FnMut(FirmwareUpdateProgress),
) -> Result<String, String> {
    with_device(|handle| {
        let request_id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
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
            let mut response_header = [0u8; HEADER_SIZE];
            read_exact(handle, &mut response_header, FIRMWARE_UPDATE_TIMEOUT)?;
            let response_magic = u32::from_le_bytes(response_header[0..4].try_into().unwrap());
            let response_version = u16::from_le_bytes(response_header[4..6].try_into().unwrap());
            let response_opcode = u16::from_le_bytes(response_header[6..8].try_into().unwrap());
            let response_id = u32::from_le_bytes(response_header[8..12].try_into().unwrap());
            let response_status = i32::from_le_bytes(response_header[12..16].try_into().unwrap());
            let response_length = u32::from_le_bytes(response_header[16..20].try_into().unwrap()) as usize;
            let response_offset = u64::from_le_bytes(response_header[20..28].try_into().unwrap());
            let response_crc = u32::from_le_bytes(response_header[28..32].try_into().unwrap());

            if response_magic != MAGIC || response_version != VERSION ||
                response_opcode != (UPDATE | 0x8000) || response_id != request_id {
                return Err("invalid or out-of-sequence firmware update response".into());
            }
            if response_length > MAX_PAYLOAD {
                return Err("firmware update response payload is too large".into());
            }

            let mut payload = vec![0u8; response_length];
            if response_length > 0 {
                read_exact(handle, &mut payload, FIRMWARE_UPDATE_TIMEOUT)?;
                if crc32(&payload) != response_crc {
                    return Err("firmware update response CRC32 mismatch".into());
                }
            }

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

pub fn sim_write(payload: &[u8]) -> Result<(), String> {
    if payload.len() > 4096 {
        return Err("simulation USB record is too large".into());
    }
    /* Do not queue a simulation heartbeat behind a slow file operation.
     * Auto mode falls back to UDP, and USB mode retries at the next beat. */
    let _guard = USB_LOCK.try_lock()
        .map_err(|_| "simulation USB transport is busy".to_string())?;
    let handle = open()?;
    let mut frame = Vec::with_capacity(payload.len() + 8);
    frame.extend_from_slice(b"SIM1");
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    let count = handle.write_bulk(SIM_OUT, &frame, SIM_TIMEOUT)
        .map_err(|error| format!("simulation USB write failed: {error}"))?;
    if count != frame.len() {
        return Err(format!("short simulation USB write: {count}/{}", frame.len()));
    }
    Ok(())
}

/// Send a user-requested control/lifecycle frame.  Unlike the periodic
/// heartbeat, losing START/LOAD because the receiver owns the interface for
/// its 100 ms read window is not acceptable.  Wait only for that short window
/// and still leave Auto mode free to fall back to UDP on a real USB failure.
pub fn sim_write_control(payload: &[u8]) -> Result<(), String> {
    if payload.len() > 4096 {
        return Err("simulation USB record is too large".into());
    }
    with_device_quick(|handle| {
        let mut frame = Vec::with_capacity(payload.len() + 8);
        frame.extend_from_slice(b"SIM1");
        frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        frame.extend_from_slice(payload);
        let count = handle.write_bulk(SIM_OUT, &frame, SIM_TIMEOUT)
            .map_err(|error| format!("simulation USB write failed: {error}"))?;
        if count != frame.len() {
            return Err(format!("short simulation USB write: {count}/{}", frame.len()));
        }
        Ok(())
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

fn read_sim_frame(handle: &DeviceHandle<Context>, buffer: &mut Vec<u8>,
                  timeout: Duration) -> Result<Option<Vec<u8>>, String> {
    if let Some(frame) = take_sim_frame(buffer)? {
        return Ok(Some(frame));
    }

    /* Read one USB packet at a time.  The NuttX endpoint emits larger SIM1
     * records as consecutive 512-byte packets followed by a short packet. */
    let mut packet = [0u8; 512];
    match handle.read_bulk(SIM_IN, &mut packet, timeout) {
        Ok(count) => buffer.extend_from_slice(&packet[..count]),
        Err(rusb::Error::Timeout) => return Ok(None),
        Err(error) => return Err(format!("simulation USB read failed: {error}")),
    }
    take_sim_frame(buffer)
}

pub fn sim_read() -> Result<Option<Vec<u8>>, String> {
    let _guard = USB_LOCK.try_lock()
        .map_err(|_| "simulation USB transport is busy".to_string())?;
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
    let _guard = USB_LOCK.lock().map_err(|_| "USB transport lock poisoned".to_string())?;
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
