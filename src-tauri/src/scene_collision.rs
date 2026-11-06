//! Dedicated, bounded collision sidecar validation before verified model upload.
pub fn validate(content: &str) -> Result<u32, String> {
    if content.len() > 160 * 1024 * 1024 { return Err("碰撞地图超过 160 MB".into()); }
    let mut words = content.split_whitespace();
    let mut next = || words.next().ok_or_else(|| "碰撞地图不完整".to_string());
    if next()? != "JSBSCENE1" { return Err("碰撞地图格式无效".into()); }
    let revision = next()?.parse::<u32>().map_err(|_| "碰撞版本无效")?;
    for limit in [90., 180., 100000.] {
        let n = next()?.parse::<f64>().map_err(|_| "地理基准无效")?;
        if !n.is_finite() || n.abs() > limit { return Err("地理基准超出范围".into()); }
    }
    let radius = next()?.parse::<f64>().map_err(|_| "包络半径无效")?;
    if !radius.is_finite() || !(0.01..=100.).contains(&radius) { return Err("包络半径超出范围".into()); }
    let count = next()?.parse::<usize>().map_err(|_| "三角形数量无效")?;
    if count == 0 || count > 1_000_000 { return Err("三角形数量超出范围".into()); }
    for _ in 0..count {
        let mut v = [0.; 9];
        for n in &mut v { *n = next()?.parse::<f64>().map_err(|_| "顶点无效")?;
            if !n.is_finite() || n.abs() > 1_000_000. { return Err("顶点超出范围".into()); } }
        let ab = [v[3]-v[0],v[4]-v[1],v[5]-v[2]]; let ac = [v[6]-v[0],v[7]-v[1],v[8]-v[2]];
        let cross = [ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
        if cross.iter().map(|n| n*n).sum::<f64>() < 1e-20 { return Err("退化三角形".into()); }
    }
    if words.next().is_some() { return Err("碰撞地图包含多余数据".into()); }
    Ok(revision)
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn bounded_map() {
  assert_eq!(validate("JSBSCENE1 42 30 120 12 .5 1 0 0 0 1 0 0 0 0 1"),Ok(42));
  for text in ["", "JSBSCENE1 1 91 0 0 .5 1", "JSBSCENE1 1 0 0 0 nan 1", "JSBSCENE1 1 0 0 0 .5 1000001", "JSBSCENE1 1 0 0 0 .5 1 0 0 0 0 0 0 0 0 0"] { assert!(validate(text).is_err()); }
 }
}
