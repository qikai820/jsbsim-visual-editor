fn main() {
    // JSBSim paths: from environment or defaults
    let jsbsim_root = std::env::var("JSBSIM_ROOT")
        .unwrap_or_else(|_| "/home/qikai820/src/jsbsim_nuttx/jsbsim".to_string());
    let jsbsim_bin = std::env::var("JSBSIM_BIN")
        .unwrap_or_else(|_| format!("{}/build/src/JSBSim", jsbsim_root));

    println!("cargo:rustc-env=JSBSIM_ROOT={}", jsbsim_root);
    println!("cargo:rustc-env=JSBSIM_BIN={}", jsbsim_bin);
    println!("cargo:rerun-if-env-changed=JSBSIM_ROOT");
    println!("cargo:rerun-if-env-changed=JSBSIM_BIN");

    tauri_build::build()
}
