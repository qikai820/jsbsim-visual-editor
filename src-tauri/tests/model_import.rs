// Keep these import tests independent of legacy binary tests whose fixtures
// live outside the repository. Exercise the production scanner unchanged.
#[path = "../src/model_import.rs"]
mod model_import;

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}
#[path = "../src/xml_diagnostics.rs"]
mod xml_diagnostics;
