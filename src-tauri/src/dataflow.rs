//! Simulink-style data flow parser for JSBSim XML.
//!
//! Parses JSBSim XML files into a directed signal graph where:
//! - Nodes = computation blocks (summer, gain, PID, function, property, etc.)
//! - Edges = signal connections between blocks
//! - The graph captures the complete data flow of flight control, aerodynamics, and systems.

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ── Core types ──────────────────────────────────────────────────────────────

/// A computation block in the signal graph (Simulink block equivalent).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalNode {
    /// Unique ID within the graph.
    pub id: String,
    /// Block type: "summer", "pure_gain", "pid", "function", "property", "switch", etc.
    pub block_type: String,
    /// Human-readable name (from JSBSim name attribute or generated).
    pub name: String,
    /// Channel or section this block belongs to.
    pub channel: Option<String>,
    /// Source file this block came from.
    pub source_file: Option<String>,
    /// Input signal names (property paths or output names of other blocks).
    pub inputs: Vec<SignalInput>,
    /// Output signal name(s).
    pub outputs: Vec<String>,
    /// Block parameters (gain values, PID coefficients, clip limits, etc.).
    pub params: HashMap<String, serde_json::Value>,
    /// For function blocks: the expression tree.
    pub expression: Option<ExprNode>,
    /// Description from XML.
    pub description: Option<String>,
}

/// An input to a block — either a signal reference or a negated signal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalInput {
    /// Signal name (property path or block output name).
    pub signal: String,
    /// Whether this input is negated (e.g., `-velocities/pi-rad_sec`).
    pub negated: bool,
    /// Optional gain applied to this input (for summer blocks with gain on input).
    pub gain: Option<f64>,
}

/// A directed edge in the signal graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalEdge {
    /// Source node ID (producer of the signal).
    pub source: String,
    /// Target node ID (consumer of the signal).
    pub target: String,
    /// Signal name (property path).
    pub signal: String,
}

/// The complete signal graph for a JSBSim aircraft.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalGraph {
    /// All computation blocks.
    pub nodes: Vec<SignalNode>,
    /// All signal connections.
    pub edges: Vec<SignalEdge>,
    /// All external input signals (referenced but not produced by any block).
    pub external_inputs: Vec<String>,
    /// All output signals (produced but not consumed by any block).
    pub external_outputs: Vec<String>,
    /// Summary statistics.
    pub stats: GraphStats,
}

/// Summary statistics for the signal graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphStats {
    pub total_nodes: usize,
    pub total_edges: usize,
    pub total_channels: usize,
    pub total_functions: usize,
    pub total_properties: usize,
    pub block_type_counts: HashMap<String, usize>,
}

// ── Expression tree (for aerodynamics functions) ────────────────────────────

/// A node in a JSBSim expression tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ExprNode {
    Value { value: f64 },
    Property { name: String },
    Product { children: Vec<ExprNode> },
    Sum { children: Vec<ExprNode> },
    Difference { left: Box<ExprNode>, right: Box<ExprNode> },
    Quotient { left: Box<ExprNode>, right: Box<ExprNode> },
    Pow { base: Box<ExprNode>, exponent: Box<ExprNode> },
    Abs { child: Box<ExprNode> },
    Sin { child: Box<ExprNode> },
    Cos { child: Box<ExprNode> },
    Tan { child: Box<ExprNode> },
    Asin { child: Box<ExprNode> },
    Acos { child: Box<ExprNode> },
    Atan { child: Box<ExprNode> },
    Atan2 { y: Box<ExprNode>, x: Box<ExprNode> },
    Sqrt { child: Box<ExprNode> },
    Exp { child: Box<ExprNode> },
    Log { child: Box<ExprNode> },
    Min { children: Vec<ExprNode> },
    Max { children: Vec<ExprNode> },
    Avg { children: Vec<ExprNode> },
    And { children: Vec<ExprNode> },
    Or { children: Vec<ExprNode> },
    Not { child: Box<ExprNode> },
    Gt { left: Box<ExprNode>, right: Box<ExprNode> },
    Lt { left: Box<ExprNode>, right: Box<ExprNode> },
    Ge { left: Box<ExprNode>, right: Box<ExprNode> },
    Le { left: Box<ExprNode>, right: Box<ExprNode> },
    Eq { left: Box<ExprNode>, right: Box<ExprNode> },
    Nq { left: Box<ExprNode>, right: Box<ExprNode> },
    IfThen {
        cond: Box<ExprNode>,
        then: Box<ExprNode>,
        else_: Box<ExprNode>,
    },
    Switch {
        index: Box<ExprNode>,
        cases: Vec<ExprNode>,
        default: Box<ExprNode>,
    },
    Table {
        table_type: String,
        var1: String,
        var2: String,
        var3: String,
        data: Vec<Vec<f64>>,
        breakpoints1: Vec<f64>,
        breakpoints2: Vec<f64>,
        breakpoints3: Vec<f64>,
    },
    Pi,
    Random,
    URandom,
}

