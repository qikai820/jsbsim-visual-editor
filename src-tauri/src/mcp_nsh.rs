use serde_json::Value;

pub fn arguments(args: &Value) -> Result<(String, u64), String> {
    let object=args.as_object().ok_or("arguments must be an object")?;
    if object.keys().any(|key|!matches!(key.as_str(),"command"|"timeoutMs")){return Err("Unknown tool argument".into());}
    let command = args["command"].as_str().ok_or("command must be a string")?;
    if command.trim().is_empty() || command.chars().count() > 256
        || command.chars().any(char::is_control) {
        return Err("NSH expects one noninteractive command of at most 256 characters".into());
    }
    let timeout = args.get("timeoutMs").map(|v|v.as_u64().ok_or("Invalid timeoutMs")).transpose()?.unwrap_or(10000);
    if !(1000..=30000).contains(&timeout) { return Err("timeoutMs must be 1000..30000".into()); }
    Ok((command.trim().to_string(), timeout))
}

#[cfg(test)]
mod nsh_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bounded_single_command() {
        assert_eq!(arguments(&json!({"command":"param show SYS_HITL"})).unwrap(),("param show SYS_HITL".into(),10000));
        for args in [json!({"command":""}),json!({"command":"a\nb"}),json!({"command":"a\rb"}),json!({"command":"a\u{0}b"}),json!({"command":"x".repeat(257)}),json!({"command":"status","timeoutMs":999}),json!({"command":"status","timeoutMs":30001}),json!({"command":"status","port":14553})] {
            assert!(arguments(&args).is_err(),"{args}");
        }
    }
}
