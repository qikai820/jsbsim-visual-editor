//! Expression XML parser/generator — handles JSBSim function expression trees.
//! Also provides shared XML parsing utilities used by xml_parser.

#![allow(dead_code)]

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── XML parsing utilities ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct XmlElement {
    pub tag: String,
    pub attrs: HashMap<String, String>,
    pub text: String,
    pub children: Vec<XmlElement>,
}

pub fn parse_xml_tree(xml: &str) -> Result<XmlElement, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut stack: Vec<XmlElement> = Vec::new();
    let mut root: Option<XmlElement> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let mut attrs = HashMap::new();
                for attr in e.attributes().flatten() {
                    let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                    let val = String::from_utf8_lossy(&attr.value).to_string();
                    attrs.insert(key, val);
                }
                stack.push(XmlElement {
                    tag,
                    attrs,
                    text: String::new(),
                    children: Vec::new(),
                });
            }
            Ok(Event::End(_)) => {
                if let Some(elem) = stack.pop() {
                    if stack.is_empty() {
                        root = Some(elem);
                    } else {
                        stack.last_mut().unwrap().children.push(elem);
                    }
                }
            }
            Ok(Event::Text(ref e)) => {
                if let Some(top) = stack.last_mut() {
                    let text = std::str::from_utf8(e).unwrap_or_default();
                    top.text.push_str(text);
                }
            }
            Ok(Event::CData(ref e)) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&String::from_utf8_lossy(e));
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let mut attrs = HashMap::new();
                for attr in e.attributes().flatten() {
                    let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                    let val = String::from_utf8_lossy(&attr.value).to_string();
                    attrs.insert(key, val);
                }
                let elem = XmlElement {
                    tag,
                    attrs,
                    text: String::new(),
                    children: Vec::new(),
                };
                if stack.is_empty() {
                    root = Some(elem);
                } else {
                    stack.last_mut().unwrap().children.push(elem);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {}", e)),
            _ => {}
        }
        buf.clear();
    }

    root.ok_or_else(|| "Empty XML document".to_string())
}

pub fn find_children<'a>(elem: &'a XmlElement, tag: &str) -> Vec<&'a XmlElement> {
    elem.children.iter().filter(|c| c.tag == tag).collect()
}

pub fn find_child<'a>(elem: &'a XmlElement, tag: &str) -> Option<&'a XmlElement> {
    elem.children.iter().find(|c| c.tag == tag)
}

pub fn get_attr<'a>(elem: &'a XmlElement, key: &str) -> Option<&'a str> {
    elem.attrs.get(key).map(|s| s.as_str())
}

pub fn get_text(elem: &XmlElement) -> String {
    elem.text.trim().to_string()
}

pub fn parse_f64(text: &str) -> Option<f64> {
    text.trim().parse().ok()
}

// ── Expression tree types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ExprNode {
    #[serde(rename = "value")]
    Value { value: f64 },
    #[serde(rename = "property")]
    Property { name: String },
    #[serde(rename = "product")]
    Product { children: Vec<ExprNode> },
    #[serde(rename = "sum")]
    Sum { children: Vec<ExprNode> },
    #[serde(rename = "difference")]
    Difference { left: Box<ExprNode>, right: Box<ExprNode> },
    #[serde(rename = "quotient")]
    Quotient { left: Box<ExprNode>, right: Box<ExprNode> },
    #[serde(rename = "pow")]
    Pow { base: Box<ExprNode>, exponent: Box<ExprNode> },
    #[serde(rename = "atan2")]
    Atan2 { y: Box<ExprNode>, x: Box<ExprNode> },
    #[serde(rename = "mod")]
    Mod { left: Box<ExprNode>, right: Box<ExprNode> },
    #[serde(rename = "abs")]
    Abs { child: Box<ExprNode> },
    #[serde(rename = "sin")]
    Sin { child: Box<ExprNode> },
    #[serde(rename = "cos")]
    Cos { child: Box<ExprNode> },
    #[serde(rename = "tan")]
    Tan { child: Box<ExprNode> },
    #[serde(rename = "asin")]
    Asin { child: Box<ExprNode> },
    #[serde(rename = "acos")]
    Acos { child: Box<ExprNode> },
    #[serde(rename = "atan")]
    Atan { child: Box<ExprNode> },
    #[serde(rename = "sqrt")]
    Sqrt { child: Box<ExprNode> },
    #[serde(rename = "exp")]
    Exp { child: Box<ExprNode> },
    #[serde(rename = "log")]
    Log { child: Box<ExprNode> },
    #[serde(rename = "fraction")]
    Fraction { child: Box<ExprNode> },
    #[serde(rename = "integer")]
    Integer { child: Box<ExprNode> },
    #[serde(rename = "toradians")]
    ToRadians { child: Box<ExprNode> },
    #[serde(rename = "todegrees")]
    ToDegrees { child: Box<ExprNode> },
    #[serde(rename = "not")]
    Not { child: Box<ExprNode> },
    #[serde(rename = "min")]
    Min { children: Vec<ExprNode> },
    #[serde(rename = "max")]
    Max { children: Vec<ExprNode> },
    #[serde(rename = "avg")]
    Avg { children: Vec<ExprNode> },
    #[serde(rename = "and")]
    And { children: Vec<ExprNode> },
    #[serde(rename = "or")]
    Or { children: Vec<ExprNode> },
    #[serde(rename = "roundmultiple")]
    RoundMultiple { children: Vec<ExprNode> },
    #[serde(rename = "gt")]
    Gt { left: Box<ExprNode>, right: Box<ExprNode> },
    #[serde(rename = "lt")]
    Lt { left: Box<ExprNode>, right: Box<ExprNode> },
    #[serde(rename = "ge")]
    Ge { left: Box<ExprNode>, right: Box<ExprNode> },
    #[serde(rename = "le")]
    Le { left: Box<ExprNode>, right: Box<ExprNode> },
    #[serde(rename = "eq")]
    Eq { left: Box<ExprNode>, right: Box<ExprNode> },
    #[serde(rename = "nq")]
    Nq { left: Box<ExprNode>, right: Box<ExprNode> },
    #[serde(rename = "ifthen")]
    IfThen {
        cond: Box<ExprNode>,
        then: Box<ExprNode>,
        #[serde(rename = "else")]
        else_: Box<ExprNode>,
    },
    #[serde(rename = "switch")]
    Switch {
        index: Box<ExprNode>,
        cases: Vec<ExprNode>,
        default: Box<ExprNode>,
    },
    #[serde(rename = "table")]
    Table {
        #[serde(rename = "tableType")]
        table_type: String,
        var1: String,
        var2: String,
        var3: String,
        data: Vec<Vec<f64>>,
        breakpoints1: Vec<f64>,
        breakpoints2: Vec<f64>,
        breakpoints3: Vec<f64>,
    },
    #[serde(rename = "pi")]
    Pi,
    #[serde(rename = "random")]
    Random,
    #[serde(rename = "urandom")]
    URandom,
}