// ── XML parsing helpers ─────────────────────────────────────────────────────

/// Simple XML element representation for recursive parsing.
#[derive(Debug, Clone)]
struct XmlElement {
    tag: String,
    attrs: HashMap<String, String>,
    text: String,
    children: Vec<XmlElement>,
}

/// Parse an XML string into a tree of XmlElement.
fn parse_xml_tree(xml: &str) -> Result<XmlElement, String> {
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

/// Find child elements by tag name.
fn find_children<'a>(elem: &'a XmlElement, tag: &str) -> Vec<&'a XmlElement> {
    elem.children.iter().filter(|c| c.tag == tag).collect()
}

/// Find first child element by tag name.
fn find_child<'a>(elem: &'a XmlElement, tag: &str) -> Option<&'a XmlElement> {
    elem.children.iter().find(|c| c.tag == tag)
}

/// Get attribute value.
fn get_attr<'a>(elem: &'a XmlElement, key: &str) -> Option<&'a str> {
    elem.attrs.get(key).map(|s| s.as_str())
}

/// Get text content, trimmed.
fn get_text(elem: &XmlElement) -> String {
    elem.text.trim().to_string()
}

/// Parse a float from text.
fn parse_f64(text: &str) -> Option<f64> {
    text.trim().parse().ok()
}

// ── Expression tree parser ──────────────────────────────────────────────────

