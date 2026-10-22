#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Use the checkout-local Node.js and Rust toolchains when available, so this
# launcher does not depend on globally installed npx/cargo binaries.
if [ -f "${SCRIPT_DIR}/.toolchains/env.sh" ]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/.toolchains/env.sh"
fi

# Keep the original Tauri entry point, but default it to the external HIL
# setup: JSBSim is owned by px4-jsbsim-bridge, while this app is the ground
# station.  All values remain overridable for local-only JSBSim testing.
export JSBSIM_ROOT="${JSBSIM_ROOT:-${WORKSPACE_DIR}/jsbsim}"
export JSBSIM_BIN="${JSBSIM_BIN:-${JSBSIM_ROOT}/build/src/JSBSim}"
export SIM_EXTERNAL="${SIM_EXTERNAL:-1}"
export SIM_UDP_PORT="${SIM_UDP_PORT:-5801}"
export SIM_UDP_CTRL_PORT="${SIM_UDP_CTRL_PORT:-5802}"
# SIM_UDP_HOST and NUTTX_FTP_URL may be set explicitly. Without them the
# editor discovers the board on the Ethernet interface at runtime.
export NUTTX_FTP_USER="${NUTTX_FTP_USER:-root}"
export NUTTX_FTP_PASSWORD="${NUTTX_FTP_PASSWORD:-abc123}"

cd "${SCRIPT_DIR}"

# Closing the native window can leave Vite running. Starting a second Vite
# then fails because strictPort is enabled, taking Tauri down with it. Reuse
# only a listener owned by this checkout's Vite; never kill an unrelated app
# or silently connect the editor to another checkout's frontend.
if command -v ss >/dev/null && command -v curl >/dev/null; then
  DEV_URL="$(node -p 'require("./src-tauri/tauri.conf.json").build.devUrl')"
  DEV_PORT="$(node -e 'const url = new URL(process.argv[1]); console.log(url.port || (url.protocol === "https:" ? 443 : 80))' "${DEV_URL}")"
  SERVER_PID="$(ss -H -ltnp "sport = :${DEV_PORT}" 2>/dev/null |
    sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u)"

  if [[ "${SERVER_PID}" =~ ^[0-9]+$ ]] &&
     [[ "$(readlink -f "/proc/${SERVER_PID}/cwd" 2>/dev/null)" == "${SCRIPT_DIR}" ]] &&
     [[ -r "/proc/${SERVER_PID}/cmdline" ]]; then
    SERVER_ARGS=()
    mapfile -d '' -t SERVER_ARGS < "/proc/${SERVER_PID}/cmdline"
    for arg in "${SERVER_ARGS[@]}"; do
      if [[ "${arg}" == "${SCRIPT_DIR}/node_modules/.bin/vite" ||
            "${arg}" == "${SCRIPT_DIR}/node_modules/vite/bin/vite.js" ]]; then
        if curl --noproxy '*' --fail --silent --max-time 2 \
          "${DEV_URL%/}/@vite/client" >/dev/null; then
          echo "复用当前项目的页面服务（端口 ${DEV_PORT}），正在打开上位机…"
          exec npx tauri dev --config '{"build":{"beforeDevCommand":""}}' "$@"
        fi
        break
      fi
    done
  fi
fi

exec npx tauri dev "$@"