// ── Expression parsing (XML → ExprNode) ────────────────────────────────────

fn default_value() -> ExprNode {
    ExprNode::Value { value: 0.0 }
}

/// Parse a <function> element into an ExprNode tree.
pub fn xml_to_expr(func_obj: &XmlElement) -> ExprNode {
    if func_obj.children.is_empty() {
        let text = get_text(func_obj);
        if let Some(v) = parse_f64(&text) {
            return ExprNode::Value { value: v };
        }
        return default_value();
    }

    // Check for direct <value> (and no operation children)
    if find_child(func_obj, "value").is_some()
        && find_child(func_obj, "product").is_none()
        && find_child(func_obj, "sum").is_none()
        && find_child(func_obj, "table").is_none()
        && find_child(func_obj, "difference").is_none()
        && find_child(func_obj, "quotient").is_none()
    {
        if let Some(val_elem) = find_child(func_obj, "value") {
            let text = get_text(val_elem);
            return ExprNode::Value {
                value: parse_f64(&text).unwrap_or(0.0),
            };
        }
    }

    parse_func_body(func_obj)
}

fn parse_func_body(obj: &XmlElement) -> ExprNode {
    // Binary operations
    if let Some(elem) = find_child(obj, "product") {
        return ExprNode::Product {
            children: elem.children.iter().map(|c| parse_expr_child(c)).collect(),
        };
    }
    if let Some(elem) = find_child(obj, "sum") {
        return ExprNode::Sum {
            children: elem.children.iter().map(|c| parse_expr_child(c)).collect(),
        };
    }
    if let Some(elem) = find_child(obj, "difference") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::Difference {
            left: Box::new(children.first().cloned().unwrap_or_else(default_value)),
            right: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
        };
    }
    if let Some(elem) = find_child(obj, "quotient") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::Quotient {
            left: Box::new(children.first().cloned().unwrap_or_else(default_value)),
            right: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
        };
    }
    if let Some(elem) = find_child(obj, "pow") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::Pow {
            base: Box::new(children.first().cloned().unwrap_or_else(default_value)),
            exponent: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
        };
    }
    if let Some(elem) = find_child(obj, "atan2") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::Atan2 {
            y: Box::new(children.first().cloned().unwrap_or_else(default_value)),
            x: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
        };
    }
    if let Some(elem) = find_child(obj, "mod") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::Mod {
            left: Box::new(children.first().cloned().unwrap_or_else(default_value)),
            right: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
        };
    }

    // Unary functions
    let unary_ops = [
        "abs", "sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "exp", "log",
        "fraction", "integer", "toradians", "todegrees", "not",
    ];
    for op in &unary_ops {
        if let Some(elem) = find_child(obj, op) {
            let child = elem
                .children
                .first()
                .map(|c| parse_expr_child(c))
                .unwrap_or_else(default_value);
            return match *op {
                "abs" => ExprNode::Abs { child: Box::new(child) },
                "sin" => ExprNode::Sin { child: Box::new(child) },
                "cos" => ExprNode::Cos { child: Box::new(child) },
                "tan" => ExprNode::Tan { child: Box::new(child) },
                "asin" => ExprNode::Asin { child: Box::new(child) },
                "acos" => ExprNode::Acos { child: Box::new(child) },
                "atan" => ExprNode::Atan { child: Box::new(child) },
                "sqrt" => ExprNode::Sqrt { child: Box::new(child) },
                "exp" => ExprNode::Exp { child: Box::new(child) },
                "log" => ExprNode::Log { child: Box::new(child) },
                "fraction" => ExprNode::Fraction { child: Box::new(child) },
                "integer" => ExprNode::Integer { child: Box::new(child) },
                "toradians" => ExprNode::ToRadians { child: Box::new(child) },
                "todegrees" => ExprNode::ToDegrees { child: Box::new(child) },
                "not" => ExprNode::Not { child: Box::new(child) },
                _ => unreachable!(),
            };
        }
    }

    // Multi-arg functions
    let multi_ops = ["min", "max", "avg", "and", "or", "roundmultiple"];
    for op in &multi_ops {
        if let Some(elem) = find_child(obj, op) {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            return match *op {
                "min" => ExprNode::Min { children },
                "max" => ExprNode::Max { children },
                "avg" => ExprNode::Avg { children },
                "and" => ExprNode::And { children },
                "or" => ExprNode::Or { children },
                "roundmultiple" => ExprNode::RoundMultiple { children },
                _ => unreachable!(),
            };
        }
    }

    // Comparisons
    let comp_ops = ["gt", "lt", "ge", "le", "eq", "nq"];
    for op in &comp_ops {
        if let Some(elem) = find_child(obj, op) {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            let left = children.first().cloned().unwrap_or_else(default_value);
            let right = children.get(1).cloned().unwrap_or_else(default_value);
            return match *op {
                "gt" => ExprNode::Gt { left: Box::new(left), right: Box::new(right) },
                "lt" => ExprNode::Lt { left: Box::new(left), right: Box::new(right) },
                "ge" => ExprNode::Ge { left: Box::new(left), right: Box::new(right) },
                "le" => ExprNode::Le { left: Box::new(left), right: Box::new(right) },
                "eq" => ExprNode::Eq { left: Box::new(left), right: Box::new(right) },
                "nq" => ExprNode::Nq { left: Box::new(left), right: Box::new(right) },
                _ => unreachable!(),
            };
        }
    }

    // ifthen
    if let Some(elem) = find_child(obj, "ifthen") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::IfThen {
            cond: Box::new(children.first().cloned().unwrap_or_else(default_value)),
            then: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
            else_: Box::new(children.get(2).cloned().unwrap_or_else(default_value)),
        };
    }

    // switch
    if let Some(elem) = find_child(obj, "switch") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        if children.len() >= 2 {
            let last = children.len() - 1;
            return ExprNode::Switch {
                index: Box::new(children[0].clone()),
                cases: children[1..last].to_vec(),
                default: Box::new(children[last].clone()),
            };
        }
    }

    // table
    if let Some(elem) = find_child(obj, "table") {
        return parse_table(elem);
    }

    // property (standalone)
    if let Some(elem) = find_child(obj, "property") {
        return ExprNode::Property { name: get_text(elem) };
    }

    // pi, random, urandom
    if find_child(obj, "pi").is_some() {
        return ExprNode::Pi;
    }
    if find_child(obj, "random").is_some() {
        return ExprNode::Random;
    }
    if find_child(obj, "urandom").is_some() {
        return ExprNode::URandom;
    }

    // value (standalone)
    if let Some(elem) = find_child(obj, "value") {
        let text = get_text(elem);
        return ExprNode::Value {
            value: parse_f64(&text).unwrap_or(0.0),
        };
    }

    // v (shorthand value)
    if let Some(elem) = find_child(obj, "v") {
        let text = get_text(elem);
        return ExprNode::Value {
            value: parse_f64(&text).unwrap_or(0.0),
        };
    }

    // p (shorthand property)
    if let Some(elem) = find_child(obj, "p") {
        return ExprNode::Property { name: get_text(elem) };
    }

    // Fallback: try text as number
    let text = get_text(obj);
    if let Some(v) = parse_f64(&text) {
        return ExprNode::Value { value: v };
    }

    default_value()
}

