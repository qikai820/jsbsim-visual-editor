"use strict";

for (const element of document.querySelectorAll("time[data-epoch]")) {
    const epoch = Number(element.dataset.epoch);
    if (epoch > 0) {
        const date = new Date(epoch);
        if (Number.isFinite(date.getTime())) {
            element.dateTime = date.toISOString();
            element.textContent = date.toLocaleString(undefined, {
                year: "numeric", month: "2-digit", day: "2-digit",
                hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
            });
        }
    }
}

const colorProbe = document.createElement("span");
colorProbe.hidden = true;
document.body.append(colorProbe);
function color(token) {
    colorProbe.style.color = "var(" + token + ")";
    return getComputedStyle(colorProbe).color;
}

const timeFormat = new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 2});
const linePatterns = [[], [6, 4], [2, 3], [8, 3, 2, 3]];
const charts = new Map();

function plot(canvas, series) {
    const {width, height} = canvas.getBoundingClientRect();
    if (width < 120 || !height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(dpr, dpr);

    let tMin = Infinity, tMax = -Infinity, vMin = 0, vMax = 0;
    for (const points of series) {
        for (const [t, value] of points) {
            if (value === null) continue;
            tMin = Math.min(tMin, t);
            tMax = Math.max(tMax, t);
            vMin = Math.min(vMin, value);
            vMax = Math.max(vMax, value);
        }
    }
    const marker = canvas.dataset.marker === "" ? null : Number(canvas.dataset.marker);
    if (!Number.isFinite(tMin)) return;
    if (marker !== null) {
        tMin = Math.min(tMin, marker);
        tMax = Math.max(tMax, marker);
    }
    if (tMax === tMin) tMax += 1;
    if (vMax === vMin) vMax += 1;

    const left = 46, right = width - 16, top = 12, bottom = height - 37;
    const x = t => left + (t - tMin) / (tMax - tMin) * (right - left);
    const y = v => bottom - (v - vMin) / (vMax - vMin) * (bottom - top);
    context.font = "12px system-ui";
    context.lineWidth = 1;
    context.strokeStyle = color("--line");
    context.fillStyle = color("--muted");
    context.textAlign = "right";
    context.textBaseline = "middle";

    for (let i = 0; i <= 4; i++) {
        const v = vMin + (vMax - vMin) * i / 4;
        context.beginPath();
        context.moveTo(left, y(v));
        context.lineTo(right, y(v));
        context.stroke();
        context.fillText(timeFormat.format(v), left - 6, y(v), left - 8);
    }
    context.textAlign = "center";
    const ticks = width < 400 ? 3 : 5;
    for (let i = 0; i < ticks; i++) {
        const t = tMin + (tMax - tMin) * i / (ticks - 1);
        context.fillText(timeFormat.format(t), x(t), bottom + 12, (right - left) / (ticks - 1));
    }
    context.fillText("脚本时间 (s)", (left + right) / 2, bottom + 29);

    if (marker !== null) {
        context.strokeStyle = color("--red");
        context.setLineDash([3, 4]);
        context.beginPath();
        context.moveTo(x(marker), top);
        context.lineTo(x(marker), bottom);
        context.stroke();
    }
    series.forEach((points, index) => {
        const stroke = color("--series-" + index);
        context.strokeStyle = stroke;
        context.fillStyle = stroke;
        context.lineWidth = 1.75;
        context.setLineDash(linePatterns[index]);
        let previous = null;
        context.beginPath();
        for (const [t, value] of points) {
            if (value === null) {
                previous = null;
                continue;
            }
            if (previous === null) context.moveTo(x(t), y(value));
            else context.lineTo(x(t), y(value));
            previous = value;
        }
        context.stroke();
        context.setLineDash([]);
        for (let i = 0; i < points.length; i++) {
            const [t, value] = points[i];
            if (value !== null && points[i - 1]?.[1] == null && points[i + 1]?.[1] == null) {
                context.beginPath();
                context.arc(x(t), y(value), 2.5, 0, Math.PI * 2);
                context.fill();
            }
        }
    });
}

const observer = new ResizeObserver(entries => {
    for (const entry of entries) plot(entry.target, charts.get(entry.target));
});
for (const canvas of document.querySelectorAll("canvas[data-series]")) {
    charts.set(canvas, JSON.parse(canvas.dataset.series));
    observer.observe(canvas);
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    for (const [canvas, series] of charts) plot(canvas, series);
});
