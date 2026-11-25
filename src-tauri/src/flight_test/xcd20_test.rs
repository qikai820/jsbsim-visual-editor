use super::{engine::Engine,xml};
fn fixture(name:&str)->Engine{
    let all:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/xcd20-validation.json")).unwrap();
    Engine::new(xml::parse(all[name].as_str().unwrap()).unwrap())
}
fn observe(name:&str,missing:bool,spike:bool)->Engine{
    let mut e=fixture(name);
    for step in 0..100{
        e.set("test/runtime/ready",1.);
        if name=="relative"{e.set("test/fc/local-x-m",100.+if step>5{0.5}else{0.});}
        else if !(missing&&step>=15){e.set("test/fc/relative-alt-m",if spike&&step==15{3.6}else{3.});}
        else{e.properties.remove("test/fc/relative-alt-m");}
        e.tick(step as f64*0.02).unwrap();if e.failed()||e.done(){break;}
    }e
}
#[test]fn continuous_observation_requires_entire_window_and_fresh_data(){
    assert!(observe("observe",false,false).done());
    let spike=observe("observe",false,true);assert!(spike.failed()&&!spike.done());
    let missing=observe("observe",true,false);assert!(missing.failed()&&!missing.done());
    assert!(observe("relative",false,false).done());
}
#[test]fn launch_height_is_captured_and_added_to_nav_takeoff_target(){
    let mut e=fixture("launch");e.set("test/runtime/ready",1.);e.set("test/fc/armed",0.);e.set("test/fc/landed",1.);e.set("test/fc/relative-alt-m",0.7);e.set("test/fc/altitude-msl-m",100.7);
    e.tick(0.).unwrap();e.set("test/fc/relative-alt-m",0.);e.tick(0.06).unwrap();
    assert!((e.value("test/flow/xcd20_launch/choice").unwrap()-100.7).abs()<1e-6);
    let cmd=e.commands().unwrap();assert_eq!(cmd.len(),1);assert_eq!(cmd[0].kind,4);assert!((cmd[0].argument-3.).abs()<1e-6);
    let mut airborne=fixture("launch");airborne.set("test/runtime/ready",1.);airborne.set("test/fc/armed",1.);airborne.set("test/fc/landed",0.);airborne.set("test/fc/relative-alt-m",0.7);e.set("test/fc/altitude-msl-m",100.7);airborne.tick(0.).unwrap();assert!(airborne.failed());assert!(airborne.commands().unwrap().is_empty());
}
#[test]fn exported_xcd20_scripts_parse_with_actual_native_engine(){
    for source in [include_str!("../../../examples/flight-tests/xcd20-takeoff/XCD20_NormalTakeoff.xml"),include_str!("../../../examples/flight-tests/xcd20-takeoff/XCD20_RailTakeoff.xml")]{let s=xml::parse(source).unwrap();assert!(s.events.len()>100);assert!(s.properties.keys().all(|k|xml::writable(k)||xml::readonly(k)));}
}