/// Parse an expression child element (recursive).
fn parse_expr_child(elem: &XmlElement) -> ExprNode {
    match elem.tag.as_str() {
        "property" => ExprNode::Property { name: get_text(elem) },
        "value" | "v" => {
            let text = get_text(elem);
            ExprNode::Value { value: parse_f64(&text).unwrap_or(0.0) }
        }
        "p" => ExprNode::Property { name: get_text(elem) },
        "pi" => ExprNode::Pi,
        "random" => ExprNode::Random,
        "urandom" => ExprNode::URandom,
        "product" => ExprNode::Product {
            children: elem.children.iter().map(|c| parse_expr_child(c)).collect(),
        },
        "sum" => ExprNode::Sum {
            children: elem.children.iter().map(|c| parse_expr_child(c)).collect(),
        },
        "difference" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            ExprNode::Difference {
                left: Box::new(children.first().cloned().unwrap_or_else(default_value)),
                right: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
            }
        }
        "quotient" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            ExprNode::Quotient {
                left: Box::new(children.first().cloned().unwrap_or_else(default_value)),
                right: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
            }
        }
        "pow" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            ExprNode::Pow {
                base: Box::new(children.first().cloned().unwrap_or_else(default_value)),
                exponent: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
            }
        }
        "atan2" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            ExprNode::Atan2 {
                y: Box::new(children.first().cloned().unwrap_or_else(default_value)),
                x: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
            }
        }
        "mod" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            ExprNode::Mod {
                left: Box::new(children.first().cloned().unwrap_or_else(default_value)),
                right: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
            }
        }
        "abs" | "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "sqrt" | "exp" | "log"
        | "fraction" | "integer" | "toradians" | "todegrees" | "not" => {
            let child = elem
                .children
                .first()
                .map(|c| parse_expr_child(c))
                .unwrap_or_else(default_value);
            match elem.tag.as_str() {
                "abs" => ExprNode::Abs { child: Box::new(child) },
                "sin" => ExprNode::Sin { child: Box::new(child) },
                "cos" => ExprNode::Cos { child: Box::new(child) },
                "tan" => ExprNode::Tan { child: Box::new(child) },
                "asin" => ExprNode::Asin { child: Box::new(child) },
                "acos" => ExprNode::Acos { child: Box::new(child) },
                "atan" => ExprNode::Atan { child: Box::new(child) },
                "sqrt" => ExprNode::Sqrt { child: Box::new(child) },
                "exp" => ExprNode::Exp { child: Box::new(child) },
                "log" => ExprNode::Log { child: Box::new(child) },
                "fraction" => ExprNode::Fraction { child: Box::new(child) },
                "integer" => ExprNode::Integer { child: Box::new(child) },
                "toradians" => ExprNode::ToRadians { child: Box::new(child) },
                "todegrees" => ExprNode::ToDegrees { child: Box::new(child) },
                "not" => ExprNode::Not { child: Box::new(child) },
                _ => unreachable!(),
            }
        }
        "min" | "max" | "avg" | "and" | "or" | "roundmultiple" => {
            let children = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            match elem.tag.as_str() {
                "min" => ExprNode::Min { children },
                "max" => ExprNode::Max { children },
                "avg" => ExprNode::Avg { children },
                "and" => ExprNode::And { children },
                "or" => ExprNode::Or { children },
                "roundmultiple" => ExprNode::RoundMultiple { children },
                _ => unreachable!(),
            }
        }
        "gt" | "lt" | "ge" | "le" | "eq" | "nq" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            let left = children.first().cloned().unwrap_or_else(default_value);
            let right = children.get(1).cloned().unwrap_or_else(default_value);
            match elem.tag.as_str() {
                "gt" => ExprNode::Gt { left: Box::new(left), right: Box::new(right) },
                "lt" => ExprNode::Lt { left: Box::new(left), right: Box::new(right) },
                "ge" => ExprNode::Ge { left: Box::new(left), right: Box::new(right) },
                "le" => ExprNode::Le { left: Box::new(left), right: Box::new(right) },
                "eq" => ExprNode::Eq { left: Box::new(left), right: Box::new(right) },
                "nq" => ExprNode::Nq { left: Box::new(left), right: Box::new(right) },
                _ => unreachable!(),
            }
        }
        "ifthen" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            ExprNode::IfThen {
                cond: Box::new(children.first().cloned().unwrap_or_else(default_value)),
                then: Box::new(children.get(1).cloned().unwrap_or_else(default_value)),
                else_: Box::new(children.get(2).cloned().unwrap_or_else(default_value)),
            }
        }
        "switch" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            if children.len() >= 2 {
                let last = children.len() - 1;
                ExprNode::Switch {
                    index: Box::new(children[0].clone()),
                    cases: children[1..last].to_vec(),
                    default: Box::new(children[last].clone()),
                }
            } else {
                default_value()
            }
        }
        "table" => parse_table(elem),
        _ => {
            // Check if this element contains operation children
            let has_expr_children = elem.children.iter().any(|c| is_expr_element(c));
            if has_expr_children {
                // This is a wrapper, parse the first operation child
                let op_child = elem.children.iter().find(|c| is_expr_element(c)).unwrap();
                parse_expr_child(op_child)
            } else {
                // Try as property or value
                let text = get_text(elem);
                if let Some(v) = parse_f64(&text) {
                    ExprNode::Value { value: v }
                } else if !text.is_empty() {
                    ExprNode::Property { name: text }
                } else {
                    default_value()
                }
            }
        }
    }
}

