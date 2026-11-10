//! Cooperative cancellation for a desktop model read, including channel waits.
//! Each small I/O operation keeps its own timeout; the complete read has a
//! separate budget so missing references cannot keep retrying indefinitely.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const LOAD_TIMEOUT: Duration = Duration::from_secs(90);
pub const CHANNEL_WAIT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct ReadControl {
    cancelled: Arc<AtomicBool>,
    deadline: Option<Instant>,
}

impl Default for ReadControl {
    fn default() -> Self {
        Self { cancelled: Arc::new(AtomicBool::new(false)), deadline: None }
    }
}

impl ReadControl {
    pub fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) { return Err("已取消加载模型".into()); }
        if self.deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err("读取模型文件超过 90 秒，请检查仿真机连接后重试".into());
        }
        Ok(())
    }

    pub fn lock<'a, T>(&self, mutex: &'a Mutex<T>, timeout: Duration, channel: &str) -> Result<MutexGuard<'a, T>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            self.check()?;
            if Instant::now() >= deadline {
                return Err(format!("{channel} 通道忙，等待超时；本次请求尚未发送，请稍后重试 (lock wait timed out)"));
            }
            match mutex.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(_)) => return Err(format!("{channel} lock poisoned")),
                Err(TryLockError::WouldBlock) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(format!("{channel} 通道忙，等待超时；本次请求尚未发送，请稍后重试 (lock wait timed out)"));
                    }
                    std::thread::sleep(remaining.min(Duration::from_millis(10)));
                }
            }
        }
    }
}

struct Entry { control: ReadControl, started: bool, expires: Instant }
#[derive(Default)]
pub struct ReadRequests { entries: Mutex<HashMap<String, Entry>> }

impl ReadRequests {
    pub fn begin(&self, id: &str) -> Result<ReadControl, String> {
        validate_id(id)?;
        let mut entries = self.entries.lock().map_err(|_| "model read registry poisoned")?;
        entries.retain(|_, entry| Instant::now() < entry.expires);
        if let Some(entry) = entries.get(id) {
            entry.control.check()?;
            return Err("重复的模型读取请求".into());
        }
        if entries.len() >= 128 { return Err("模型读取请求过多，请稍后重试".into()); }
        let expires = Instant::now() + LOAD_TIMEOUT;
        let control = ReadControl { deadline: Some(expires), ..ReadControl::default() };
        entries.insert(id.into(), Entry { control: control.clone(), started: true, expires });
        Ok(control)
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let mut entries = self.entries.lock().map_err(|_| "model read registry poisoned")?;
        entries.retain(|_, entry| Instant::now() < entry.expires);
        if let Some(entry) = entries.get(id) {
            entry.control.cancelled.store(true, Ordering::Release);
        } else if entries.len() < 128 {
            // IPC cancellation can arrive before the async load command starts.
            // Retain a short-lived tombstone so that command cannot run later.
            let control = ReadControl::default();
            control.cancelled.store(true, Ordering::Release);
            entries.insert(id.into(), Entry { control, started: false, expires: Instant::now() + LOAD_TIMEOUT });
        }
        Ok(())
    }

    pub fn finish(&self, id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            if entries.get(id).is_some_and(|entry| entry.started) { entries.remove(id); }
        }
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
        return Err("无效的模型读取请求编号".into());
    }
    Ok(())
}

pub fn requests() -> &'static ReadRequests {
    static REQUESTS: OnceLock<ReadRequests> = OnceLock::new();
    REQUESTS.get_or_init(ReadRequests::default)
}

pub struct ModelRead { pub control: ReadControl, id: Option<String> }
impl ModelRead {
    pub fn begin(id: Option<String>) -> Result<Self, String> {
        let control = if let Some(id) = &id { requests().begin(id)? }
            else { ReadControl { deadline: Some(Instant::now() + LOAD_TIMEOUT), ..ReadControl::default() } };
        Ok(Self { control, id })
    }
}
impl Drop for ModelRead {
    fn drop(&mut self) { if let Some(id) = &self.id { requests().finish(id); } }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_lock_wait_never_executes_after_channel_is_released() {
        let requests = ReadRequests::default();
        let control = requests.begin("first").unwrap();
        let mutex = Arc::new(Mutex::new(()));
        let held = mutex.lock().unwrap();
        let reader_mutex = Arc::clone(&mutex);
        let reader = std::thread::spawn(move || control.lock(&reader_mutex, CHANNEL_WAIT, "NSH").map(|_| ()));
        requests.cancel("first").unwrap();
        assert!(reader.join().unwrap().unwrap_err().contains("已取消"));
        requests.finish("first");
        drop(held);
        assert!(requests.begin("retry").unwrap().lock(&mutex, CHANNEL_WAIT, "NSH").is_ok());
    }

    #[test]
    fn busy_channel_expires_and_retry_works_without_restart() {
        let mutex = Mutex::new(());
        let held = mutex.lock().unwrap();
        let control = ReadControl::default();
        let started = Instant::now();
        assert!(control.lock(&mutex, Duration::from_millis(30), "FTP").unwrap_err().contains("lock wait timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(held);
        assert!(control.lock(&mutex, CHANNEL_WAIT, "FTP").is_ok());
    }

    #[test]
    fn early_cancellation_and_expired_budget_prevent_io() {
        let requests = ReadRequests::default();
        requests.cancel("early").unwrap();
        assert!(requests.begin("early").err().unwrap().contains("已取消"));
        let expired = ReadControl { deadline: Some(Instant::now()), ..ReadControl::default() };
        assert!(expired.lock(&Mutex::new(()), CHANNEL_WAIT, "NSH").unwrap_err().contains("90 秒"));
    }
}
