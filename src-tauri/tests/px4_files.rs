// Isolate the file/ULog tests from unrelated local firmware fixture paths.
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where T: Send + 'static, F: FnOnce() -> Result<T, String> + Send + 'static {
    tauri::async_runtime::spawn_blocking(operation).await.map_err(|e| e.to_string())?
}
#[path = "../src/px4_files.rs"]
mod px4_files;
