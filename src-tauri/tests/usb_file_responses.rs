#[allow(dead_code)] #[path = "../src/model_read.rs"] mod model_read;
// Isolate transport tests from unrelated legacy binary fixture dependencies.
#[allow(dead_code)]
#[path = "../src/usb_file.rs"]
mod usb_file;