fn is_expr_element(elem: &XmlElement) -> bool {
    matches!(
        elem.tag.as_str(),
        "property"
            | "value"
            | "v"
            | "p"
            | "pi"
            | "random"
            | "urandom"
            | "product"
            | "sum"
            | "difference"
            | "quotient"
            | "pow"
            | "atan2"
            | "mod"
            | "abs"
            | "sin"
            | "cos"
            | "tan"
            | "asin"
            | "acos"
            | "atan"
            | "sqrt"
            | "exp"
            | "log"
            | "fraction"
            | "integer"
            | "toradians"
            | "todegrees"
            | "not"
            | "min"
            | "max"
            | "avg"
            | "and"
            | "or"
            | "roundmultiple"
            | "gt"
            | "lt"
            | "ge"
            | "le"
            | "eq"
            | "nq"
            | "ifthen"
            | "switch"
            | "table"
    )
}

// ── Table parsing ──────────────────────────────────────────────────────────

fn parse_table_text(text: &str) -> Vec<Vec<f64>> {
    text.trim()
        .split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| {
            l.split_whitespace()
                .filter_map(|v| v.parse::<f64>().ok())
                .collect()
        })
        .filter(|r: &Vec<f64>| !r.is_empty())
        .collect()
}

fn parse_table_1d(rows: &[Vec<f64>], var1: &str) -> ExprNode {
    let mut breakpoints1 = Vec::new();
    let mut data = Vec::new();
    for row in rows {
        if row.len() >= 2 {
            breakpoints1.push(row[0]);
            data.push(vec![row[1]]);
        } else if row.len() == 1 {
            breakpoints1.push(0.0);
            data.push(vec![row[0]]);
        }
    }
    if breakpoints1.is_empty() {
        breakpoints1.push(0.0);
        data.push(vec![0.0]);
    }
    ExprNode::Table {
        table_type: "1D".to_string(),
        var1: var1.to_string(),
        var2: String::new(),
        var3: String::new(),
        data,
        breakpoints1,
        breakpoints2: vec![],
        breakpoints3: vec![],
    }
}

fn parse_table_2d(rows: &[Vec<f64>], var1: &str, var2: &str) -> ExprNode {
    if rows.is_empty() {
        return ExprNode::Table {
            table_type: "2D".to_string(),
            var1: var1.to_string(),
            var2: var2.to_string(),
            var3: String::new(),
            data: vec![vec![0.0]],
            breakpoints1: vec![0.0],
            breakpoints2: vec![],
            breakpoints3: vec![],
        };
    }
    let breakpoints2 = rows[0][1..].to_vec();
    let mut breakpoints1 = Vec::new();
    let mut data = Vec::new();
    for row in &rows[1..] {
        if !row.is_empty() {
            breakpoints1.push(row[0]);
            data.push(row[1..].to_vec());
        }
    }
    ExprNode::Table {
        table_type: "2D".to_string(),
        var1: var1.to_string(),
        var2: var2.to_string(),
        var3: String::new(),
        data,
        breakpoints1,
        breakpoints2,
        breakpoints3: vec![],
    }
}

fn parse_table_3d(table_data_elems: &[&XmlElement], var1: &str, var2: &str, var3: &str) -> ExprNode {
    let mut breakpoints3 = Vec::new();
    let mut breakpoints1 = Vec::new();
    let mut breakpoints2 = Vec::new();
    let mut all_data = Vec::new();

    for td_elem in table_data_elems {
        let bp = get_attr(td_elem, "breakPoint")
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        breakpoints3.push(bp);

        let text = get_text(td_elem);
        let rows = parse_table_text(&text);

        if !rows.is_empty() {
            if breakpoints2.is_empty() {
                breakpoints2 = rows[0][1..].to_vec();
            }
            for row in &rows[1..] {
                if !row.is_empty() {
                    if breakpoints1.len() < all_data.len() / breakpoints2.len().max(1) + 1 {
                        breakpoints1.push(row[0]);
                    }
                    all_data.push(row[1..].to_vec());
                }
            }
        }
    }

    if breakpoints1.is_empty() {
        breakpoints1.push(0.0);
    }
    if breakpoints2.is_empty() {
        breakpoints2.push(0.0);
    }
    if all_data.is_empty() {
        all_data.push(vec![0.0]);
    }

    ExprNode::Table {
        table_type: "3D".to_string(),
        var1: var1.to_string(),
        var2: var2.to_string(),
        var3: var3.to_string(),
        data: all_data,
        breakpoints1,
        breakpoints2,
        breakpoints3,
    }
}

