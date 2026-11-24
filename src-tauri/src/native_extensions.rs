//! Detect native contact requirements before an older engine can ignore them.
use quick_xml::{Reader, events::Event};

fn inspect(xml: &str) -> Result<(bool, Vec<String>), String> {
    let mut reader=Reader::from_str(xml);let mut buffer=Vec::new();
    let mut required=false;let mut files=Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(el)|Event::Empty(el)) => {
                if el.name().as_ref()==b"moving_platform" {
                    let version=el.attributes().filter_map(Result::ok).find(|a|a.key.as_ref()==b"version")
                        .map(|a|String::from_utf8_lossy(&a.value).into_owned());
                    if version.as_deref()!=Some("1") {return Err("不支持的移动平台模块版本".into());}
                    required=true;
                }
                if el.name().as_ref()==b"external_reactions" {
                    for a in el.attributes() {
                        let a=a.map_err(|e|e.to_string())?;
                        if a.key.as_ref()==b"file" {files.push(String::from_utf8_lossy(&a.value).into_owned());}
                    }
                }
            },
            Ok(Event::Eof)=>break,
            Err(e)=>return Err(e.to_string()),
            _=>{},
        }
        buffer.clear();
    }
    Ok((required,files))
}

pub fn requires_moving_platform(model:&str,main:&str,mut read:impl FnMut(&str)->Result<String,String>) -> Result<bool,String> {
    let (mut required,files)=inspect(main)?;
    required|=main.contains("[requires:moving_platform=1]");
    for mut name in files {
        if name.starts_with('/') || name.split('/').any(|part|part=="..") {return Err("非法外力文件路径".into());}
        if !name.ends_with(".xml") {name.push_str(".xml");}
        let path=if name.contains('/') {name} else {format!("aircraft/{model}/{name}")};
        // A missing force file cannot be treated as an absent extension.
        required|=inspect(&read(&path)?)?.0;
    }
    Ok(required)
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn direct_and_referenced_and_comments() {
        assert!(requires_moving_platform("x","<fdm_config><external_reactions><moving_platform version=\"1\"/></external_reactions></fdm_config>", |_|panic!()).unwrap());
        assert!(requires_moving_platform("x","<fdm_config><external_reactions file=\"Body.xml\"/></fdm_config>", |p| {assert_eq!(p,"aircraft/x/Body.xml");Ok("<external_reactions><moving_platform version=\"1\"/></external_reactions>".into())}).unwrap());
        assert!(!requires_moving_platform("x","<fdm_config><!-- <moving_platform version=\"1\"/> --></fdm_config>", |_|panic!()).unwrap());
        assert!(requires_moving_platform("x","<fdm_config><moving_platform version=\"2\"/></fdm_config>", |_|panic!()).is_err());
        assert!(requires_moving_platform("x","<fdm_config><external_reactions file=\"../Body.xml\"/></fdm_config>", |_|panic!()).is_err());
    }
}
