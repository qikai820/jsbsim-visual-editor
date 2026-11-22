//! Versioned, relocatable simulator assets; writable models live outside the package.
use serde::{Deserialize, Serialize};
use std::{fs, path::{Component, Path, PathBuf}};

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct Manifest {
    schema:u32, id:String, target:String, name:String, model:String, script:String,
    airframe:u32, python:String, px4_commands:Vec<String>,
    hil_host:String, px4_hil_port:u16, model_hil_port:u16,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status { pub available:bool, pub name:String, pub version:Option<String>, pub error:Option<String> }
#[derive(Clone)]
pub struct Prepared {
    pub project:PathBuf, pub work:PathBuf, pub native:PathBuf, pub python:PathBuf,
    pub python_home:PathBuf, pub libraries:PathBuf, pub px4:PathBuf,
    pub model:String, pub script:String,
}
fn manifest(root:&Path)->Result<Manifest,String> {
    let raw=fs::read(root.join("manifest.json")).map_err(|_|"安装包未包含内置仿真组件，请使用包含仿真的安装包或选择自定义运行程序".to_string())?;
    let value:Manifest=serde_json::from_slice(&raw).map_err(|e|format!("内置仿真清单无效：{e}"))?;
    if value.schema!=1 || value.target!="x86_64-linux" || value.id.is_empty() || value.id.len()>64 || !value.id.bytes().all(|c|c.is_ascii_hexdigit()) {
        return Err("内置仿真版本或平台不受支持".into());
    }
    if value.model!="F450_PX4" || value.script!="F450_PX4_lan.xml" || value.airframe!=3010 || value.hil_host!="127.0.0.1" || value.px4_hil_port!=14561 || value.model_hil_port!=14560 {
        return Err("内置仿真预设不匹配".into());
    }
    if Path::new(&value.python).components().any(|c|!matches!(c,Component::Normal(_))) || !value.python.starts_with("python/bin/") {
        return Err("内置 Python 路径无效".into());
    }
    if !value.px4_commands.iter().all(|name|name.starts_with("px4-")&&name.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b'-')) {
        return Err("内置飞控命令清单无效".into());
    }
    for name in ["bin/jsbsim_realtime","px4/bin/px4","px4/bin/px4-alias.sh","px4/etc/init.d-posix/rcS","px4/etc/init.d-posix/airframes/3010_jsbsim_quadrotor_x","project/boards/pc/x86_64/services/supervisor.py","project/data/aviation/aircraft/F450_PX4/F450_PX4.xml","project/data/aviation/scripts/F450_PX4_lan.xml",&value.python] {
        if !root.join(name).is_file() { return Err(format!("内置仿真组件缺失：{name}")); }
    }
    Ok(value)
}
pub fn locate(resource:&Path)->PathBuf {
    let packaged=resource.join("builtin-simulation");
    if packaged.join("manifest.json").is_file() { return packaged; }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/builtin-simulation")
}
pub fn status(root:&Path)->Status {
    match manifest(root) {
        Ok(m)=>Status{available:cfg!(all(target_os="linux",target_arch="x86_64")),name:m.name,version:Some(m.id),error:if cfg!(all(target_os="linux",target_arch="x86_64")){None}else{Some("内置仿真目前支持 x86-64 Linux".into())}},
        Err(error)=>Status{available:false,name:"F450 四旋翼仿真".into(),version:None,error:Some(error)},
    }
}
fn copy_tree(source:&Path,target:&Path)->Result<(),String> {
    fs::create_dir_all(target).map_err(|e|e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e|e.to_string())? {
        let entry=entry.map_err(|e|e.to_string())?;
        let kind=entry.file_type().map_err(|e|e.to_string())?;
        let destination=target.join(entry.file_name());
        if kind.is_dir() { copy_tree(&entry.path(),&destination)?; }
        else if kind.is_file() { fs::copy(entry.path(),destination).map_err(|e|e.to_string())?; }
        else { return Err("内置组件不能包含符号链接或特殊文件".into()); }
    }
    Ok(())
}
fn executable(path:&Path)->Result<(),String> {
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let mut p=fs::metadata(path).map_err(|e|e.to_string())?.permissions(); p.set_mode(p.mode()|0o700);fs::set_permissions(path,p).map_err(|e|e.to_string())?; }
    Ok(())
}
pub fn prepare(root:&Path,data:&Path)->Result<Prepared,String> {
    let m=manifest(root)?;
    let home=data.join("builtin-simulation");
    let installed=home.join("assets").join(&m.id);
    let complete=fs::read_to_string(installed.join(".installed")).is_ok_and(|s|s==m.id);
    if !complete {
        if installed.exists() { return Err("内置仿真资源目录不完整，请重新安装上位机".into()); }
        let temporary=home.join(format!(".install-{}-{}",m.id,std::process::id()));
        if temporary.exists() { fs::remove_dir_all(&temporary).map_err(|e|e.to_string())?; }
        let result=(|| {
            copy_tree(root,&temporary)?;
            executable(&temporary.join("bin/jsbsim_realtime"))?;
            executable(&temporary.join("px4/bin/px4"))?;
            executable(&temporary.join(&m.python))?;
            #[cfg(unix)] for name in &m.px4_commands { std::os::unix::fs::symlink("px4",temporary.join("px4/bin").join(name)).map_err(|e|e.to_string())?; }
            fs::write(temporary.join(".installed"),&m.id).map_err(|e|e.to_string())?;
            fs::create_dir_all(installed.parent().unwrap()).map_err(|e|e.to_string())?;
            fs::rename(&temporary,&installed).map_err(|e|e.to_string())?;
            Ok::<_,String>(())
        })();
        if result.is_err() { let _=fs::remove_dir_all(temporary); }
        result?;
    }
    // Work, model edits and logs are stable across application/package upgrades.
    let work=home.join("workspace");fs::create_dir_all(&work).map_err(|e|e.to_string())?;
    Ok(Prepared{project:installed.join("project"),work,native:installed.join("bin/jsbsim_realtime"),python:installed.join(&m.python),python_home:installed.join("python"),libraries:installed.join("lib"),px4:installed.join("px4"),model:m.model,script:m.script})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root:&Path,id:&str) {
        let m=serde_json::json!({"schema":1,"id":id,"target":"x86_64-linux","name":"F450","model":"F450_PX4","script":"F450_PX4_lan.xml","airframe":3010,"python":"python/bin/python3","px4Commands":["px4-param"],"hilHost":"127.0.0.1","px4HilPort":14561,"modelHilPort":14560});
        fs::create_dir_all(root).unwrap();fs::write(root.join("manifest.json"),m.to_string()).unwrap();
        for file in ["bin/jsbsim_realtime","px4/bin/px4","px4/bin/px4-alias.sh","px4/etc/init.d-posix/rcS","px4/etc/init.d-posix/airframes/3010_jsbsim_quadrotor_x","project/boards/pc/x86_64/services/supervisor.py","project/data/aviation/aircraft/F450_PX4/F450_PX4.xml","project/data/aviation/scripts/F450_PX4_lan.xml","python/bin/python3"] {
            let p=root.join(file);fs::create_dir_all(p.parent().unwrap()).unwrap();fs::write(p,"fixture").unwrap();
        }
    }
    #[test]
    fn package_install_is_relocatable_and_preserves_user_workspace() {
        let root=std::env::temp_dir().join(format!("builtin-sim-{}",std::process::id()));let _=fs::remove_dir_all(&root);
        let assets=root.join("payload");fixture(&assets,"abc123");
        let a=prepare(&assets,&root.join("user")).unwrap();assert!(a.native.is_file());assert!(a.px4.join("bin/px4-param").is_file());
        fs::write(a.work.join("user-model.xml"),"user edit").unwrap();
        let b=prepare(&assets,&root.join("user")).unwrap();assert_eq!(a.work,b.work);
        fixture(&assets,"abc124");let c=prepare(&assets,&root.join("user")).unwrap();
        assert_ne!(a.native,c.native);assert_eq!(a.work,c.work);assert_eq!(fs::read_to_string(c.work.join("user-model.xml")).unwrap(),"user edit");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_and_unsafe_packages_are_rejected() {
        let root=std::env::temp_dir().join(format!("builtin-invalid-{}",std::process::id()));let _=fs::remove_dir_all(&root);
        assert!(!status(&root).available);fixture(&root,"abc123");
        let file=root.join("manifest.json");let mut m:serde_json::Value=serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        m["id"]="../escape".into();fs::write(&file,m.to_string()).unwrap();assert!(prepare(&root,&root.join("user")).is_err());
        fixture(&root,"abc123");fs::remove_file(root.join("bin/jsbsim_realtime")).unwrap();assert!(!status(&root).available);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore="requires the generated real simulator payload"]
    fn real_payload_runs_after_relocation_without_system_python_packages() {
        use std::process::Command;
        let payload=Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/builtin-simulation");
        let data=std::env::temp_dir().join(format!("builtin-real-{}",std::process::id()));let _=fs::remove_dir_all(&data);
        let b=prepare(&payload,&data).unwrap();
        let mut python=Command::new(&b.python);
        python.args(["-S","-c","import socket, socketserver, json, fcntl, xml.etree.ElementTree; print('ready')"])
            .env("PYTHONHOME",&b.python_home).env("PYTHONNOUSERSITE","1").env_remove("PYTHONPATH").env("LD_LIBRARY_PATH",&b.libraries);
        let result=python.output().unwrap();assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
        for binary in [&b.native,&b.px4.join("bin/px4")] {
            let result=Command::new(binary).arg("-h").env("LD_LIBRARY_PATH",&b.libraries).output().unwrap();
            assert!(result.status.success(),"{}: {}",binary.display(),String::from_utf8_lossy(&result.stderr));
        }
        let m=manifest(&payload).unwrap();
        assert_eq!(m.model,"F450_PX4");assert!(b.px4.join("bin/px4-commander").is_file());
        assert!(b.project.join("data/aviation/scripts/F450_PX4_lan.xml").is_file());
        fs::remove_dir_all(data).unwrap();
    }

}
