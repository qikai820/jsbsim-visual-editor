#!/usr/bin/env bash
# Install only in the project; save app settings through its native config code.
set -euo pipefail
voice_setup_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
voice_setup_model='qwen3:4b'
voice_setup_mic=0
while (( $# )); do
  case "$1" in
    --test-mic) voice_setup_mic=1; shift ;;
    --model)
      if (( $# < 2 )); then echo '--model 需要模型名称' >&2; exit 2; fi
      voice_setup_model="$2"; shift 2 ;;
    -h|--help)
      printf '%s\n' '用法：bash scripts/setup-local-voice.sh [--model qwen3:4b] [--test-mic]' \
        '复用或安装本机 Ollama，下载模型，通过上位机原生代码验证服务并保存语音配置。' \
        'Ollama 安装到工程 .toolchains/ollama，无需 sudo，只监听 127.0.0.1:11434。' \
        '--test-mic：终端确认后录音 5 秒，测试真实识别→大模型解析；不执行仿真动作。' \
        '需要保持已启动的 small ASR 服务运行。已有配置仅更改本地语音相关字段。'
      exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
if [[ ! "$voice_setup_model" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$ ]]; then
  echo '模型名称无效' >&2; exit 2
fi
if [[ "$voice_setup_mic" == 1 && ! -t 0 ]]; then
  echo '麦克风测试需要交互终端，请在本机终端执行。' >&2; exit 2
fi
cd "$voice_setup_root"
python3 - <<'PY'
import socket, sys
try:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM):
        pass
except PermissionError:
    sys.exit('当前执行环境禁止本地套接字，请在你自己的终端运行本脚本。')
PY
for voice_setup_command in curl tar zstd python3; do
  command -v "$voice_setup_command" >/dev/null || { echo "缺少 $voice_setup_command" >&2; exit 1; }
done
if [[ -f .toolchains/env.sh ]]; then source .toolchains/env.sh; fi
command -v cargo >/dev/null || { echo '缺少工程 Rust 工具链，请先完成上位机构建环境配置。' >&2; exit 1; }
curl --disable --noproxy '*' --fail --silent --show-error --max-time 8 \
  http://127.0.0.1:8178/health | python3 -c \
  'import json,sys; v=json.load(sys.stdin); sys.exit(0 if v.get("ready") is True and v.get("model")=="small" else "ASR 尚未就绪或不是 small 模型")'
voice_setup_dir="$voice_setup_root/.toolchains/ollama"
mkdir -p "$voice_setup_dir"
if ! curl --disable --noproxy '*' --fail --silent --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null; then
  voice_setup_binary="$(command -v ollama || true)"
  if [[ -z "$voice_setup_binary" && -x "$voice_setup_dir/runtime/bin/ollama" ]]; then
    voice_setup_binary="$voice_setup_dir/runtime/bin/ollama"
  fi
  if [[ -z "$voice_setup_binary" ]]; then
    case "$(uname -m)" in
      x86_64) voice_setup_arch=amd64 ;;
      aarch64|arm64) voice_setup_arch=arm64 ;;
      *) echo '此脚本仅支持 Linux x86_64 / ARM64。' >&2; exit 1 ;;
    esac
    echo '[配置] 从 Ollama 官方下载本机运行包；下载可续传。'
    curl --disable --fail --location --retry 3 --connect-timeout 20 --continue-at - \
      --output "$voice_setup_dir/ollama-linux.tar.zst.part" \
      "https://ollama.com/download/ollama-linux-${voice_setup_arch}.tar.zst"
    voice_setup_stage="$(mktemp -d "$voice_setup_dir/install.XXXXXX")"
    trap 'if [[ -n "${voice_setup_stage:-}" && -d "$voice_setup_stage" ]]; then rm -r -- "$voice_setup_stage"; fi' EXIT
    tar --zstd -xf "$voice_setup_dir/ollama-linux.tar.zst.part" -C "$voice_setup_stage"
    test -x "$voice_setup_stage/bin/ollama"
    if [[ -e "$voice_setup_dir/runtime" ]]; then
      echo '已有不完整 runtime 目录，请检查后重试；未覆盖该目录。' >&2; exit 1
    fi
    mv -- "$voice_setup_stage" "$voice_setup_dir/runtime"
    voice_setup_stage=''
    rm -- "$voice_setup_dir/ollama-linux.tar.zst.part"
    voice_setup_binary="$voice_setup_dir/runtime/bin/ollama"
  fi
  echo '[配置] 启动 Ollama，仅监听本机 127.0.0.1:11434。'
  nohup env OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS="$voice_setup_dir/models" \
    "$voice_setup_binary" serve </dev/null >"$voice_setup_dir/server.log" 2>&1 &
  voice_setup_pid=$!
  for ((voice_setup_wait=0; voice_setup_wait<120; voice_setup_wait++)); do
    if curl --disable --noproxy '*' --fail --silent --max-time 1 http://127.0.0.1:11434/api/tags >/dev/null; then break; fi
    if ! kill -0 "$voice_setup_pid" 2>/dev/null; then
      echo "Ollama 启动失败，请查看 $voice_setup_dir/server.log" >&2; exit 1
    fi
    sleep 0.5
  done
  curl --disable --noproxy '*' --fail --silent --show-error --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null
fi
echo "[配置] 检查并准备指令模型：$voice_setup_model"
python3 - "$voice_setup_model" <<'PY'
import json, sys, urllib.request
model = sys.argv[1]
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with client.open('http://127.0.0.1:11434/api/tags', timeout=8) as response:
    names = {v.get('name') for v in json.load(response).get('models', [])}
if model in names or model + ':latest' in names:
    print('[配置] 模型已存在，跳过下载。', flush=True)
else:
    request = urllib.request.Request('http://127.0.0.1:11434/api/pull',
        data=json.dumps({'model': model, 'stream': True}).encode(),
        headers={'Content-Type': 'application/json'})
    last = None
    success = False
    with client.open(request, timeout=1800) as response:
        for line in response:
            item = json.loads(line)
            if item.get('error'):
                sys.exit('模型下载失败，请检查 Ollama 日志和网络连接。')
            status = item.get('status', '')
            progress = int(item.get('completed', 0) / item['total'] * 10) * 10 if item.get('total') else None
            current = (status, progress)
            if current != last:
                print('[模型] ' + status + (f' {progress}%' if progress is not None else ''), flush=True)
                last = current
            success = status == 'success'
    if not success:
        sys.exit('模型下载未完成，未更改上位机配置。')
PY
export JSBSIM_VOICE_SETUP_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/com.jsbsim.visual-editor/voice-assistant.json"
export JSBSIM_VOICE_SETUP_MODEL="$voice_setup_model"
export JSBSIM_VOICE_SETUP_MIC="$voice_setup_mic"
cargo test --manifest-path src-tauri/Cargo.toml --test voice_assistant --offline \
  voice::tests::configure_and_test_local_services -- --ignored --exact --nocapture
echo '[配置] 完成。关闭并重新打开上位机的语音面板，让界面加载已保存配置。'
echo '[配置] 本脚本启动的 Ollama 在注销或重启后需重新运行本脚本启动；已有系统服务不受影响。'
