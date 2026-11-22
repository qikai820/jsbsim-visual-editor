#!/usr/bin/env bash
set -euo pipefail
voice_test_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$voice_test_root"
voice_test_mode="${1:-offline}"
case "$voice_test_mode" in offline|ui|all) ;; *) echo '用法：bash scripts/test-voice.sh [offline|ui|all]' >&2; exit 2 ;; esac
if [[ -f .toolchains/env.sh ]]; then source .toolchains/env.sh; fi
if [[ "$voice_test_mode" != ui ]]; then
  cargo test --manifest-path src-tauri/Cargo.toml --test voice_assistant --offline
  node tests/voice-actions.mjs
  node tests/voice-runtime.mjs
  python3 tests/voice-asr-service.py
  if [[ -x .toolchains/voice/bin/python ]]; then
    .toolchains/voice/bin/python tests/voice-proxy.py
  else
    python3 tests/voice-proxy.py
  fi
  npx tsc --noEmit
fi
if [[ "$voice_test_mode" != offline ]]; then
  node --experimental-websocket tests/voice-assistant-ui.mjs
fi
echo '语音测试完成。模型推理准确率和真实麦克风/HIL 联调需单独验证。'
