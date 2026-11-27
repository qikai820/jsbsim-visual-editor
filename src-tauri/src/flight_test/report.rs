//! Durable records for terminal desktop runs. The runner hands off its own
//! capture, so rendering never needs the controller or the MAVLink transport.
mod render;

use super::{Options, Snapshot, Trace};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};
use tauri::Manager;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metadata {
    #[serde(default)]
    pub(crate) stage_labels: Vec<String>,
    pub(crate) aircraft_label: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExitState {
    NotRequired,
    Simulated,
    Confirmed,
    Unconfirmed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Outcome {
    pub(crate) execution_status: String,
    pub(crate) reason: String,
    pub(crate) exit_state: ExitState,
    pub(crate) policy: Option<String>,
}

impl Outcome {
    pub(crate) fn before_script(status: &str, reason: String) -> Self {
        Self {
            execution_status: status.into(),
            reason,
            exit_state: ExitState::NotRequired,
            policy: None,
        }
    }

    pub(crate) fn after_script(
        status: &str,
        reason: String,
        policy: &str,
        dry: bool,
        confirmed: bool,
    ) -> Self {
        let exit_state = if !confirmed {
            ExitState::Unconfirmed
        } else if dry {
            ExitState::Simulated
        } else {
            ExitState::Confirmed
        };
        Self {
            execution_status: status.into(),
            reason,
            exit_state,
            policy: Some(policy.into()),
        }
    }
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StageState {
    Completed,
    Incomplete,
    NotRun,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stage {
    pub(crate) label: String,
    pub(crate) state: StageState,
    pub(crate) completed_at: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SaveState {
    Saving,
    Ready,
    Failed,
    Recorded,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveStatus {
    pub(crate) id: String,
    state: SaveState,
    error: Option<String>,
}

impl ArchiveStatus {
    pub(crate) fn new(run_id: u64, started: Duration) -> Self {
        let id = format!(
            "test-{}-{run_id}-{}-{}",
            started.as_millis(),
            std::process::id(),
            started.as_nanos()
        );
        Self {
            id,
            state: SaveState::Saving,
            error: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    #[serde(flatten)]
    archive: ArchiveStatus,
    name: String,
    status: String,
    dry_run: bool,
    started_at_unix_ms: u64,
    model: Option<String>,
}

impl Entry {
    fn new(id: String, result: &Snapshot) -> Self {
        Self {
            archive: ArchiveStatus {
                id,
                state: SaveState::Saving,
                error: None,
            },
            name: result.name.clone(),
            status: result.status.clone(),
            dry_run: result.dry_run,
            started_at_unix_ms: result.started_at_unix_ms,
            model: result
                .binding
                .as_ref()
                .map(|b| b.model.clone())
                .or_else(|| result.aircraft_label.clone()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Record<'a> {
    format: &'static str,
    version: u8,
    source_xml: &'a str,
    options: Option<&'a Options>,
    result: &'a Snapshot,
    trace: &'a [Trace],
    trace_interval_seconds: f64,
    trace_limit: usize,
    event_log_limit: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_id: Option<&'a str>,
}

impl<'a> Record<'a> {
    pub(super) fn new(
        source_xml: &'a str,
        options: Option<&'a Options>,
        result: &'a Snapshot,
        trace: &'a [Trace],
        trace_interval_seconds: f64,
        archive_id: Option<&'a str>,
    ) -> Self {
        Self {
            format: "px4-jsbsim-flight-test",
            version: 1,
            source_xml,
            options,
            result,
            trace,
            trace_interval_seconds,
            trace_limit: 40000,
            event_log_limit: 2000,
            archive_id,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecord {
    result: Snapshot,
    options: Option<Options>,
    trace: Vec<Trace>,
    trace_interval_seconds: f64,
}

#[derive(Deserialize)]
struct RecordHeader {
    result: Snapshot,
}

#[derive(Clone)]
pub(super) struct Capture {
    pub(super) snapshot: Arc<Mutex<Snapshot>>,
    pub(super) source: Arc<str>,
    pub(super) options: Options,
    pub(super) trace: Arc<Mutex<Vec<Trace>>>,
    pub(super) interval: f64,
}

struct Job {
    entry: Entry,
    capture: Option<Capture>,
}

fn jobs() -> &'static (Mutex<BTreeMap<String, Job>>, Condvar) {
    static JOBS: OnceLock<(Mutex<BTreeMap<String, Job>>, Condvar)> = OnceLock::new();
    JOBS.get_or_init(|| (Mutex::new(BTreeMap::new()), Condvar::new()))
}

struct Paths {
    json: PathBuf,
    html: PathBuf,
    summary: Option<PathBuf>,
}

impl Paths {
    fn new(directory: &Path, id: &str) -> Result<Self, String> {
        let parts: Vec<_> = id.strip_prefix("test-").unwrap_or("").split('-').collect();
        if !matches!(parts.len(), 2 | 4)
            || !parts.iter().all(|part| {
                !part.is_empty() && part.len() <= 39 && part.bytes().all(|b| b.is_ascii_digit())
            })
        {
            return Err("测试报告标识无效".into());
        }
        if parts.len() == 2 {
            return Ok(Self {
                json: directory.join(format!("{id}.json")),
                html: directory.join(format!("{id}.html")),
                summary: None,
            });
        }
        let run = directory.join(id);
        Ok(Self {
            json: run.join("report.json"),
            html: run.join("report.html"),
            summary: Some(run.join("summary.json")),
        })
    }
}

fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let file = File::open(path).map_err(|e| format!("{}：{e}", path.display()))?;
    serde_json::from_reader(BufReader::new(file)).map_err(|e| format!("{}：{e}", path.display()))
}

fn write_atomic(
    path: &Path,
    write: impl FnOnce(&mut BufWriter<File>) -> Result<(), String>,
) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let temp = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = BufWriter::new(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?,
        );
        write(&mut file)?;
        file.flush().map_err(|e| e.to_string())?;
        file.get_ref().sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temp, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e: String| format!("{}：{e}", path.display()))
}

fn write_report(directory: &Path, entry: &Entry, capture: Option<&Capture>) -> Result<(), String> {
    let paths = Paths::new(directory, &entry.archive.id)?;
    if let Some(capture) = capture {
        let mut snapshot = capture.snapshot.lock().map_err(|e| e.to_string())?.clone();
        snapshot.archive = None;
        // The runner has exited before enqueue. This lock belongs only to this run.
        let trace = capture.trace.lock().map_err(|e| e.to_string())?;
        fs::create_dir_all(paths.json.parent().expect("report parent"))
            .map_err(|e| e.to_string())?;
        if !paths.json.is_file() {
            let record = Record::new(
                &capture.source,
                Some(&capture.options),
                &snapshot,
                &trace,
                capture.interval,
                Some(&entry.archive.id),
            );
            write_atomic(&paths.json, |file| {
                serde_json::to_writer(file, &record).map_err(|e| e.to_string())
            })?;
        }
        write_summary(&paths, entry)?;
        return write_html(
            &paths,
            &snapshot,
            Some(&capture.options),
            &trace,
            capture.interval,
        );
    }
    let record: StoredRecord = read(&paths.json)?;
    write_summary(&paths, entry)?;
    write_html(
        &paths,
        &record.result,
        record.options.as_ref(),
        &record.trace,
        record.trace_interval_seconds,
    )
}

fn write_summary(paths: &Paths, entry: &Entry) -> Result<(), String> {
    if let Some(summary) = &paths.summary {
        if !summary.is_file() {
            write_atomic(summary, |file| {
                serde_json::to_writer(file, entry).map_err(|e| e.to_string())
            })?;
        }
    }
    Ok(())
}

fn write_html(
    paths: &Paths,
    result: &Snapshot,
    options: Option<&Options>,
    trace: &[Trace],
    interval: f64,
) -> Result<(), String> {
    if paths.html.is_file() {
        return Ok(());
    }
    let json_filename = paths
        .json
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("运行记录文件名无效")?;
    let html = render::html(result, options, trace, interval, json_filename);
    write_atomic(&paths.html, |file| {
        file.write_all(html.as_bytes()).map_err(|e| e.to_string())
    })
}

fn sync_status(job: &Job) {
    if let Some(capture) = &job.capture {
        if let Ok(mut snapshot) = capture.snapshot.lock() {
            snapshot.archive = Some(job.entry.archive.clone());
        }
    }
}

fn complete(id: &str, result: Result<(), String>) {
    let (jobs, changed) = jobs();
    let mut jobs = jobs.lock().expect("report jobs");
    if let Some(job) = jobs.get_mut(id) {
        let ok = result.is_ok();
        job.entry.archive.state = if ok {
            SaveState::Ready
        } else {
            SaveState::Failed
        };
        job.entry.archive.error = result.err();
        sync_status(job);
        if ok {
            jobs.remove(id);
        }
    }
    changed.notify_all();
}

fn write_in_background(directory: Result<PathBuf, String>, entry: Entry, capture: Option<Capture>) {
    let id = entry.archive.id.clone();
    let outcome = thread::Builder::new()
        .name("flight-test-report".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                directory.and_then(|dir| write_report(&dir, &entry, capture.as_ref()))
            }))
            .unwrap_or_else(|_| Err("测试报告生成异常".into()));
            complete(&entry.archive.id, result);
        });
    if let Err(error) = outcome {
        complete(&id, Err(error.to_string()));
    }
}

pub(super) fn enqueue(directory: Result<PathBuf, String>, id: String, capture: Capture) {
    let entry = {
        let snapshot = capture
            .snapshot
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        Entry::new(id, &snapshot)
    };
    jobs().0.lock().expect("report jobs").insert(
        entry.archive.id.clone(),
        Job {
            entry: entry.clone(),
            capture: Some(capture.clone()),
        },
    );
    write_in_background(directory, entry, Some(capture));
}

pub(crate) fn wait_for_writes() {
    let (jobs, changed) = jobs();
    drop(
        changed
            .wait_while(jobs.lock().expect("report jobs"), |jobs| {
                jobs.values()
                    .any(|job| job.entry.archive.state == SaveState::Saving)
            })
            .expect("report jobs"),
    );
}

fn read_entry(directory: &Path, id: &str) -> Result<Entry, String> {
    let paths = Paths::new(directory, id)?;
    let index = paths
        .summary
        .as_deref()
        .and_then(|path| read::<Entry>(path).ok());
    let mut entry = match index {
        Some(entry) if paths.json.is_file() => entry,
        _ => Entry::new(id.into(), &read::<RecordHeader>(&paths.json)?.result),
    };
    entry.archive.id = id.into();
    entry.archive.state = if paths.html.is_file() {
        SaveState::Ready
    } else {
        SaveState::Recorded
    };
    entry.archive.error = None;
    Ok(entry)
}

pub(crate) fn list(directory: &Path) -> Result<Vec<Entry>, String> {
    let mut entries = BTreeMap::new();
    match fs::read_dir(directory) {
        Ok(items) => {
            for item in items.flatten() {
                let path = item.path();
                let id = if path.is_dir() {
                    path.file_name().and_then(|name| name.to_str())
                } else if path
                    .extension()
                    .is_some_and(|extension| extension == "json")
                {
                    path.file_stem().and_then(|name| name.to_str())
                } else {
                    None
                };
                if let Some(id) = id {
                    if let Ok(entry) = read_entry(directory, id) {
                        entries.insert(id.to_owned(), entry);
                    }
                }
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    for (id, job) in jobs().0.lock().expect("report jobs").iter() {
        entries.insert(id.clone(), job.entry.clone());
    }
    let mut entries: Vec<Entry> = entries.into_values().collect();
    entries.sort_by(|a, b| {
        b.started_at_unix_ms
            .cmp(&a.started_at_unix_ms)
            .then_with(|| b.archive.id.cmp(&a.archive.id))
    });
    Ok(entries)
}

pub(crate) fn retry(directory: PathBuf, id: String) -> Result<Entry, String> {
    Paths::new(&directory, &id)?;
    let persistent = if jobs().0.lock().expect("report jobs").contains_key(&id) {
        None
    } else {
        Some(read_entry(&directory, &id))
    };
    let (entry, capture) = {
        let mut jobs = jobs().0.lock().expect("report jobs");
        match jobs.get_mut(&id) {
            Some(job) => {
                if job.entry.archive.state == SaveState::Saving {
                    return Ok(job.entry.clone());
                }
                job.entry.archive.state = SaveState::Saving;
                job.entry.archive.error = None;
                sync_status(job);
                (job.entry.clone(), job.capture.clone())
            }
            None => {
                let Some(persistent) = persistent else {
                    drop(jobs);
                    return read_entry(&directory, &id);
                };
                let mut entry = persistent?;
                if entry.archive.state == SaveState::Ready {
                    return Ok(entry);
                }
                entry.archive.state = SaveState::Saving;
                jobs.insert(
                    id,
                    Job {
                        entry: entry.clone(),
                        capture: None,
                    },
                );
                (entry, None)
            }
        }
    };
    write_in_background(Ok(directory), entry.clone(), capture);
    Ok(entry)
}

pub(crate) fn html_path(directory: &Path, id: &str) -> Result<PathBuf, String> {
    let paths = Paths::new(directory, id)?;
    if !paths.json.is_file() || !paths.html.is_file() {
        return Err("测试报告尚未生成".into());
    }
    let root = directory.canonicalize().map_err(|e| e.to_string())?;
    let path = paths.html.canonicalize().map_err(|e| e.to_string())?;
    if path.starts_with(&root)
        && path
            .extension()
            .is_some_and(|extension| extension == "html")
    {
        Ok(path)
    } else {
        Err("报告路径不在归档目录内".into())
    }
}

pub(crate) fn save_latest(directory: PathBuf) -> Result<serde_json::Value, String> {
    let mut result = super::status();
    if !matches!(result.status.as_str(), "passed" | "failed" | "stopped") {
        return Err("请在测试退出完成后保存记录".into());
    }
    let id = result.archive.take().ok_or("还没有测试归档")?.id;
    // The terminal snapshot is published just before the runner enqueues its capture.
    if super::running() {
        return Err("请在测试退出完成后保存记录".into());
    }
    retry(directory.clone(), id.clone())?;
    let (jobs, changed) = jobs();
    let remaining = changed
        .wait_while(jobs.lock().expect("report jobs"), |jobs| {
            jobs.get(&id)
                .is_some_and(|job| job.entry.archive.state == SaveState::Saving)
        })
        .expect("report jobs");
    let paths = Paths::new(&directory, &id)?;
    if !paths.json.is_file() {
        return Err(remaining
            .get(&id)
            .and_then(|job| job.entry.archive.error.clone())
            .unwrap_or_else(|| "运行记录尚未保存".into()));
    }
    Ok(
        serde_json::json!({"path": paths.json, "htmlPath": paths.html.is_file().then_some(paths.html), "result": result}),
    )
}

pub(crate) fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("test-reports"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn flight_test_report_list(app: tauri::AppHandle) -> Result<Vec<Entry>, String> {
    let directory = directory(&app)?;
    crate::run_blocking(move || list(&directory)).await
}

#[tauri::command]
pub async fn flight_test_report_retry(app: tauri::AppHandle, id: String) -> Result<Entry, String> {
    let directory = directory(&app)?;
    crate::run_blocking(move || retry(directory, id)).await
}