/// Parse a <table> element into an ExprNode::Table.
pub fn parse_table(table_obj: &XmlElement) -> ExprNode {
    let mut var1 = String::new();
    let mut var2 = String::new();
    let mut var3 = String::new();
    let mut table_type = "1D".to_string();

    let ind_vars = find_children(table_obj, "independentVar");

    for iv in &ind_vars {
        let text = get_text(iv);
        let lookup = get_attr(iv, "lookup").unwrap_or("");
        let t_type = get_attr(iv, "tableType").unwrap_or("");

        if t_type == "2D" || t_type == "3D" {
            table_type = t_type.to_string();
        }

        if lookup.is_empty() || lookup == "row" {
            var1 = text;
        } else if lookup == "column" {
            var2 = text;
            if table_type == "1D" {
                table_type = "2D".to_string();
            }
        } else if lookup == "z" {
            var3 = text;
            table_type = "3D".to_string();
        }
    }

    if ind_vars.len() >= 3 {
        table_type = "3D".to_string();
    } else if ind_vars.len() == 2 {
        table_type = "2D".to_string();
    }

    let table_data_elems = find_children(table_obj, "tableData");
    let has_breakpoints = table_data_elems
        .iter()
        .any(|td| td.attrs.contains_key("breakPoint"));

    if has_breakpoints {
        return parse_table_3d(&table_data_elems, &var1, &var2, &var3);
    }

    if let Some(td) = table_data_elems.first() {
        let text = get_text(td);
        let rows = parse_table_text(&text);

        if table_type == "2D" && rows.len() > 1 && !rows.is_empty() && rows[0].len() > 1 {
            return parse_table_2d(&rows, &var1, &var2);
        } else {
            return parse_table_1d(&rows, &var1);
        }
    }

    ExprNode::Table {
        table_type,
        var1,
        var2,
        var3,
        data: vec![vec![0.0]],
        breakpoints1: vec![0.0],
        breakpoints2: vec![],
        breakpoints3: vec![],
    }
}

/// Parse table data text into rows of numbers.
pub fn parse_table_data(text: &str) -> Vec<Vec<f64>> {
    parse_table_text(text)
}

// ── Expression → XML ────────────────────────────────────────────────────────

