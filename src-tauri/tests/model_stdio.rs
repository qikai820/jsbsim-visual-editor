#![cfg(unix)]
#![allow(dead_code)]

#[path = "../src/file_index.rs"] mod file_index;

// Reproduce a launcher/terminal losing its stdout reader. Run the actual
// index builder without libtest's output capture, then restore stdout before
// the test harness prints its own result.
#[test]
fn model_index_survives_closed_stdout() {
    use std::process::{Command, Stdio};
    let directory = std::env::temp_dir().join(format!("jsbsim-model-stdio-{}", std::process::id()));
    std::fs::create_dir_all(directory.join("aircraft/fixture")).unwrap();
    std::fs::write(directory.join("aircraft/fixture/fixture.xml"), "<fdm_config name=\"fixture\"/>").unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "model_index_worker", "--nocapture"])
        .env("MODEL_STDIO_WORKER", "1").env("JSBSIM_ROOT", &directory)
        .stdout(Stdio::piped()).stderr(Stdio::piped()).output().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
    assert!(output.status.success(), "model indexing failed with closed stdout:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}

#[test]
fn model_index_worker() {
    if std::env::var_os("MODEL_STDIO_WORKER").is_none() { return; }
    struct RestoreStdout(i32);
    impl Drop for RestoreStdout {
        fn drop(&mut self) { unsafe { libc::dup2(self.0, libc::STDOUT_FILENO); libc::close(self.0); } }
    }
    let saved = unsafe { libc::dup(libc::STDOUT_FILENO) };
    assert!(saved >= 0);
    let mut pipe = [-1; 2];
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    unsafe {
        libc::close(pipe[0]); // No reader: writing now returns EPIPE.
        assert_eq!(libc::dup2(pipe[1], libc::STDOUT_FILENO), libc::STDOUT_FILENO);
        libc::close(pipe[1]);
    }
    let restore = RestoreStdout(saved);
    let cache = std::sync::Mutex::new(None::<file_index::FileIndex>);
    let result = std::panic::catch_unwind(|| {
        for _ in 0..2 {
            let mut guard = cache.lock().unwrap();
            // Rebuild to exercise the diagnostic on both initial load and retry.
            *guard = Some(file_index::build_file_index());
            assert!(guard.as_ref().unwrap().contains_key("aircraft/fixture/fixture.xml"));
        }
    });
    drop(restore);
    assert!(result.is_ok(), "logging to a closed stdout must not abort model indexing");
    assert!(!cache.is_poisoned(), "diagnostic output must not poison the model cache");
}