/// Parse a JSBSim function element into an expression tree.
fn parse_expression(func_elem: &XmlElement) -> ExprNode {
    // Check for direct <value>
    if let Some(val_elem) = find_child(func_elem, "value") {
        let text = get_text(val_elem);
        if let Some(v) = parse_f64(&text) {
            return ExprNode::Value { value: v };
        }
    }

    // Try each operation type
    if let Some(elem) = find_child(func_elem, "product") {
        return ExprNode::Product {
            children: elem.children.iter().map(|c| parse_expr_child(c)).collect(),
        };
    }
    if let Some(elem) = find_child(func_elem, "sum") {
        return ExprNode::Sum {
            children: elem.children.iter().map(|c| parse_expr_child(c)).collect(),
        };
    }
    if let Some(elem) = find_child(func_elem, "difference") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::Difference {
            left: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            right: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
        };
    }
    if let Some(elem) = find_child(func_elem, "quotient") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::Quotient {
            left: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            right: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
        };
    }
    if let Some(elem) = find_child(func_elem, "pow") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::Pow {
            base: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            exponent: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
        };
    }
    if let Some(elem) = find_child(func_elem, "atan2") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::Atan2 {
            y: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            x: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
        };
    }

    // Unary functions
    for op in &["abs", "sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "exp", "log"] {
        if let Some(elem) = find_child(func_elem, op) {
            let child = elem.children.first()
                .map(|c| parse_expr_child(c))
                .unwrap_or(ExprNode::Value { value: 0.0 });
            let node = match *op {
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
                _ => unreachable!(),
            };
            return node;
        }
    }

    // Multi-arg functions
    for op in &["min", "max", "avg", "and", "or"] {
        if let Some(elem) = find_child(func_elem, op) {
            return match *op {
                "min" => ExprNode::Min { children: elem.children.iter().map(|c| parse_expr_child(c)).collect() },
                "max" => ExprNode::Max { children: elem.children.iter().map(|c| parse_expr_child(c)).collect() },
                "avg" => ExprNode::Avg { children: elem.children.iter().map(|c| parse_expr_child(c)).collect() },
                "and" => ExprNode::And { children: elem.children.iter().map(|c| parse_expr_child(c)).collect() },
                "or" => ExprNode::Or { children: elem.children.iter().map(|c| parse_expr_child(c)).collect() },
                _ => unreachable!(),
            };
        }
    }

    // Comparisons
    for op in &["gt", "lt", "ge", "le", "eq", "nq"] {
        if let Some(elem) = find_child(func_elem, op) {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            let left = children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 });
            let right = children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 });
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

    // not
    if let Some(elem) = find_child(func_elem, "not") {
        let child = elem.children.first()
            .map(|c| parse_expr_child(c))
            .unwrap_or(ExprNode::Value { value: 0.0 });
        return ExprNode::Not { child: Box::new(child) };
    }

    // ifthen
    if let Some(elem) = find_child(func_elem, "ifthen") {
        let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
        return ExprNode::IfThen {
            cond: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            then: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            else_: Box::new(children.get(2).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
        };
    }

    // switch
    if let Some(elem) = find_child(func_elem, "switch") {
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
    if let Some(elem) = find_child(func_elem, "table") {
        return parse_table_expr(elem);
    }

    // property (standalone)
    if let Some(elem) = find_child(func_elem, "property") {
        return ExprNode::Property { name: get_text(elem) };
    }

    // pi, random, urandom
    if find_child(func_elem, "pi").is_some() {
        return ExprNode::Pi;
    }
    if find_child(func_elem, "random").is_some() {
        return ExprNode::Random;
    }
    if find_child(func_elem, "urandom").is_some() {
        return ExprNode::URandom;
    }

    // Fallback: try to parse text as number
    let text = get_text(func_elem);
    if let Some(v) = parse_f64(&text) {
        return ExprNode::Value { value: v };
    }

    ExprNode::Value { value: 0.0 }
}

/// Parse an expression child element (could be any func_group).
fn parse_expr_child(elem: &XmlElement) -> ExprNode {
    // Check if this is a wrapper element (e.g., <product><property>...</property></product>)
    // The elem itself might be the operation element
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
                left: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
                right: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            }
        }
        "quotient" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            ExprNode::Quotient {
                left: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
                right: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            }
        }
        "pow" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            ExprNode::Pow {
                base: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
                exponent: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            }
        }
        "atan2" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            ExprNode::Atan2 {
                y: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
                x: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
            }
        }
        "abs" | "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "sqrt" | "exp" | "log" => {
            let child = elem.children.first()
                .map(|c| parse_expr_child(c))
                .unwrap_or(ExprNode::Value { value: 0.0 });
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
                _ => unreachable!(),
            }
        }
        "not" => {
            let child = elem.children.first()
                .map(|c| parse_expr_child(c))
                .unwrap_or(ExprNode::Value { value: 0.0 });
            ExprNode::Not { child: Box::new(child) }
        }
        "min" | "max" | "avg" | "and" | "or" => {
            let children = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            match elem.tag.as_str() {
                "min" => ExprNode::Min { children },
                "max" => ExprNode::Max { children },
                "avg" => ExprNode::Avg { children },
                "and" => ExprNode::And { children },
                "or" => ExprNode::Or { children },
                _ => unreachable!(),
            }
        }
        "gt" | "lt" | "ge" | "le" | "eq" | "nq" => {
            let children: Vec<_> = elem.children.iter().map(|c| parse_expr_child(c)).collect();
            let left = children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 });
            let right = children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 });
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
                cond: Box::new(children.first().cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
                then: Box::new(children.get(1).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
                else_: Box::new(children.get(2).cloned().unwrap_or(ExprNode::Value { value: 0.0 })),
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
                ExprNode::Value { value: 0.0 }
            }
        }
        "table" => parse_table_expr(elem),
        // If it has child operation elements, recurse
        _ => {
            // Check if this element contains operation children
            let op_children: Vec<_> = elem.children.iter()
                .filter(|c| is_expr_element(c))
                .collect();
            if !op_children.is_empty() {
                // This is a wrapper, parse the first operation child
                parse_expr_child(op_children[0])
            } else {
                // Try as property or value
                let text = get_text(elem);
                if let Some(v) = parse_f64(&text) {
                    ExprNode::Value { value: v }
                } else if !text.is_empty() {
                    ExprNode::Property { name: text }
                } else {
                    ExprNode::Value { value: 0.0 }
                }
            }
        }
    }
}

