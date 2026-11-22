#!/usr/bin/env bash
# Run from a normal Linux terminal: this suite needs localhost sockets and Chrome.
set -euo pipefail
PX4_EDITOR_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PX4_PROJECT_ROOT="$(cd -- "${PX4_EDITOR_ROOT}/.." && pwd)"
cd "${PX4_EDITOR_ROOT}"
if [[ -f .toolchains/env.sh ]]; then
  source .toolchains/env.sh
fi
export PX4_SITL_TEST_BUILD="${PX4_SITL_TEST_BUILD:-${PX4_PROJECT_ROOT}/build/px4_sitl_default}"
export PX4_SITL_TEST_OUTPUT="${PX4_SITL_TEST_OUTPUT:-${PX4_PROJECT_ROOT}/diagnostics/px4-sitl-host-test}"
mkdir -p "${PX4_SITL_TEST_OUTPUT}"

cargo test --offline --manifest-path src-tauri/Cargo.toml --test px4_sitl 2>&1 | tee "${PX4_SITL_TEST_OUTPUT}/unit.log"
npx tsc --noEmit 2>&1 | tee "${PX4_SITL_TEST_OUTPUT}/typescript.log"
node tests/px4-protocol.mjs 2>&1 | tee "${PX4_SITL_TEST_OUTPUT}/protocol.log"
node tests/px4-simulator-source.mjs 2>&1 | tee "${PX4_SITL_TEST_OUTPUT}/source.log"

# A socket permission failure is a blocked integration run, never a passing test.
python3 - <<'PY' 2>&1 | tee "${PX4_SITL_TEST_OUTPUT}/socket-permissions.log"
import socket, tempfile, pathlib, sys
try:
    for kind in (socket.SOCK_DGRAM, socket.SOCK_STREAM):
        with socket.socket(socket.AF_INET, kind) as sock:
            sock.bind(('127.0.0.1', 0))
    with tempfile.TemporaryDirectory(prefix='px4-sitl-permissions-') as folder:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.bind(str(pathlib.Path(folder) / 'check.sock'))
except OSError as error:
    print(f'BLOCKED: socket permission check failed: {error}')
    print('Run this script in a normal system terminal with localhost networking enabled.')
    sys.exit(2)
print('PASS: localhost UDP/TCP and Unix socket binding')
PY

# These opt-in tests exercise an occupied UDP port and the actual PX4 SIH binary.
cargo test --offline --manifest-path src-tauri/Cargo.toml --test px4_sitl -- --ignored --nocapture 2>&1 | tee "${PX4_SITL_TEST_OUTPUT}/integration.log"
node --experimental-websocket tests/px4-sitl-ui.mjs 2>&1 | tee "${PX4_SITL_TEST_OUTPUT}/ui.log"
npm run build 2>&1 | tee "${PX4_SITL_TEST_OUTPUT}/frontend-build.log"
printf 'PASS: PX4 launcher tests completed. Evidence: %s\n' "${PX4_SITL_TEST_OUTPUT}"
