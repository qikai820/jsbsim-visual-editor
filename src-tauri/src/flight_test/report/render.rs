use super::{ExitState, StageState};
use crate::flight_test::{Options, Snapshot, Trace};
use std::fmt::Write;

const CSS: &str = include_str!("report.css");
const JS: &str = include_str!("report.js");

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn status(value: &str) -> (&'static str, &'static str) {
    match value {
        "passed" => ("pass", "通过"),
        "failed" => ("fail", "失败"),
        "stopped" => ("skip", "已终止"),
        _ => ("skip", "结果未记录"),
    }
}

fn policy(value: &str) -> &str {
    match value {
        "hold" => "Hold",
        "land" => "降落并确认上锁",
        "release" => "释放输入",
        _ => "未记录",
    }
}

fn elapsed(seconds: f64) -> String {
    let deciseconds = (seconds.max(0.) * 10.).round() as u64;
    let total = deciseconds / 10;
    let minutes = total / 60;
    let seconds = total % 60;
    let fraction = deciseconds % 10;
    if minutes >= 60 {
        format!(
            "{:02}:{:02}:{seconds:02}.{fraction}",
            minutes / 60,
            minutes % 60
        )
    } else {
        format!("{minutes:02}:{seconds:02}.{fraction}")
    }
}

fn info(out: &mut String, label: &str, value: &str) {
    let _ = write!(out, "<div><dt>{label}</dt><dd>{}</dd></div>", escape(value));
}

fn at(trace: &Trace, key: &str) -> Option<f64> {
    trace
        .values
        .get(key)
        .copied()
        .filter(|value| value.is_finite())
}