fn indent(level: usize) -> String {
    "    ".repeat(level)
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Convert an ExprNode tree to XML string at the given indentation level.
pub fn expr_to_xml(expr: &ExprNode, level: usize) -> String {
    let ind = indent(level);

    match expr {
        ExprNode::Value { value } => format!("{}<value>{}</value>", ind, value),
        ExprNode::Property { name } => format!("{}<property>{}</property>", ind, escape_xml(name)),
        ExprNode::Table { .. } => table_to_xml(expr, level),
        ExprNode::Product { children } => multi_arg_to_xml("product", children, level),
        ExprNode::Sum { children } => multi_arg_to_xml("sum", children, level),
        ExprNode::Min { children } => multi_arg_to_xml("min", children, level),
        ExprNode::Max { children } => multi_arg_to_xml("max", children, level),
        ExprNode::Avg { children } => multi_arg_to_xml("avg", children, level),
        ExprNode::And { children } => multi_arg_to_xml("and", children, level),
        ExprNode::Or { children } => multi_arg_to_xml("or", children, level),
        ExprNode::RoundMultiple { children } => multi_arg_to_xml("roundmultiple", children, level),
        ExprNode::Difference { left, right } => two_arg_to_xml("difference", left, right, level),
        ExprNode::Quotient { left, right } => two_arg_to_xml("quotient", left, right, level),
        ExprNode::Pow { base, exponent } => two_arg_to_xml("pow", base, exponent, level),
        ExprNode::Atan2 { y, x } => two_arg_to_xml("atan2", y, x, level),
        ExprNode::Mod { left, right } => two_arg_to_xml("mod", left, right, level),
        ExprNode::Gt { left, right } => two_arg_to_xml("gt", left, right, level),
        ExprNode::Lt { left, right } => two_arg_to_xml("lt", left, right, level),
        ExprNode::Ge { left, right } => two_arg_to_xml("ge", left, right, level),
        ExprNode::Le { left, right } => two_arg_to_xml("le", left, right, level),
        ExprNode::Eq { left, right } => two_arg_to_xml("eq", left, right, level),
        ExprNode::Nq { left, right } => two_arg_to_xml("nq", left, right, level),
        ExprNode::Abs { child } => unary_to_xml("abs", child, level),
        ExprNode::Sin { child } => unary_to_xml("sin", child, level),
        ExprNode::Cos { child } => unary_to_xml("cos", child, level),
        ExprNode::Tan { child } => unary_to_xml("tan", child, level),
        ExprNode::Asin { child } => unary_to_xml("asin", child, level),
        ExprNode::Acos { child } => unary_to_xml("acos", child, level),
        ExprNode::Atan { child } => unary_to_xml("atan", child, level),
        ExprNode::Sqrt { child } => unary_to_xml("sqrt", child, level),
        ExprNode::Exp { child } => unary_to_xml("exp", child, level),
        ExprNode::Log { child } => unary_to_xml("log", child, level),
        ExprNode::Fraction { child } => unary_to_xml("fraction", child, level),
        ExprNode::Integer { child } => unary_to_xml("integer", child, level),
        ExprNode::ToRadians { child } => unary_to_xml("toradians", child, level),
        ExprNode::ToDegrees { child } => unary_to_xml("todegrees", child, level),
        ExprNode::Not { child } => unary_to_xml("not", child, level),
        ExprNode::Pi => format!("{}<pi/>", ind),
        ExprNode::Random => format!("{}<random/>", ind),
        ExprNode::URandom => format!("{}<urandom/>", ind),
        ExprNode::IfThen { cond, then, else_ } => {
            format!(
                "{}<ifthen>\n{}\n{}\n{}\n{}</ifthen>",
                ind,
                expr_to_xml(cond, level + 1),
                expr_to_xml(then, level + 1),
                expr_to_xml(else_, level + 1),
                ind
            )
        }
        ExprNode::Switch { index, cases, default } => {
            let mut parts = vec![expr_to_xml(index, level + 1)];
            for c in cases {
                parts.push(expr_to_xml(c, level + 1));
            }
            parts.push(expr_to_xml(default, level + 1));
            format!("{}<switch>\n{}\n{}</switch>", ind, parts.join("\n"), ind)
        }
    }
}

fn multi_arg_to_xml(tag: &str, children: &[ExprNode], level: usize) -> String {
    let ind = indent(level);
    if children.is_empty() {
        return format!("{}<{}{}/>", ind, tag, "");
    }
    let child_xml: Vec<String> = children.iter().map(|c| expr_to_xml(c, level + 1)).collect();
    format!("{}<{}>\n{}\n{}</{}>", ind, tag, child_xml.join("\n"), ind, tag)
}

fn two_arg_to_xml(tag: &str, left: &ExprNode, right: &ExprNode, level: usize) -> String {
    let ind = indent(level);
    format!(
        "{}<{}>\n{}\n{}\n{}</{}>",
        ind,
        tag,
        expr_to_xml(left, level + 1),
        expr_to_xml(right, level + 1),
        ind,
        tag
    )
}

fn unary_to_xml(tag: &str, child: &ExprNode, level: usize) -> String {
    let ind = indent(level);
    format!(
        "{}<{}>\n{}\n{}</{}>",
        ind,
        tag,
        expr_to_xml(child, level + 1),
        ind,
        tag
    )
}

fn table_to_xml(expr: &ExprNode, level: usize) -> String {
    let ind = indent(level);

    if let ExprNode::Table {
        table_type,
        var1,
        var2,
        var3: _,
        data,
        breakpoints1,
        breakpoints2,
        breakpoints3,
    } = expr
    {
        let mut lines = vec![format!("{}<table>", ind)];

        match table_type.as_str() {
            "2D" => {
                lines.push(format!(
                    "{}<independentVar lookup=\"row\">{}</independentVar>",
                    indent(level + 1),
                    escape_xml(var1)
                ));
                lines.push(format!(
                    "{}<independentVar lookup=\"column\">{}</independentVar>",
                    indent(level + 1),
                    escape_xml(var2)
                ));
                lines.push(table_data_to_xml_2d(breakpoints1, breakpoints2, data, level + 1));
            }
            "3D" => {
                lines.push(format!(
                    "{}<independentVar lookup=\"row\">{}</independentVar>",
                    indent(level + 1),
                    escape_xml(var1)
                ));
                lines.push(format!(
                    "{}<independentVar lookup=\"column\">{}</independentVar>",
                    indent(level + 1),
                    escape_xml(var2)
                ));
                lines.push(table_data_to_xml_3d(
                    breakpoints1,
                    breakpoints2,
                    breakpoints3,
                    data,
                    level + 1,
                ));
            }
            _ => {
                // 1D
                lines.push(format!(
                    "{}<independentVar>{}</independentVar>",
                    indent(level + 1),
                    escape_xml(var1)
                ));
                lines.push(table_data_to_xml_1d(breakpoints1, data, level + 1));
            }
        }

        lines.push(format!("{}</table>", ind));
        lines.join("\n")
    } else {
        format!("{}<table/>", ind)
    }
}

fn table_data_to_xml_1d(bp: &[f64], data: &[Vec<f64>], level: usize) -> String {
    let ind = indent(level);
    let mut lines = vec![format!("{}<tableData>", ind)];
    for i in 0..data.len() {
        let b = bp.get(i).copied().unwrap_or(0.0);
        let v = data[i].first().copied().unwrap_or(0.0);
        lines.push(format!("{}    {}\t{}", ind, b, v));
    }
    lines.push(format!("{}</tableData>", ind));
    lines.join("\n")
}

fn table_data_to_xml_2d(bp1: &[f64], bp2: &[f64], data: &[Vec<f64>], level: usize) -> String {
    let ind = indent(level);
    let mut lines = vec![format!("{}<tableData>", ind)];

    // Header row
    let mut header = vec![String::new()];
    for b in bp2 {
        header.push(format!("{}", b));
    }
    lines.push(format!("{}    {}", ind, header.join("\t")));

    // Data rows
    for r in 0..data.len() {
        let mut row = vec![format!("{}", bp1.get(r).copied().unwrap_or(0.0))];
        for c in 0..bp2.len() {
            row.push(format!("{}", data[r].get(c).copied().unwrap_or(0.0)));
        }
        lines.push(format!("{}    {}", ind, row.join("\t")));
    }

    lines.push(format!("{}</tableData>", ind));
    lines.join("\n")
}

fn table_data_to_xml_3d(
    bp1: &[f64],
    bp2: &[f64],
    bp3: &[f64],
    data: &[Vec<f64>],
    level: usize,
) -> String {
    let ind = indent(level);
    let mut lines = Vec::new();
    let rows_per_table = bp1.len().max(1);
    let cols = bp2.len().max(1);

    for t in 0..bp3.len() {
        lines.push(format!("{}<tableData breakPoint=\"{}\">", ind, bp3[t]));
        let mut header = vec![String::new()];
        for b in bp2 {
            header.push(format!("{}", b));
        }
        lines.push(format!("{}    {}", ind, header.join("\t")));

        let start_row = t * rows_per_table;
        for r in 0..rows_per_table {
            let idx = start_row + r;
            let mut row = vec![format!("{}", bp1.get(r).copied().unwrap_or(0.0))];
            for c in 0..cols {
                row.push(format!(
                    "{}",
                    data.get(idx).and_then(|d| d.get(c)).copied().unwrap_or(0.0)
                ));
            }
            lines.push(format!("{}    {}", ind, row.join("\t")));
        }
        lines.push(format!("{}</tableData>", ind));
    }
    lines.join("\n")
}

// ── Sub-file parsing ───────────────────────────────────────────────────────

fn extract_value_with_unit(elem: &XmlElement) -> Option<serde_json::Value> {
    let val = if let Some(v) = get_attr(elem, "value") {
        v.parse::<f64>().ok()
    } else {
        let text = get_text(elem);
        if text.is_empty() {
            None
        } else {
            text.parse::<f64>().ok()
        }
    };

    let unit = get_attr(elem, "unit").map(|s| s.to_string());

    val.map(|v| {
        if let Some(u) = unit {
            serde_json::json!({ "value": v, "unit": u })
        } else {
            serde_json::json!({ "value": v })
        }
    })
}

fn extract_location(obj: &XmlElement) -> Option<serde_json::Value> {
    // Attribute format
    let x = get_attr(obj, "x").and_then(|s| s.parse::<f64>().ok());
    let y = get_attr(obj, "y").and_then(|s| s.parse::<f64>().ok());
    let z = get_attr(obj, "z").and_then(|s| s.parse::<f64>().ok());
    let unit = get_attr(obj, "unit").unwrap_or("IN");

    // Child element format
    let cx = find_child(obj, "x").and_then(|e| get_text(e).parse::<f64>().ok());
    let cy = find_child(obj, "y").and_then(|e| get_text(e).parse::<f64>().ok());
    let cz = find_child(obj, "z").and_then(|e| get_text(e).parse::<f64>().ok());

    let fx = x.or(cx);
    let fy = y.or(cy);
    let fz = z.or(cz);

    if fx.is_some() || fy.is_some() || fz.is_some() {
        Some(serde_json::json!({
            "x": fx,
            "y": fy,
            "z": fz,
            "unit": unit
        }))
    } else {
        None
    }
}

/// Extract tables from an XML element, returning them as JSON values.
pub fn extract_tables(el: &XmlElement) -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
    let mut tables_expr = Vec::new();
    let mut tables_raw = Vec::new();

    for child in &el.children {
        if child.tag == "table" {
            let tbl_name = get_attr(child, "name").unwrap_or("").to_string();

            // ExprNode form
            let expr = parse_table(child);
            let mut expr_val = serde_json::to_value(&expr).unwrap_or(serde_json::json!(null));
            if !tbl_name.is_empty() {
                if let Some(obj) = expr_val.as_object_mut() {
                    obj.insert("name".to_string(), serde_json::json!(tbl_name));
                }
            }
            tables_expr.push(serde_json::json!({
                "name": tbl_name,
                "expression": expr_val
            }));

            // Legacy raw form
            let tbl_type = get_attr(child, "type").unwrap_or("internal").to_string();
            let td_elem = find_child(child, "tableData");
            let table_data = td_elem
                .map(|td| parse_table_text(&get_text(td)))
                .unwrap_or_default();
            if !tbl_name.is_empty() && !table_data.is_empty() {
                tables_raw.push(serde_json::json!({
                    "name": tbl_name,
                    "type": tbl_type,
                    "data": table_data
                }));
            }
        } else {
            // Recurse into child elements
            let (sub_expr, sub_raw) = extract_tables(child);
            tables_expr.extend(sub_expr);
            tables_raw.extend(sub_raw);
        }
    }

    (tables_expr, tables_raw)
}

