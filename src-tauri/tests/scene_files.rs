#[path = "../src/scene_files.rs"]
mod scene_files;

async fn run_blocking<T, F>(work: F) -> Result<T, String>
where T: Send + 'static, F: FnOnce() -> Result<T, String> + Send + 'static {
    tokio::task::spawn_blocking(work).await.map_err(|e| e.to_string())?
}
