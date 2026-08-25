#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Keep the original Tauri entry point, but default it to the external HIL
# setup: JSBSim is owned by px4-jsbsim-bridge, while this app is the ground
# station.  All values remain overridable for local-only JSBSim testing.
export JSBSIM_ROOT="${JSBSIM_ROOT:-${WORKSPACE_DIR}/jsbsim}"
export JSBSIM_BIN="${JSBSIM_BIN:-${JSBSIM_ROOT}/build/src/JSBSim}"
export SIM_EXTERNAL="${SIM_EXTERNAL:-1}"
export SIM_UDP_PORT="${SIM_UDP_PORT:-5801}"
export SIM_UDP_CTRL_PORT="${SIM_UDP_CTRL_PORT:-5802}"

cd "${SCRIPT_DIR}"
exec npx tauri dev