/// Parse a sub-file XML (engine, thruster, system) into JSON.
pub fn parse_subfile_xml(xml: &str, file_type: &str) -> Result<serde_json::Value, String> {
    let root = parse_xml_tree(xml)?;

    // Piston engine
    if file_type == "piston_engine" || (file_type.is_empty() && root.tag == "piston_engine") {
        let mut result = serde_json::json!({
            "type": "piston_engine",
            "name": get_attr(&root, "name").unwrap_or(""),
            "params": {}
        });
        let params = result.get_mut("params").unwrap();
        for field in &["maxhp", "displacement", "bsfc", "minmp", "maxmp"] {
            if let Some(elem) = find_child(&root, field) {
                if let Some(v) = extract_value_with_unit(elem) {
                    params[field] = v;
                }
            }
        }
        for field in &["cycles", "idlerpm", "maxrpm"] {
            if let Some(elem) = find_child(&root, field) {
                let text = get_text(elem);
                if let Some(v) = text.parse::<f64>().ok() {
                    params[field] = serde_json::json!(v);
                }
            }
        }
        return Ok(result);
    }

    // Turbine engine
    if file_type == "turbine_engine" || (file_type.is_empty() && root.tag == "turbine_engine") {
        let mut result = serde_json::json!({
            "type": "turbine_engine",
            "name": get_attr(&root, "name").unwrap_or(""),
            "params": {}
        });
        let params = result.get_mut("params").unwrap();
        if let Some(elem) = find_child(&root, "maxthrust") {
            if let Some(v) = extract_value_with_unit(elem) {
                params["maxthrust"] = v;
            }
        }
        for field in &["idlen1", "maxn1", "idlen2", "maxn2"] {
            if let Some(elem) = find_child(&root, field) {
                let text = get_text(elem);
                if let Some(v) = text.parse::<f64>().ok() {
                    params[field] = serde_json::json!(v);
                }
            }
        }
        return Ok(result);
    }

    // Turboprop engine
    if file_type == "turboprop_engine" || (file_type.is_empty() && root.tag == "turboprop_engine") {
        let mut result = serde_json::json!({
            "type": "turboprop_engine",
            "name": get_attr(&root, "name").unwrap_or(""),
            "params": {}
        });
        let params = result.get_mut("params").unwrap();
        for field in &["maxpower", "idlen1", "maxn1", "idlen2", "maxn2"] {
            if let Some(elem) = find_child(&root, field) {
                if let Some(v) = extract_value_with_unit(elem) {
                    params[field] = v;
                } else {
                    let text = get_text(elem);
                    if let Some(v) = text.parse::<f64>().ok() {
                        params[field] = serde_json::json!(v);
                    }
                }
            }
        }
        return Ok(result);
    }

    // Rocket engine
    if file_type == "rocket_engine" || (file_type.is_empty() && root.tag == "rocket_engine") {
        let mut result = serde_json::json!({
            "type": "rocket_engine",
            "name": get_attr(&root, "name").unwrap_or(""),
            "params": {}
        });
        let params = result.get_mut("params").unwrap();
        for field in &["maxthrust", "minthrust", "isp"] {
            if let Some(elem) = find_child(&root, field) {
                if let Some(v) = extract_value_with_unit(elem) {
                    params[field] = v;
                }
            }
        }
        return Ok(result);
    }

    // Electric engine / brushless DC motor
    if file_type == "electric_engine"
        || (file_type.is_empty() && (root.tag == "electric_engine" || root.tag == "brushless_dc_motor"))
    {
        let mut result = serde_json::json!({
            "type": root.tag.clone(),
            "name": get_attr(&root, "name").unwrap_or(""),
            "params": {}
        });
        let params = result.get_mut("params").unwrap();
        for field in &["maxpower", "maxrpm", "idle_rpm"] {
            if let Some(elem) = find_child(&root, field) {
                if let Some(v) = extract_value_with_unit(elem) {
                    params[field] = v;
                } else {
                    let text = get_text(elem);
                    if let Some(v) = text.parse::<f64>().ok() {
                        params[field] = serde_json::json!(v);
                    }
                }
            }
        }
        return Ok(result);
    }

    // Propeller thruster
    if file_type == "thruster_propeller" || (file_type.is_empty() && root.tag == "propeller") {
        let mut result = serde_json::json!({
            "type": "thruster_propeller",
            "name": get_attr(&root, "name").unwrap_or(""),
            "params": {}
        });
        let params = result.get_mut("params").unwrap();
        for field in &["diameter", "numblades", "gearratio"] {
            if let Some(elem) = find_child(&root, field) {
                if let Some(v) = extract_value_with_unit(elem) {
                    params[field] = v;
                } else {
                    let text = get_text(elem);
                    if let Some(v) = text.parse::<f64>().ok() {
                        params[field] = serde_json::json!(v);
                    }
                }
            }
        }
        let (tables_expr, tables_raw) = extract_tables(&root);
        if !tables_expr.is_empty() {
            params["tables"] = serde_json::json!(tables_expr);
        }
        if !tables_raw.is_empty() {
            params["_tables"] = serde_json::json!(tables_raw);
        }
        return Ok(result);
    }

    // Direct thruster
    if file_type == "thruster_direct" || (file_type.is_empty() && root.tag == "direct") {
        return Ok(serde_json::json!({
            "type": "thruster_direct",
            "name": get_attr(&root, "name").unwrap_or(""),
            "params": {}
        }));
    }

    // Nozzle thruster
    if file_type == "thruster_nozzle" || (file_type.is_empty() && root.tag == "nozzle") {
        let mut result = serde_json::json!({
            "type": "thruster_nozzle",
            "name": get_attr(&root, "name").unwrap_or(""),
            "params": {}
        });
        let params = result.get_mut("params").unwrap();
        for field in &["area", "pe"] {
            if let Some(elem) = find_child(&root, field) {
                if let Some(v) = extract_value_with_unit(elem) {
                    params[field] = v;
                }
            }
        }
        return Ok(result);
    }

    // System
    if file_type == "system" || (file_type.is_empty() && root.tag == "system") {
        let mut result = serde_json::json!({
            "type": "system",
            "name": get_attr(&root, "name").unwrap_or(""),
            "params": {}
        });
        let params = result.get_mut("params").unwrap();
        let properties: Vec<String> = find_children(&root, "property")
            .iter()
            .map(|p| get_text(p))
            .filter(|s| !s.is_empty())
            .collect();
        if !properties.is_empty() {
            params["properties"] = serde_json::json!(properties.join(","));
        }
        return Ok(result);
    }

    // Generic: try to extract params from whatever root element we have
    let mut result = serde_json::json!({
        "type": root.tag.clone(),
        "name": get_attr(&root, "name").unwrap_or(""),
        "params": {}
    });
    let params = result.get_mut("params").unwrap();
    extract_element_params_generic(&root, params);
    Ok(result)
}

/// Extract numeric params from any XML element (generic helper for propulsion sub-files).
fn extract_element_params_generic(el: &XmlElement, merged: &mut serde_json::Value) {
    if let Some(name) = get_attr(el, "name") {
        merged["name"] = serde_json::json!(name);
    }

    for child in &el.children {
        if child.tag.starts_with('@') || child.tag == "#text" || child.tag == "table" {
            continue;
        }

        let text = get_text(child);
        if let Some(v) = text.parse::<f64>().ok() {
            merged[&child.tag] = serde_json::json!(v);
        } else if !text.is_empty() {
            merged[&child.tag] = serde_json::json!(text);
        }

        if let Some(unit) = get_attr(child, "unit") {
            merged[format!("{}_unit", child.tag)] = serde_json::json!(unit);
        }
    }

    let (tables_expr, tables_raw) = extract_tables(el);
    if !tables_expr.is_empty() {
        merged["tables"] = serde_json::json!(tables_expr);
    }
    if !tables_raw.is_empty() {
        merged["_tables"] = serde_json::json!(tables_raw);
    }
}
