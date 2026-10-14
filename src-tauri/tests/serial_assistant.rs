// Build the local serial module alone so unrelated firmware XML fixtures are
// not required by the desktop binary's unit-test target.
async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

#[path = "../src/serial_assistant.rs"]
mod serial_assistant;
