#!/usr/bin/env bash
# Install launchers for this checkout into the current user's desktop and menu.
set -euo pipefail

EDITOR_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == "--help" ]]; then
  echo "用法：./install-desktop.sh"
  echo "为当前项目安装“JSBSim 上位机”桌面快捷方式和应用菜单入口，无需 sudo。"
  exit 0
fi
if (( $# )); then
  echo "不支持的参数：$1" >&2
  exit 2
fi

DESKTOP_DIR="$(xdg-user-dir DESKTOP)"
APPLICATIONS_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"
LAUNCHER_NAME="JSBSim-Visual-Editor.desktop"
LAUNCHER_FILE="$(mktemp --suffix=.desktop)"
trap 'rm -f -- "$LAUNCHER_FILE"' EXIT

[[ -x "${EDITOR_DIR}/run-tauri.sh" ]]
[[ -f "${EDITOR_DIR}/src-tauri/icons/128x128@2x.png" ]]

python3 - "$EDITOR_DIR" > "$LAUNCHER_FILE" <<'PY'
import sys
from pathlib import Path

root = Path(sys.argv[1])
launcher = str(root / "run-tauri.sh")

def value(text):
    return str(text).replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")

# Exec quoting is applied before desktop-entry string escaping.
quoted = '"' + ''.join('\\' + c if c in '\\"`$' else c for c in launcher) + '"'
fields = {
    "Version": "1.0",
    "Type": "Application",
    "Name": "JSBSim 上位机",
    "Comment": "启动当前项目的 JSBSim Visual Editor 上位机",
    "Exec": quoted.replace("%", "%%"),
    "TryExec": launcher,
    "Path": root,
    "Icon": root / "src-tauri/icons/128x128@2x.png",
    "Terminal": "true",
    "Categories": "Development;",
    "Keywords": "JSBSim;仿真;上位机;",
    "StartupNotify": "true",
}
print("[Desktop Entry]")
for key, text in fields.items():
    print(f"{key}={value(text)}")
PY

if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "$LAUNCHER_FILE"
fi
mkdir -p -- "$DESKTOP_DIR" "$APPLICATIONS_DIR"
install -m 755 -- "$LAUNCHER_FILE" "${DESKTOP_DIR}/${LAUNCHER_NAME}"
install -m 644 -- "$LAUNCHER_FILE" "${APPLICATIONS_DIR}/${LAUNCHER_NAME}"

if ! gio set "${DESKTOP_DIR}/${LAUNCHER_NAME}" metadata::trusted true; then
  echo "桌面未能自动设置启动信任，请右键快捷方式选择“允许启动”。" >&2
fi
if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$APPLICATIONS_DIR"
fi
printf '已安装：%s\n' "${DESKTOP_DIR}/${LAUNCHER_NAME}" "${APPLICATIONS_DIR}/${LAUNCHER_NAME}"