/// Check if an element is an expression element (operation, property, value, etc.).
fn is_expr_element(elem: &XmlElement) -> bool {
    matches!(elem.tag.as_str(),
        "property" | "value" | "v" | "p" | "pi" | "random" | "urandom" |
        "product" | "sum" | "difference" | "quotient" | "pow" | "atan2" |
        "abs" | "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "sqrt" | "exp" | "log" |
        "not" | "min" | "max" | "avg" | "and" | "or" |
        "gt" | "lt" | "ge" | "le" | "eq" | "nq" |
        "ifthen" | "switch" | "table"
    )
}

/// Parse a table expression element.
fn parse_table_expr(elem: &XmlElement) -> ExprNode {
    let mut var1 = String::new();
    let mut var2 = String::new();
    let mut var3 = String::new();
    let mut table_type = "1D".to_string();

    // Parse independentVar elements
    for iv in find_children(elem, "independentVar") {
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

    // Detect tableType from number of independentVars
    let ind_vars = find_children(elem, "independentVar");
    if ind_vars.len() >= 3 {
        table_type = "3D".to_string();
    } else if ind_vars.len() == 2 {
        table_type = "2D".to_string();
    }

    // Parse tableData
    let table_data_elems = find_children(elem, "tableData");
    let has_breakpoints = table_data_elems.iter()
        .any(|td| td.attrs.contains_key("breakPoint"));

    if has_breakpoints {
        table_type = "3D".to_string();
        return parse_table_3d(&table_data_elems, &var1, &var2, &var3);
    }

    if let Some(td) = table_data_elems.first() {
        let text = get_text(td);
        let rows = parse_table_text(&text);

        if table_type == "2D" && rows.len() > 1 && rows[0].len() > 1 {
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

fn parse_table_3d(
    table_data_elems: &[&XmlElement],
    var1: &str,
    var2: &str,
    var3: &str,
) -> ExprNode {
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
                    if breakpoints1.len() < all_data.len() / (breakpoints2.len().max(1)) + 1 {
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

// ─ Flight control parser ───────────────────────────────────────────────────

/// Parse a flight_control XML element into signal nodes.
fn parse_flight_control(
    root: &XmlElement,
    source_file: Option<&str>,
) -> Vec<SignalNode> {
    let mut nodes = Vec::new();
    let mut node_counter = 0;

    // Parse top-level <property> elements (global properties)
    for prop in find_children(root, "property") {
        node_counter += 1;
        let name = get_text(prop);
        let value = get_attr(prop, "value").and_then(|v| v.parse::<f64>().ok());
        let mut params = HashMap::new();
        if let Some(v) = value {
            params.insert("value".to_string(), serde_json::json!(v));
        }
        nodes.push(SignalNode {
            id: format!("prop-{}", node_counter),
            block_type: "property".to_string(),
            name: name.clone(),
            channel: None,
            source_file: source_file.map(|s| s.to_string()),
            inputs: vec![],
            outputs: vec![name],
            params,
            expression: None,
            description: None,
        });
    }

    // Parse channels
    for channel in find_children(root, "channel") {
        let channel_name = get_attr(channel, "name").unwrap_or("unnamed").to_string();

        for comp in &channel.children {
            if comp.tag == "property" {
                // Property inside a channel
                node_counter += 1;
                let name = get_text(comp);
                let value = get_attr(comp, "value").and_then(|v| v.parse::<f64>().ok());
                let mut params = HashMap::new();
                if let Some(v) = value {
                    params.insert("value".to_string(), serde_json::json!(v));
                }
                nodes.push(SignalNode {
                    id: format!("prop-{}", node_counter),
                    block_type: "property".to_string(),
                    name: name.clone(),
                    channel: Some(channel_name.clone()),
                    source_file: source_file.map(|s| s.to_string()),
                    inputs: vec![],
                    outputs: vec![name],
                    params,
                    expression: None,
                    description: None,
                });
                continue;
            }

            let block_type = comp.tag.clone();
            let name_attr = get_attr(comp, "name").map(|s| s.to_string());

            // Parse outputs first (needed for name fallback)
            let mut outputs = Vec::new();
            for output_elem in find_children(comp, "output") {
                outputs.push(get_text(output_elem));
            }

            let name = name_attr.clone()
                .or_else(|| outputs.first().cloned())
                .unwrap_or_else(|| block_type.clone());

            // For PID/actuator/etc blocks: if name is a property path, it's also the output
            if outputs.is_empty() && name.contains('/') {
                outputs.push(name.clone());
            }

            node_counter += 1;
            let node_id = format!("{}-{}", block_type, node_counter);

            // Parse inputs
            let mut inputs = Vec::new();
            for input_elem in find_children(comp, "input") {
                let text = get_text(input_elem).trim().to_string();
                let (negated, signal) = if let Some(stripped) = text.strip_prefix('-') {
                    (true, stripped.to_string())
                } else {
                    (false, text)
                };
                inputs.push(SignalInput {
                    signal,
                    negated,
                    gain: None,
                });
            }

            // Parse parameters based on block type
            let mut params = HashMap::new();

            match block_type.as_str() {
                "pure_gain" => {
                    if let Some(gain_elem) = find_child(comp, "gain") {
                        let text = get_text(gain_elem);
                        // Gain can be a number or a property reference
                        if let Some(v) = parse_f64(&text) {
                            params.insert("gain".to_string(), serde_json::json!(v));
                        } else {
                            params.insert("gain_property".to_string(), serde_json::json!(text));
                        }
                    }
                }
                "pid" => {
                    for param_name in &["kp", "ki", "kd", "trigger"] {
                        if let Some(elem) = find_child(comp, param_name) {
                            let text = get_text(elem);
                            if let Some(v) = parse_f64(&text) {
                                params.insert(param_name.to_string(), serde_json::json!(v));
                            }
                        }
                    }
                }
                "summer" => {
                    // Summer has no extra params beyond inputs
                }
                "switch" => {
                    // Parse test, value, default
                    if let Some(elem) = find_child(comp, "test") {
                        params.insert("test".to_string(), serde_json::json!(get_text(elem)));
                    }
                    if let Some(elem) = find_child(comp, "value") {
                        params.insert("value".to_string(), serde_json::json!(get_text(elem)));
                    }
                    if let Some(elem) = find_child(comp, "default") {
                        params.insert("default".to_string(), serde_json::json!(get_text(elem)));
                    }
                }
                "integrator" => {
                    if let Some(elem) = find_child(comp, "gain") {
                        if let Some(v) = parse_f64(&get_text(elem)) {
                            params.insert("gain".to_string(), serde_json::json!(v));
                        }
                    }
                    if let Some(elem) = find_child(comp, "trigger") {
                        params.insert("trigger".to_string(), serde_json::json!(get_text(elem)));
                    }
                    if let Some(elem) = find_child(comp, "c1") {
                        if let Some(v) = parse_f64(&get_text(elem)) {
                            params.insert("c1".to_string(), serde_json::json!(v));
                        }
                    }
                }
                "lag_filter" | "lead_lag" | "washout" | "second_order_filter" => {
                    for param_name in &["gain", "c1", "c2", "c3", "c4"] {
                        if let Some(elem) = find_child(comp, param_name) {
                            if let Some(v) = parse_f64(&get_text(elem)) {
                                params.insert(param_name.to_string(), serde_json::json!(v));
                            }
                        }
                    }
                }
                "deadband" => {
                    if let Some(elem) = find_child(comp, "width") {
                        if let Some(v) = parse_f64(&get_text(elem)) {
                            params.insert("width".to_string(), serde_json::json!(v));
                        }
                    }
                }
                "kinematic" => {
                    if let Some(elem) = find_child(comp, "traverse") {
                        if let Some(v) = parse_f64(&get_text(elem)) {
                            params.insert("traverse".to_string(), serde_json::json!(v));
                        }
                    }
                }
                "actuator" => {
                    for param_name in &["lag", "rate_limit", "bias", "deadband_width"] {
                        if let Some(elem) = find_child(comp, param_name) {
                            if let Some(v) = parse_f64(&get_text(elem)) {
                                params.insert(param_name.to_string(), serde_json::json!(v));
                            }
                        }
                    }
                }
                "sensor" | "gyro" | "accelerometer" | "magnetometer" | "altimeter" | "gps" => {
                    // Sensor blocks may have noise, quantization, etc.
                    for param_name in &["noise", "quantization", "lag", "bias"] {
                        if let Some(elem) = find_child(comp, param_name) {
                            if let Some(v) = parse_f64(&get_text(elem)) {
                                params.insert(param_name.to_string(), serde_json::json!(v));
                            }
                        }
                    }
                }
                _ => {
                    // Generic: capture all child elements as params
                    for child in &comp.children {
                        if !matches!(child.tag.as_str(), "input" | "output" | "clipto" | "description") {
                            let text = get_text(child);
                            if let Some(v) = parse_f64(&text) {
                                params.insert(child.tag.clone(), serde_json::json!(v));
                            } else if !text.is_empty() {
                                params.insert(child.tag.clone(), serde_json::json!(text));
                            }
                        }
                    }
                }
            }

            // Parse clipTo
            if let Some(clip_elem) = find_child(comp, "clipto") {
                if let Some(min_elem) = find_child(clip_elem, "min") {
                    if let Some(v) = parse_f64(&get_text(min_elem)) {
                        params.insert("clip_min".to_string(), serde_json::json!(v));
                    }
                }
                if let Some(max_elem) = find_child(clip_elem, "max") {
                    if let Some(v) = parse_f64(&get_text(max_elem)) {
                        params.insert("clip_max".to_string(), serde_json::json!(v));
                    }
                }
            }

            // Parse description
            let description = find_child(comp, "description").map(|d| get_text(d));

            nodes.push(SignalNode {
                id: node_id,
                block_type,
                name,
                channel: Some(channel_name.clone()),
                source_file: source_file.map(|s| s.to_string()),
                inputs,
                outputs,
                params,
                expression: None,
                description,
            });
        }
    }

    nodes
}

// ── Aerodynamics parser ─────────────────────────────────────────────────────

/// Parse an aerodynamics XML element into signal nodes.
fn parse_aerodynamics(
    root: &XmlElement,
    source_file: Option<&str>,
) -> Vec<SignalNode> {
    let mut nodes = Vec::new();
    let mut node_counter = 0;

    // Parse <function> elements (aerodynamic coefficient functions)
    for func in find_children(root, "function") {
        node_counter += 1;
        let name = get_attr(func, "name").unwrap_or(&format!("aero-func-{}", node_counter)).to_string();
        let description = find_child(func, "description").map(|d| get_text(d));

        let expression = parse_expression(func);

        // Extract input properties from the expression tree
        let inputs = extract_expr_inputs(&expression);

        nodes.push(SignalNode {
            id: format!("aero-func-{}", node_counter),
            block_type: "function".to_string(),
            name: name.clone(),
            channel: None,
            source_file: source_file.map(|s| s.to_string()),
            inputs: inputs.into_iter().map(|s| SignalInput {
                signal: s,
                negated: false,
                gain: None,
            }).collect(),
            outputs: vec![name],
            params: HashMap::new(),
            expression: Some(expression),
            description,
        });
    }

    // Parse <axis> elements (contain force/moment functions)
    for axis in find_children(root, "axis") {
        let axis_name = get_attr(axis, "name").unwrap_or("unknown").to_string();

        for func in find_children(axis, "function") {
            node_counter += 1;
            let name = get_attr(func, "name")
                .unwrap_or(&format!("{}-{}", axis_name, node_counter))
                .to_string();
            let description = find_child(func, "description").map(|d| get_text(d));

            let expression = parse_expression(func);
            let inputs = extract_expr_inputs(&expression);

            nodes.push(SignalNode {
                id: format!("aero-axis-{}", node_counter),
                block_type: "function".to_string(),
                name: name.clone(),
                channel: Some(format!("axis:{}", axis_name)),
                source_file: source_file.map(|s| s.to_string()),
                inputs: inputs.into_iter().map(|s| SignalInput {
                    signal: s,
                    negated: false,
                    gain: None,
                }).collect(),
                outputs: vec![name],
                params: HashMap::new(),
                expression: Some(expression),
                description,
            });
        }
    }

    nodes
}

/// Extract all property references from an expression tree.
fn extract_expr_inputs(expr: &ExprNode) -> Vec<String> {
    let mut inputs = Vec::new();
    let mut seen = HashSet::new();
    collect_expr_inputs(expr, &mut inputs, &mut seen);
    inputs
}

fn collect_expr_inputs(expr: &ExprNode, inputs: &mut Vec<String>, seen: &mut HashSet<String>) {
    match expr {
        ExprNode::Property { name } => {
            if seen.insert(name.clone()) {
                inputs.push(name.clone());
            }
        }
        ExprNode::Product { children } | ExprNode::Sum { children } |
        ExprNode::Min { children } | ExprNode::Max { children } |
        ExprNode::Avg { children } | ExprNode::And { children } |
        ExprNode::Or { children } => {
            for child in children {
                collect_expr_inputs(child, inputs, seen);
            }
        }
        ExprNode::Difference { left, right } |
        ExprNode::Quotient { left, right } |
        ExprNode::Pow { base: left, exponent: right } |
        ExprNode::Atan2 { y: left, x: right } |
        ExprNode::Gt { left, right } |
        ExprNode::Lt { left, right } |
        ExprNode::Ge { left, right } |
        ExprNode::Le { left, right } |
        ExprNode::Eq { left, right } |
        ExprNode::Nq { left, right } => {
            collect_expr_inputs(left, inputs, seen);
            collect_expr_inputs(right, inputs, seen);
        }
        ExprNode::Abs { child } | ExprNode::Sin { child } | ExprNode::Cos { child } |
        ExprNode::Tan { child } | ExprNode::Asin { child } | ExprNode::Acos { child } |
        ExprNode::Atan { child } | ExprNode::Sqrt { child } | ExprNode::Exp { child } |
        ExprNode::Log { child } | ExprNode::Not { child } => {
            collect_expr_inputs(child, inputs, seen);
        }
        ExprNode::IfThen { cond, then, else_ } => {
            collect_expr_inputs(cond, inputs, seen);
            collect_expr_inputs(then, inputs, seen);
            collect_expr_inputs(else_, inputs, seen);
        }
        ExprNode::Switch { index, cases, default } => {
            collect_expr_inputs(index, inputs, seen);
            for case in cases {
                collect_expr_inputs(case, inputs, seen);
            }
            collect_expr_inputs(default, inputs, seen);
        }
        ExprNode::Table { var1, var2, var3, .. } => {
            for var in [var1, var2, var3] {
                if !var.is_empty() && seen.insert(var.clone()) {
                    inputs.push(var.clone());
                }
            }
        }
        ExprNode::Value { .. } | ExprNode::Pi | ExprNode::Random | ExprNode::URandom => {}
    }
}

// ── System file parser ──────────────────────────────────────────────────────

/// Parse a system XML file (same structure as flight_control).
fn parse_system(
    root: &XmlElement,
    source_file: Option<&str>,
) -> Vec<SignalNode> {
    // System files can have <channel> elements like flight_control
    // They can also have top-level <property> elements
    parse_flight_control(root, source_file)
}

// ── Main entry point ────────────────────────────────────────────────────────

/// Parse a complete JSBSim XML document into a Simulink-style signal graph.
///
/// `xml` is the main aircraft XML file content.
/// `file_map` maps filenames to their XML content (for resolving file references).
pub fn parse_dataflow(xml: &str, file_map: &HashMap<String, String>) -> Result<SignalGraph, String> {
    let root = parse_xml_tree(xml)?;

    // Determine root element type
    let root_tag = root.tag.as_str();

    let mut all_nodes = Vec::new();

    match root_tag {
        "fdm_config" => {
            // Main aircraft file — resolve file references
            parse_fdm_config(&root, file_map, &mut all_nodes)?;
        }
        "flight_control" => {
            all_nodes.extend(parse_flight_control(&root, None));
        }
        "aerodynamics" => {
            all_nodes.extend(parse_aerodynamics(&root, None));
        }
        "system" | "autopilot" => {
            all_nodes.extend(parse_system(&root, None));
        }
        "propulsion" => {
            // Propulsion is structural, not signal-flow
            // But we can extract engine/thruster references
        }
        _ => {
            // Try to parse as flight_control or aerodynamics
            if find_children(&root, "channel").is_empty() && find_children(&root, "function").is_empty() {
                return Err(format!("Unknown root element: <{}>", root_tag));
            }
            if !find_children(&root, "channel").is_empty() {
                all_nodes.extend(parse_flight_control(&root, None));
            }
            if !find_children(&root, "function").is_empty() {
                all_nodes.extend(parse_aerodynamics(&root, None));
            }
        }
    }

    // Build edges from signal connections
    let (edges, external_inputs, external_outputs) = build_edges(&all_nodes);

    // Compute stats
    let mut block_type_counts = HashMap::new();
    for node in &all_nodes {
        *block_type_counts.entry(node.block_type.clone()).or_insert(0) += 1;
    }

    let channels: HashSet<&str> = all_nodes.iter()
        .filter_map(|n| n.channel.as_deref())
        .collect();

    let functions = block_type_counts.get("function").copied().unwrap_or(0);
    let properties = block_type_counts.get("property").copied().unwrap_or(0);

    let stats = GraphStats {
        total_nodes: all_nodes.len(),
        total_edges: edges.len(),
        total_channels: channels.len(),
        total_functions: functions,
        total_properties: properties,
        block_type_counts,
    };

    Ok(SignalGraph {
        nodes: all_nodes,
        edges,
        external_inputs,
        external_outputs,
        stats,
    })
}

/// Parse an fdm_config root element, resolving file references.
fn parse_fdm_config(
    root: &XmlElement,
    file_map: &HashMap<String, String>,
    all_nodes: &mut Vec<SignalNode>,
) -> Result<(), String> {
    // Parse file references
    let file_refs: Vec<(&str, &str)> = vec![
        ("flight_control", "file"),
        ("aerodynamics", "file"),
        ("system", "file"),
        ("propulsion", "file"),
    ];

    for (tag, attr) in &file_refs {
        for elem in find_children(root, tag) {
            if let Some(file_name) = get_attr(elem, attr) {
                let source = file_name;
                // Try to find the file content
                if let Some(content) = file_map.get(file_name)
                    .or_else(|| file_map.get(&file_name.replace(".xml", "")))
                {
                    match parse_xml_tree(content) {
                        Ok(file_root) => {
                            match *tag {
                                "flight_control" => {
                                    all_nodes.extend(parse_flight_control(&file_root, Some(source)));
                                }
                                "aerodynamics" => {
                                    all_nodes.extend(parse_aerodynamics(&file_root, Some(source)));
                                }
                                "system" | "autopilot" => {
                                    all_nodes.extend(parse_system(&file_root, Some(source)));
                                }
                                _ => {}
                            }
                        }
                        Err(e) => {
                            eprintln!("[dataflow] Failed to parse {}: {}", file_name, e);
                        }
                    }
                } else {
                    eprintln!("[dataflow] File not found in file_map: {}", file_name);
                }
            }
        }
    }

    // Also check for inline content (not file reference)
    for fc in find_children(root, "flight_control") {
        if !fc.attrs.contains_key("file") {
            all_nodes.extend(parse_flight_control(fc, None));
        }
    }
    for aero in find_children(root, "aerodynamics") {
        if !aero.attrs.contains_key("file") {
            all_nodes.extend(parse_aerodynamics(aero, None));
        }
    }

    Ok(())
}

/// Build edges from node inputs/outputs, and identify external signals.
fn build_edges(nodes: &[SignalNode]) -> (Vec<SignalEdge>, Vec<String>, Vec<String>) {
    // Build a map: output signal name → node ID
    let mut output_map: HashMap<&str, &str> = HashMap::new();
    for node in nodes {
        for output in &node.outputs {
            output_map.insert(output.as_str(), node.id.as_str());
        }
    }

    let mut edges = Vec::new();
    let mut consumed_signals: HashSet<String> = HashSet::new();
    let mut produced_signals: HashSet<String> = HashSet::new();

    for node in nodes {
        for output in &node.outputs {
            produced_signals.insert(output.clone());
        }
        for input in &node.inputs {
            consumed_signals.insert(input.signal.clone());
            if let Some(&source_id) = output_map.get(input.signal.as_str()) {
                edges.push(SignalEdge {
                    source: source_id.to_string(),
                    target: node.id.clone(),
                    signal: input.signal.clone(),
                });
            }
        }
    }

    // External inputs: consumed but not produced
    let external_inputs: Vec<String> = consumed_signals
        .difference(&produced_signals)
        .cloned()
        .collect();

    // External outputs: produced but not consumed
    let external_outputs: Vec<String> = produced_signals
        .difference(&consumed_signals)
        .cloned()
        .collect();

    (edges, external_inputs, external_outputs)
}

// ── Public API for Tauri commands ───────────────────────────────────────────

/// Parse JSBSim XML and return a Simulink-style signal graph as JSON.
pub fn parse_dataflow_json(xml: &str, file_map: &HashMap<String, String>) -> Result<serde_json::Value, String> {
    let graph = parse_dataflow(xml, file_map)?;
    serde_json::to_value(&graph).map_err(|e| e.to_string())
}
