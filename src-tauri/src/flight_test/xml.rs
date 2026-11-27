//! Strict, bounded FGScript event subset used by the overlay test runner.
//! Aircraft loading remains owned by the simulator; <use> is preserved metadata.
use quick_xml::{events::Event, Reader};
use std::collections::{BTreeMap, BTreeSet};
pub const MAX_TEST_SECONDS: f64 = 14400.;
pub const MAX_TEST_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug)]
pub enum Expr {
    Value(f64),
    Property(String),
    Function(String, Vec<Expr>),
}
#[derive(Clone, Debug)]
pub enum Condition {
    Compare(Expr, String, Expr),
    All(Vec<Condition>),
    Any(Vec<Condition>),
}
#[derive(Clone, Debug)]
pub struct Set {
    pub path: String,
    pub value: Expr,
    pub action: String,
    pub kind: String,
    pub tc: f64,
}
#[derive(Clone, Debug)]
pub struct ScriptEvent {
    pub name: String,
    pub condition: Condition,
    pub sets: Vec<Set>,
    pub persistent: bool,
    pub continuous: bool,
    pub delay: f64,
    pub notify: bool,
    pub description: String,
    pub notify_properties: Vec<(String, Expr)>,
}
#[derive(Clone, Debug)]
pub struct Script {
    pub name: String,
    pub end: f64,
    pub properties: BTreeMap<String, f64>,
    pub events: Vec<ScriptEvent>,
}
#[derive(Default, Debug)]
struct Node {
    tag: String,
    attrs: BTreeMap<String, String>,
    text: String,
    children: Vec<Node>,
}
impl Node {
    fn attr(&self, key: &str) -> &str {
        self.attrs.get(key).map(String::as_str).unwrap_or("")
    }
    fn children<'a>(&'a self, tag: &'a str) -> impl Iterator<Item = &'a Node> {
        self.children.iter().filter(move |n| n.tag == tag)
    }
    fn only(&self, allowed: &[&str]) -> Result<(), String> {
        if let Some(n) = self
            .children
            .iter()
            .find(|n| !allowed.contains(&n.tag.as_str()))
        {
            return Err(format!(
                "不支持的 XML 元素 <{}>（位于 <{}>）",
                n.tag, self.tag
            ));
        }
        Ok(())
    }
    fn attrs(&self, allowed: &[&str]) -> Result<(), String> {
        if let Some(k) = self.attrs.keys().find(|k| !allowed.contains(&k.as_str())) {
            return Err(format!("不支持的 XML 属性 {}（位于 <{}>）", k, self.tag));
        }
        Ok(())
    }
}
fn finite(text: &str) -> Result<f64, String> {
    text.trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("无效数值：{text}"))
}
pub fn writable(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    path.len() <= 180
        && !path.contains("..")
        && path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-/".contains(&c))
        && ((parts.len() == 3 && parts[0] == "test" && parts[1] == "requirements"
            && ["manual-tilt-deg","altitude-tilt-deg","vector-tilt-deg","morphquad-servo-range-deg","xcd20-takeoff"].contains(&parts[2]))
            || (parts.len() == 4
            && parts[0] == "test"
            && parts[1] == "channel"
            && super::channels::target(parts[2])
            && ["enabled", "value-norm"].contains(&parts[3]))
            || (parts.len() == 4
            && parts[0] == "test"
            && parts[1] == "flow"
            && ["started", "done", "cancelled", "deadline", "choice", "minimum", "maximum", "watchdog"].contains(&parts[3]))
            || (parts.len() == 4
                && parts[0] == "test"
                && parts[1] == "input"
                && [
                    "mask",
                    "enabled",
                    "roll-norm",
                    "pitch-norm",
                    "yaw-norm",
                    "throttle-norm",
                    "height-target-m",
                    "height-tolerance-m",
                    "height-hover-norm",
                    "height-min-norm",
                    "height-max-norm",
                    "height-slew-norm-s",
                    "height-kp",
                    "height-kd",
                    "height-ki",
                    "height-deadzone-norm",
                    "height-climb-max-mps",
                    "height-settle-s",
                    "angle-roll-deg",
                    "angle-pitch-deg",
                    "angle-hold-s",
                    "angle-tolerance-deg",
                    "angle-rate-deg-s",
                    "angle-settle-s",
                    "heading-target-deg",
                    "heading-hold-s",
                    "heading-tolerance-deg",
                    "heading-rate-deg-s",
                    "heading-settle-s",
                    "recover-reference",
                    "recover-mode",
                    "recover-heading",
                    "recover-position-m",
                    "recover-speed-mps",
                    "recover-settle-s",
                    "recover-max-speed-mps",
                    "recover-max-tilt-deg",
                    "recover-acceleration-mps2",
                    "recover-rate-deg-s",
                ]
                .contains(&parts[3]))
            || (parts.len() == 4
                && parts[0] == "test"
                && parts[1] == "command"
                && ["kind", "argument", "request"].contains(&parts[3]))
            || (parts.len() == 3
                && parts[0] == "test"
                && parts[1] == "rc"
                && [
                    "enabled",
                    "roll-norm",
                    "pitch-norm",
                    "yaw-norm",
                    "throttle-norm",
                    "input-kind",
                ]
                .contains(&parts[2]))
            || [
                "test/runtime/complete",
                "test/runtime/failed",
                "test/target/roll-deg",
                "test/target/pitch-deg",
            ]
            .contains(&path))
}
pub fn readonly(path: &str) -> bool {
    if ["contact-mask","valid-mask","released-mask"].iter().any(|k|path==format!("test/sim/rail-{k}")){return true;}
    ["origin-x-m","origin-y-m","heading-deg"].iter().any(|k| path == format!("test/reference/{k}"))
        || ["active","target-rad","target-deg","relative-target-deg","error-deg","held-s","position-error-m"].iter().any(|k| path == format!("test/heading/{k}"))
        || path == "simulation/sim-time-sec"
        || path.strip_prefix("test/output/").and_then(|s| s.strip_suffix("-norm"))
            .is_some_and(|s| super::channels::target(s) && s != "vector-switch")
        || path == "test/runtime/ready"
        || [
            "active",
            "target-m",
            "error-m",
            "throttle-norm",
            "holding",
            "takeoff",
            "climb-command-mps",
        ]
        .iter()
        .any(|k| path == format!("test/altitude/{k}"))
        || ((path.starts_with("test/attitude/") || path.starts_with("test/altitude/") || path.starts_with("test/manual/") || path.starts_with("test/heading/"))
            && path.split('/').count() == 4
            && path.ends_with("/status"))
        || [
            "active",
            "roll-target-deg",
            "pitch-target-deg",
            "error-deg",
            "held-s",
            "aux1-norm",
            "aux2-norm",
            "position-error-m",
            "command-roll-deg",
            "command-pitch-deg",
            "input-range-deg",
            "mode",
            "trim-roll-norm",
            "trim-pitch-norm",
            "input-saturated",
            "input-kind",
        ]
        .iter()
        .any(|k| path == format!("test/attitude/{k}"))
        || ["active", "phase", "origin-x-m", "origin-y-m", "position-error-m", "speed-mps", "target-speed-mps", "held-s", "command-roll-deg", "command-pitch-deg"]
            .iter().any(|k| path == format!("test/manual/{k}"))
        || [
            "armed",
            "hil",
            "mode",
            "relative-alt-m", "height-above-launch-m", "yaw-rate-abs-rad-s",
            "altitude-msl-m",
            "roll-deg",
            "roll-abs-deg",
            "pitch-deg",
            "pitch-abs-deg",
            "yaw-deg",
            "groundspeed-mps",
            "climb-rate-mps",
            "landed",
            "q1",
            "q2",
            "q3",
            "q4",
            "roll-rate-rad-s",
            "pitch-rate-rad-s",
            "yaw-rate-rad-s",
            "local-x-m",
            "local-y-m",
            "local-z-m",
            "local-vx-mps",
            "local-vy-mps",
        ]
        .iter()
        .any(|k| path == format!("test/fc/{k}"))
        || (path.starts_with("test/command/")
            && path.ends_with("/status")
            && path.split('/').count() == 4)
}
fn atom(text: &str) -> Result<Expr, String> {
    if let Ok(n) = finite(text) {
        Ok(Expr::Value(n))
    } else if writable(text.trim()) || readonly(text.trim()) {
        Ok(Expr::Property(text.trim().into()))
    } else {
        Err(format!(
            "不支持的属性：{}。模型属性脚本请使用仿真菜单的脚本入口。",
            text.trim()
        ))
    }
}
fn expression(n: &Node, depth: usize) -> Result<Expr, String> {
    if depth > 16 {
        return Err("函数嵌套过深".into());
    }
    n.attrs(&[])?;
    match n.tag.as_str() {
        "value" => {
            n.only(&[])?;
            Ok(Expr::Value(finite(&n.text)?))
        }
        "property" => {
            n.only(&[])?;
            atom(&n.text)
        }
        "function" => {
            if n.children.len() != 1 {
                return Err("function 须包含一个表达式".into());
            }
            expression(&n.children[0], depth + 1)
        }
        op @ ("sum" | "difference" | "product" | "quotient" | "min" | "max" | "abs") => {
            if n.children.is_empty()
                || n.children.len() > 32
                || (op == "abs" && n.children.len() != 1)
                || (op == "quotient" && n.children.len() != 2)
            {
                return Err("函数参数数量无效".into());
            }
            Ok(Expr::Function(
                op.into(),
                n.children
                    .iter()
                    .map(|c| expression(c, depth + 1))
                    .collect::<Result<_, _>>()?,
            ))
        }
        _ => Err(format!("不支持的 JSBSim 函数：{}", n.tag)),
    }
}
fn condition(n: &Node, depth: usize) -> Result<Condition, String> {
    if depth > 16 {
        return Err("条件嵌套过深".into());
    }
    n.attrs(&["logic"])?;
    n.only(&["condition"])?;
    let mut conditions = Vec::new();
    for line in n.text.lines().map(str::trim).filter(|s| !s.is_empty()) {
        let words: Vec<_> = line.split_whitespace().collect();
        if words.len() != 3 {
            return Err(format!("条件须为 属性 运算符 数值/属性：{line}"));
        }
        let op = match words[1] {
            ">=" | "ge" => "ge",
            "<=" | "le" => "le",
            ">" | "gt" => "gt",
            "<" | "lt" => "lt",
            "==" | "=" | "eq" => "eq",
            "!=" | "ne" => "ne",
            _ => return Err("条件运算符无效".into()),
        };
        conditions.push(Condition::Compare(
            atom(words[0])?,
            op.into(),
            atom(words[2])?,
        ));
    }
    for c in &n.children {
        conditions.push(condition(c, depth + 1)?);
    }
    if conditions.is_empty() {
        return Err("事件条件不能为空".into());
    }
    match n.attr("logic") {
        "" | "AND" => Ok(Condition::All(conditions)),
        "OR" => Ok(Condition::Any(conditions)),
        _ => Err("condition logic 须为 AND 或 OR".into()),
    }
}
fn tree(xml: &str) -> Result<Node, String> {
    if xml.len() > MAX_TEST_BYTES {
        return Err("脚本超过 4 MiB".into());
    }
    if xml.to_ascii_uppercase().contains("<!DOCTYPE")
        || xml.to_ascii_uppercase().contains("<!ENTITY")
    {
        return Err("不允许 DTD 或外部实体".into());
    }
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut stack = vec![Node::default()];
    let mut total = 0;
    loop {
        let item = reader
            .read_event()
            .map_err(|e| format!("XML 解析失败：{e}"))?;
        let empty = matches!(&item, Event::Empty(_));
        match item {
            Event::Start(e) | Event::Empty(e) => {
                total += 1;
                if total > 50000 || stack.len() > 32 {
                    return Err("XML 节点过多或嵌套过深".into());
                }
                let tag = String::from_utf8(e.name().as_ref().to_vec())
                    .map_err(|_| "XML 须使用 UTF-8")?;
                let mut attrs = BTreeMap::new();
                for a in e.attributes() {
                    let a = a.map_err(|e| e.to_string())?;
                    let key =
                        String::from_utf8(a.key.as_ref().to_vec()).map_err(|_| "属性编码无效")?;
                    if attrs
                        .insert(
                            key,
                            a.decoded_and_normalized_value(
                                quick_xml::XmlVersion::Implicit1_0,
                                reader.decoder(),
                            )
                            .map_err(|e| e.to_string())?
                            .into_owned(),
                        )
                        .is_some()
                    {
                        return Err("重复 XML 属性".into());
                    }
                }
                let n = Node {
                    tag,
                    attrs,
                    ..Node::default()
                };
                if empty {
                    stack.last_mut().unwrap().children.push(n);
                } else {
                    stack.push(n);
                }
            }
            Event::End(_) => {
                if stack.len() < 2 {
                    return Err("XML 闭合标记无效".into());
                }
                let n = stack.pop().unwrap();
                stack.last_mut().unwrap().children.push(n);
            }
            Event::Text(e) => {
                let decoded = e.decode().map_err(|e| e.to_string())?;
                stack
                    .last_mut()
                    .unwrap()
                    .text
                    .push_str(&quick_xml::escape::unescape(&decoded).map_err(|e| e.to_string())?);
            }
            Event::CData(e) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&e.decode().map_err(|e| e.to_string())?),
            Event::GeneralRef(e) => {
                let name = e.decode().map_err(|e| e.to_string())?;
                let escaped = format!("&{name};");
                stack
                    .last_mut()
                    .unwrap()
                    .text
                    .push_str(&quick_xml::escape::unescape(&escaped).map_err(|_| "不支持的实体")?);
            }
            Event::DocType(_) => return Err("不允许 DTD 或未解析实体".into()),
            Event::Eof => break,
            Event::Decl(_) | Event::Comment(_) => {}
            _ => return Err("不支持的 XML 指令".into()),
        }
    }
    if stack.len() != 1 {
        return Err("XML 未闭合".into());
    }
    let mut root = stack.pop().unwrap();
    if root.children.len() != 1 || !root.text.trim().is_empty() {
        return Err("须包含一个 runscript 根节点".into());
    }
    Ok(root.children.remove(0))
}
fn references(e: &Expr, refs: &mut BTreeSet<String>) {
    match e {
        Expr::Property(p) => {
            refs.insert(p.clone());
        }
        Expr::Function(_, args) => {
            for a in args {
                references(a, refs)
            }
        }
        _ => {}
    }
}
fn condition_references(c: &Condition, refs: &mut BTreeSet<String>) {
    match c {
        Condition::Compare(a, _, b) => {
            references(a, refs);
            references(b, refs);
        }
        Condition::All(c) | Condition::Any(c) => {
            for c in c {
                condition_references(c, refs)
            }
        }
    }
}
pub fn parse(xml: &str) -> Result<Script, String> {
    let root = tree(xml)?;
    if root.tag != "runscript" {
        return Err("根节点须为 runscript".into());
    }
    root.attrs(&["name"])?;
    root.only(&["use", "run"])?;
    for n in root.children("use") {
        n.attrs(&["aircraft", "initialize"])?;
        n.only(&[])?;
    }
    let runs: Vec<_> = root.children("run").collect();
    if runs.len() != 1 {
        return Err("须包含一个 run 节点".into());
    }
    let run = runs[0];
    run.attrs(&["start", "end", "dt"])?;
    run.only(&["property", "event"])?;
    if !run.attr("start").is_empty() && finite(run.attr("start"))? != 0. {
        return Err("测试叠加脚本的 start 须为 0".into());
    }
    let end = finite(run.attr("end"))?;
    if !(0.02..=MAX_TEST_SECONDS).contains(&end) {
        return Err("脚本 end 须为 0.02～14400 秒".into());
    }
    if !run.attr("dt").is_empty() {
        let dt = finite(run.attr("dt"))?;
        if !(0.001..=1.).contains(&dt) {
            return Err("dt 超出范围".into());
        }
    }
    let mut properties = BTreeMap::new();
    for n in run.children("property") {
        n.attrs(&["value"])?;
        n.only(&[])?;
        let path = n.text.trim().to_string();
        if !writable(&path) && !readonly(&path) {
            return Err(format!("不支持的初始属性：{path}"));
        }
        let value = finite(n.attr("value"))?;
        if readonly(&path)
            && !(value == 0. && (path == "test/runtime/ready" || path.ends_with("/status")))
        {
            return Err(format!("只读属性不能设置初值：{path}"));
        }
        if properties.insert(path, value).is_some() {
            return Err("重复属性声明".into());
        }
    }
    if properties.len() > 10000 {
        return Err("属性过多".into());
    }
    let mut events = Vec::new();
    let mut refs = BTreeSet::new();
    for n in run.children("event") {
        if events.len() >= 5000 {
            return Err("事件过多".into());
        }
        n.attrs(&["name", "persistent", "continuous"])?;
        n.only(&["condition", "set", "delay", "notify"])?;
        for key in ["persistent", "continuous"] {
            if !["", "true", "false"].contains(&n.attr(key)) {
                return Err(format!("{key} 须为 true 或 false"));
            }
        }
        let conditions: Vec<_> = n.children("condition").collect();
        if conditions.len() != 1 {
            return Err("每个事件须有一个 condition".into());
        }
        let condition = condition(conditions[0], 0)?;
        condition_references(&condition, &mut refs);
        let mut sets = Vec::new();
        for s in n.children("set") {
            s.attrs(&["name", "value", "action", "type", "tc"])?;
            s.only(&["function"])?;
            let path = s.attr("name").to_string();
            if !writable(&path) {
                return Err(format!("属性只读或不支持：{path}"));
            }
            if !properties.contains_key(&path) {
                return Err(format!("请先声明属性：{path}"));
            }
            let functions: Vec<_> = s.children("function").collect();
            let value = match (s.attrs.get("value"), functions.as_slice()) {
                (Some(v), []) => Expr::Value(finite(v)?),
                (None, [f]) => expression(f, 0)?,
                _ => return Err("set 须有一个 value 或 function".into()),
            };
            references(&value, &mut refs);
            let action = match s.attr("action").to_ascii_uppercase().as_str() {
                "" | "FG_STEP" | "STEP" => "step",
                "FG_RAMP" | "RAMP" => "ramp",
                "FG_EXP" | "EXP" => "exp",
                _ => return Err("不支持的 set action".into()),
            }
            .to_string();
            let kind = match s.attr("type").to_ascii_uppercase().as_str() {
                "" | "FG_VALUE" | "VALUE" => "value",
                "FG_DELTA" | "DELTA" => "delta",
                "FG_BOOL" | "BOOL" => "bool",
                _ => return Err("不支持的 set type".into()),
            }
            .to_string();
            let tc = if s.attr("tc").is_empty() {
                1.
            } else {
                finite(s.attr("tc"))?
            };
            if tc <= 0. {
                return Err("tc 须大于 0".into());
            }
            sets.push(Set {
                path,
                value,
                action,
                kind,
                tc,
            });
        }
        let delays: Vec<_> = n.children("delay").collect();
        if delays.len() > 1 {
            return Err("重复 delay".into());
        }
        let delay = delays
            .first()
            .map(|d| {
                d.attrs(&[])?;
                d.only(&[])?;
                finite(&d.text)
            })
            .transpose()?
            .unwrap_or(0.);
        if !(0.0..=3600.).contains(&delay) {
            return Err("delay 无效".into());
        }
        let mut description = String::new();
        let mut notify_properties = Vec::new();
        for notify in n.children("notify") {
            notify.attrs(&[])?;
            notify.only(&["property", "description"])?;
            for d in notify.children("description") {
                d.attrs(&[])?;
                d.only(&[])?;
                description = d.text.chars().take(240).collect();
            }
            for p in notify.children("property") {
                p.attrs(&["caption"])?;
                p.only(&[])?;
                let e = atom(p.text.trim())?;
                references(&e, &mut refs);
                notify_properties.push((
                    if p.attr("caption").is_empty() {
                        p.text.trim().into()
                    } else {
                        p.attr("caption").chars().take(120).collect()
                    },
                    e,
                ));
            }
        }
        events.push(ScriptEvent {
            name: n.attr("name").chars().take(240).collect(),
            condition,
            sets,
            persistent: n.attr("persistent") == "true",
            continuous: n.attr("continuous") == "true",
            delay,
            notify: n.children("notify").next().is_some(),
            description,
            notify_properties,
        });
    }
    if events.is_empty() {
        return Err("脚本没有事件".into());
    }
    for path in refs {
        if !readonly(&path) && !properties.contains_key(&path) {
            return Err(format!("引用了未声明属性：{path}"));
        }
    }
    Ok(Script {
        name: root.attr("name").into(),
        end,
        properties,
        events,
    })
}
