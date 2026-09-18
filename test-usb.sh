#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "${SCRIPT_DIR}/.toolchains/env.sh" ]; then
  # shellcheck source=/dev/null
  source "${SCRIPT_DIR}/.toolchains/env.sh"
fi

cd "${SCRIPT_DIR}/src-tauri"
exec cargo run --quiet -- --usb-self-test