type Point = (f64, Option<f64>);
type Sample = (&'static str, fn(&Trace) -> Option<f64>);

fn sampled(trace: &[Trace], value: fn(&Trace) -> Option<f64>) -> Vec<Point> {
    let mut points = Vec::new();
    let stride = trace.len().div_ceil(300).max(1);
    // Preserve gaps and measured extrema, including one-sample spikes.
    for run in trace.chunk_by(|a, b| value(a).is_some() == value(b).is_some()) {
        if value(&run[0]).is_none() {
            points.push((run[0].time, None));
            continue;
        }
        for window in run.chunks(stride) {
            let first = (0, value(&window[0]).unwrap());
            let mut min = first;
            let mut max = first;
            for (index, point) in window.iter().enumerate().skip(1) {
                let candidate = value(point).unwrap();
                if candidate < min.1 {
                    min = (index, candidate);
                }
                if candidate > max.1 {
                    max = (index, candidate);
                }
            }
            let last = window.len() - 1;
            let mut selected = [first, min, max, (last, value(&window[last]).unwrap())];
            selected.sort_by_key(|(index, _)| *index);
            for (i, &(index, value)) in selected.iter().enumerate() {
                if i == 0 || index != selected[i - 1].0 {
                    points.push((window[index].time, Some(value)));
                }
            }
        }
    }
    points
}

fn chart(
    out: &mut String,
    trace: &[Trace],
    index: usize,
    title: &str,
    units: &str,
    samples: &[Sample],
    failure_at: Option<f64>,
) {
    let series: Vec<_> = samples
        .iter()
        .map(|(name, value)| (*name, sampled(trace, *value)))
        .filter(|(_, points)| points.iter().any(|(_, value)| value.is_some()))
        .collect();
    if series.is_empty() {
        return;
    }
    let labels = series.iter().map(|(name, _)| *name).collect::<Vec<_>>();
    let _ = write!(
        out,
        "<figure class=\"chart\"><figcaption id=\"chart-{index}\">{title} · {units}</figcaption>"
    );
    out.push_str("<ul class=\"legend\">");
    for (number, name) in labels.iter().enumerate() {
        let _ = write!(
            out,
            "<li><span class=\"swatch tone-{number}\"></span>{name}</li>"
        );
    }
    if failure_at.is_some() {
        out.push_str("<li><span class=\"swatch marker\"></span>脚本结束位置</li>");
    }
    out.push_str("</ul>");
    let points: Vec<_> = series.into_iter().map(|(_, points)| points).collect();
    let json = serde_json::to_string(&points).expect("numeric chart data");
    let mark = failure_at.map_or_else(String::new, |time| format!("{time:.3}"));
    let _ = write!(out, "<div class=\"plot\"><canvas aria-labelledby=\"chart-{index}\" data-marker=\"{mark}\" data-series='{}'>\
        浏览器无法显示曲线。原始采样值见 JSON。</canvas></div></figure>", escape(&json));
}

pub(super) fn html(
    result: &Snapshot,
    options: Option<&Options>,
    trace: &[Trace],
    interval: f64,
    json_file: &str,
) -> String {
    let name = escape(&result.name);
    let mode = if result.dry_run {
        "离线预演"
    } else {
        "HIL 仿真"
    };
    let (status_class, status_label) = status(&result.status);
    let outcome = result.outcome.as_ref();
    let (exit_class, exit_label) = match outcome.map(|value| value.exit_state) {
        Some(ExitState::NotRequired) => ("skip", "无需退出操作"),
        Some(ExitState::Simulated) => ("skip", "预演退出完成"),
        Some(ExitState::Confirmed) if result.exit_result.starts_with("已确认着陆并上锁") => {
            ("pass", "已着陆并上锁")
        }
        Some(ExitState::Confirmed) if result.exit_result.starts_with("飞控已上锁") => {
            ("pass", "飞控已上锁")
        }
        Some(ExitState::Confirmed) if result.exit_result.starts_with("已停止遥控输入流") => {
            ("pass", "已释放输入")
        }
        Some(ExitState::Confirmed) => ("pass", "已确认"),
        Some(ExitState::Unconfirmed) => ("fail", "未确认"),
        None => ("skip", "见退出记录"),
    };
    let instance = result
        .binding
        .as_ref()
        .map(|b| b.instance)
        .or_else(|| options.map(|o| o.instance));
    let instance = instance.map_or_else(String::new, |n| format!("<span>实例 {n:02}</span>"));
    let duration = elapsed(if result.run_elapsed > 0. {
        result.run_elapsed
    } else {
        result.real_elapsed
    });
    let started = result.started_at_unix_ms;
    let mut out = String::with_capacity(16384);
    let _ = write!(
        out,
        r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>{name} · PX4 仿真测试报告</title><style>{CSS}</style></head>
<body><main><header><p class="kicker">PX4 工具箱 · 仿真测试报告</p><h1>{name}</h1>
<div class="meta"><span class="mode">{mode}</span>{instance}<time data-epoch="{started}"></time></div></header>
<section class="sheet" aria-label="测试结果"><dl class="outcome">
<div><dt>测试结论</dt><dd class="{status_class}">{status_label}</dd></div>
<div><dt>退出确认</dt><dd class="{exit_class}">{exit_label}</dd></div>
<div><dt>总用时</dt><dd>{duration}</dd></div></dl>
<div class="section"><h2>退出结果</h2><p>{}</p></div>"#,
        escape(&result.exit_result)
    );

    let execution_reason = outcome
        .map(|value| value.reason.as_str())
        .filter(|reason| !reason.is_empty());
    if let Some(reason) = execution_reason.or_else(|| {
        (result.status != "passed" && outcome.is_none())
            .then(|| {
                result
                    .logs
                    .iter()
                    .rev()
                    .find(|log| log.level == "error")
                    .map(|log| log.message.as_str())
            })
            .flatten()
    }) {
        let heading = if result.status == "stopped" {
            "终止定位"
        } else {
            "失败定位"
        };
        let _ = write!(
            out,
            "<div class=\"section\"><h2>{heading}</h2><p class=\"finding\">{:.2} s · {}</p></div>",
            result.elapsed,
            escape(reason)
        );
    } else if outcome.is_some_and(|value| value.exit_state == ExitState::Unconfirmed) {
        out.push_str("<div class=\"section\"><h2>失败定位</h2><p class=\"finding\">退出状态未确认，详情见关键事件。</p></div>");
    }
    out.push_str("</section><section class=\"sheet\"><div class=\"section\"><h2>阶段结果</h2>");
    if result.report_stages.is_empty() {
        let execution = outcome.map_or(result.status.as_str(), |value| {
            value.execution_status.as_str()
        });
        let (class, label) = status(execution);
        let _ = write!(out, "<p>脚本结论 <span class=\"pill {class}\">{label}</span></p><p class=\"muted\">本次记录无分阶段数据，执行细节见关键事件。</p>");
    } else {
        out.push_str("<table><thead><tr><th scope=\"col\">阶段</th><th scope=\"col\">结果</th><th scope=\"col\">运行时间</th></tr></thead><tbody>");
        for stage in &result.report_stages {
            let (class, label) = match stage.state {
                StageState::Completed => ("pass", "完成"),
                StageState::Incomplete => ("fail", "未完成"),
                StageState::NotRun => ("skip", "未执行"),
            };
            let time = stage
                .completed_at
                .map_or_else(|| "—".into(), |time| format!("{time:.2} s"));
            let _ = write!(out, "<tr><th scope=\"row\">{}</th><td><span class=\"pill {class}\">{label}</span></td><td>{time}</td></tr>", escape(&stage.label));
        }
        out.push_str("</tbody></table>");
    }
    out.push_str("</div><div class=\"section\"><h2>遥测曲线</h2>");
    if trace.is_empty() {
        out.push_str("<p class=\"muted\">本次运行未采集到轨迹。</p>");
    } else {
        let horizontal: &[Sample] = &[("水平速度", |p| at(p, "test/fc/groundspeed-mps"))];
        let altitude: &[Sample] = &[
            ("相对高度", |p| at(p, "test/fc/relative-alt-m")),
            ("控高目标", |p| {
                (at(p, "test/altitude/active") == Some(1.))
                    .then(|| at(p, "test/altitude/target-m"))
                    .flatten()
            }),
        ];
        let attitude: &[Sample] = &[
            ("横滚", |p| at(p, "test/fc/roll-deg")),
            ("俯仰", |p| at(p, "test/fc/pitch-deg")),
        ];
        let sticks: &[Sample] = &[
            ("横滚", |p| Some(p.rc[0] * 100.)),
            ("俯仰", |p| Some(p.rc[1] * 100.)),
            ("偏航", |p| Some(p.rc[2] * 100.)),
            ("油门", |p| Some(p.rc[3] * 100.)),
        ];
        let marker = (result.status != "passed").then_some(result.elapsed);
        chart(&mut out, trace, 0, "水平速度", "m/s", horizontal, marker);
        out.push_str("<details><summary>相对高度、姿态与上位机杆量</summary>");
        chart(&mut out, trace, 1, "相对高度", "m", altitude, marker);
        chart(&mut out, trace, 2, "姿态", "°", attitude, marker);
        chart(&mut out, trace, 3, "上位机杆量", "%", sticks, marker);
        out.push_str("</details>");
        let _ = write!(out, "<p class=\"muted\">{} 个采样点 · 脚本时钟 · 记录间隔 {:.3} s · 缺失遥测以断线显示{}</p>",
            trace.len(), interval, if result.dry_run { " · 预演使用模拟反馈" } else { "" });
    }
    out.push_str("</div></section><section class=\"sheet\"><details class=\"section\"><summary>关键事件与退出确认</summary>");
    if result.logs.is_empty() {
        out.push_str("<p class=\"muted\">本次运行无事件记录。</p>");
    } else {
        let real_time = result.logs.iter().all(|log| log.run_elapsed.is_some());
        let clock = if real_time {
            "时间从测试启动起计，包含退出确认。"
        } else {
            "事件时间使用脚本时钟。"
        };
        let _ = write!(
            out,
            "<p class=\"muted\">{clock} 最多保留 2000 条。</p><ol class=\"events\">"
        );
        for entry in &result.logs {
            let class = if entry.level == "error" { "fail" } else { "" };
            let time = if real_time {
                entry.run_elapsed.unwrap_or(entry.time)
            } else {
                entry.time
            };
            let _ = write!(
                out,
                "<li class=\"{class}\"><time>{time:.2} s</time><span>{}</span></li>",
                escape(&entry.message)
            );
        }
        out.push_str("</ol>");
    }
    out.push_str("</details><details class=\"section\"><summary>运行环境与原始记录</summary><dl class=\"setup\">");
    if let Some(binding) = &result.binding {
        info(&mut out, "仿真模型", &binding.model);
        info(
            &mut out,
            "飞控 SYS / COMP",
            &format!("{} / {}", binding.system, binding.component),
        );
        info(
            &mut out,
            "飞控硬件 UID",
            binding.hardware_uid.as_deref().unwrap_or("未采集"),
        );
        if let Some(version) = binding.firmware_version {
            let [major, minor, patch, release] = version.to_be_bytes();
            info(
                &mut out,
                "飞控固件版本",
                &format!("{major}.{minor}.{patch} · 类型 {release}"),
            );
        }
    } else {
        if let Some(aircraft) = &result.aircraft_label {
            info(&mut out, "脚本机型标签", aircraft);
        }
        if !result.dry_run {
            info(&mut out, "飞控与仿真实例绑定", "未确认");
        }
    }
    if let Some(options) = options {
        info(&mut out, "控制发送频率", &format!("{} Hz", options.rate_hz));
        info(
            &mut out,
            "脚本时钟",
            if options.clock == "simulation" {
                "所选实例仿真时间"
            } else {
                "实时时钟"
            },
        );
    }
    if let Some(policy_name) = outcome.and_then(|value| value.policy.as_deref()) {
        info(&mut out, "实际退出策略", policy(policy_name));
    }
    let _ = write!(out, "</dl><p><a href=\"{}\" download>保存原始运行记录（JSON）</a></p></details></section></main>\
        <script>{JS}</script></body></html>", escape(json_file));
    out
}
