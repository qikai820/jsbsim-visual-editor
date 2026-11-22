#!/usr/bin/env bash
set -euo pipefail
voice_project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
voice_env_dir="${voice_project_dir}/.toolchains/voice"
voice_action="${1:-help}"
if (( $# )); then shift; fi
case "$voice_action" in
  install)
    voice_pip_args=()
    if (( $# )); then
      if [[ "$1" != '--wheel-dir' || $# != 2 || ! -d "$2" ]]; then
        echo '用法：install [--wheel-dir /path/to/offline-wheels]' >&2
        exit 2
      fi
      voice_pip_args=(--no-index --find-links "$2")
    fi
    python3 -m venv "$voice_env_dir"
    if ! "$voice_env_dir/bin/python" -m pip install "${voice_pip_args[@]}" -r "$voice_project_dir/tools/voice-service/requirements.txt"; then
      echo '语音识别依赖安装失败。请确认包源包含 faster-whisper 及其依赖，或使用 install --wheel-dir 指定完整的离线 wheel 目录。' >&2
      exit 1
    fi
    "$voice_env_dir/bin/python" -c 'import faster_whisper; print("语音识别依赖已就绪")'
    ;;
  asr)
    if [[ ! -x "$voice_env_dir/bin/python" ]] || ! "$voice_env_dir/bin/python" -c 'import faster_whisper' >/dev/null 2>&1; then
      echo '请先运行：bash scripts/voice-service.sh install' >&2
      exit 1
    fi
    exec "$voice_env_dir/bin/python" "$voice_project_dir/tools/voice-service/asr_server.py" \
      --download-root "$voice_env_dir/models" "$@"
    ;;
  check)
    command -v curl
    command -v pw-record || command -v arecord || echo '未检测到录音程序，文字指令仍可使用。'
    if [[ -x "$voice_env_dir/bin/python" ]] && "$voice_env_dir/bin/python" -c 'import faster_whisper' >/dev/null 2>&1; then
      "$voice_env_dir/bin/python" -c 'import faster_whisper; print("faster-whisper: available")'
    else
      echo '语音识别依赖尚未安装；可连接已有的兼容识别服务。'
    fi
    ;;
  help|--help|-h)
    printf '%s\n' '用法：bash scripts/voice-service.sh install|asr|check' \
      '离线安装：install --wheel-dir /absolute/path/to/wheels（包含所有依赖）' \
      'CPU：asr --model small --device cpu --compute-type int8' \
      'GPU：asr --model small --device cuda --compute-type float16' \
      '代理检查：asr --check-proxy（不下载、不监听端口）' \
      'ASR 模型首次使用会下载；离线部署可用 --model 指定已有模型目录，--name small 设置接口名称。' \
      '指令大模型连接独立的 Ollama 或 OpenAI 兼容服务，在上位机语音配置中填写。'
    ;;
  *) echo "未知操作：$voice_action" >&2; exit 2 ;;
esac
