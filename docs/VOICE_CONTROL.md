# 大模型语音操作

入口：上位机右上角 **🎙 语音**，或 **工具 → 大模型语音操作**。
**本地配置 → 配置语音** 可直接进入服务配置。配置保存后立即生效。

这是一套按键录音的语音指令流程：

1. 点击“开始录音”，使用当前电脑的默认麦克风；点击“停止并识别”，或等待录音上限。
2. 识别文字出现在编辑框，发送给配置的指令大模型。也可直接输入文字测试。
3. 状态查询、目录列表和打开界面直接执行。改变仿真状态的操作显示具体预览。
4. 点击“执行上述操作”，通过上位机原有接口执行，逐项显示实际结果。
5. 启用兼容 TTS 服务后可播报结果；播放被系统阻止时可手动点击“播放播报”。

识别、大模型和播报使用分别配置的服务。默认全部连接回环地址，可改为局域网或
云端服务；音频与文字只会在用户发出指令后发送给配置的对应服务。
应用默认关闭语音功能，不后台监听、不启动第二套飞控连接。

## 本机服务准备

支持已有的 Ollama `/api/chat`、OpenAI 兼容 `/v1/chat/completions`，以及
OpenAI 兼容音频转写接口。已有模型服务时可直接填写地址，无需安装附带服务。

工程附带一个只处理 WAV 的 faster-whisper 识别服务。默认 CPU int8，可在普通电脑使用：

```sh
cd /home/qikai820/chatgpt_pro/jsbsim_nuttx/jsbsim-visual-editor
bash scripts/voice-service.sh check
bash scripts/voice-service.sh install
bash scripts/voice-service.sh asr --model small --device cpu --compute-type int8
```

包源受限时，可以在相同系统、架构和 Python 版本的联网电脑准备完整 wheel 目录，再离线安装：

```sh
python3 -m pip download -d /path/to/wheels -r tools/voice-service/requirements.txt
bash scripts/voice-service.sh install --wheel-dir /path/to/wheels
```

安装失败会明确报错；仅有虚拟环境而缺少识别依赖时，不会被当作已安装。

启动时会在 ASR 子进程中将旧式 `socks://` 代理地址兼容为 `socks5://`，不改动终端或系统设置。
当 HTTP 和 HTTPS 都已配置 HTTP(S) 代理时，忽略多余的 `ALL_PROXY` SOCKS 兜底，保留下载代理。
实际使用 SOCKS 时需要 `socksio` 和 `PySocks`；已有环境缺少它们时重新运行 `install` 即可补齐。
可先检查代理与已安装的下载客户端，检查不发起网络请求、不下载模型，也不监听端口：

```sh
bash scripts/voice-service.sh asr --check-proxy
```

依赖安装到工程的 `.toolchains/voice`，模型缓存放在该目录的 `models` 中。
模型 ID 首次使用需要下载模型；离线部署可指定已有目录：

```sh
bash scripts/voice-service.sh asr --model /absolute/path/faster-whisper-small --name small
```

识别服务直接将已校验的 PCM WAV 转换为 16 kHz 单声道浮点采样，再送给模型；
避免 faster-whisper 1.2.1 与 PyAV 19 在 `metadata_errors` 解码参数上的不兼容。
更新服务代码后，需要在 ASR 终端按 Ctrl+C 并重新启动，已有模型无需重新下载。

使用 CUDA 时，需先具备 faster-whisper 所需的 CUDA/cuDNN 运行库，再选择
`--device cuda --compute-type float16`。上位机不直接驱动 GPU 或 NPU；推理设备由各服务决定。
本次没有自动下载大模型权重或变更系统推理环境。

已有 Ollama 时，在单独终端启动 `ollama serve`，并确保所选指令模型已部署。
配置中的 `qwen3:4b` 是可修改的默认名称；不要求电脑必须使用该模型。
也可填写现有 llama.cpp、vLLM 或其他兼容服务，选择 OpenAI 兼容协议。

识别服务已显示 `ready` 后，可在另一个本机终端一键准备本地指令模型、启用配置并测试：

```sh
bash scripts/setup-local-voice.sh --test-mic
```

脚本复用已有的 `127.0.0.1:11434` 服务；没有时从 Ollama 官方下载 Linux 运行包到
工程 `.toolchains/ollama`，无需 sudo，只监听回环地址，并下载缺少的 `qwen3:4b`。
通过上位机生产代码检查两个服务和真实模型的查询、目录及取消指令后，才保存配置。
`--model` 可指定其他已选模型。配置沿用已有设置，更改启用状态、本地 LLM/ASR 地址、模型、
中文识别、JSON 输出及 180 秒请求超时；LLM 改用本地无认证服务，原有 ASR Key 保留。
`--test-mic` 在终端确认后录音 5 秒，请说“查询当前仿真状态”，测试真实转写和严格动作解析；
不加该参数只测试文字解析及服务。所有测试都不执行仿真控制动作。
麦克风失败时已保存的配置仍可使用，录音临时文件自动删除。
完成后关闭并重新打开语音面板，避免旧界面设置覆盖新配置。
脚本启动的 Ollama 不注册系统服务，注销或重启后需重新运行脚本；已有系统服务保持原状。

| 配置项 | 默认值 |
| --- | --- |
| 大模型协议 | Ollama |
| 大模型基础地址 | `http://127.0.0.1:11434` |
| 指令模型 | `qwen3:4b`，需已部署或修改为服务中的名称 |
| 识别协议 | OpenAI 兼容转写 |
| 识别基础地址 | `http://127.0.0.1:8178/v1` |
| 识别模型 | `small`，与服务暴露的名称相同 |
| 麦克风 | 系统默认，优先 `pw-record`，其次 `arecord` |
| 录音 | 16 kHz / 单声道 / 16 bit WAV，默认上限 30 秒 |
| 结果播报 | 默认关闭，可填写兼容 `/v1/audio/speech` 的服务 |

默认麦克风不正确时，可在系统声音设置选择输入设备，或填写录音设备：
`pw-record` 使用 PipeWire 目标；`arecord` 使用 ALSA 设备名称。
缺少录音程序时安装 PipeWire 工具或 `alsa-utils`，文字指令仍可使用。

点击“检查服务连接”会检查大模型列表及识别服务 `/health`，并提示所选模型是否存在。
部分第三方识别服务没有健康检查接口，检查失败不等于转写接口一定不可用，应实际录音确认。
语音播报按 `response_format=wav` 请求音频，模型和音色名称按所接服务填写。

## 可执行范围

| 示例 | 操作 |
| --- | --- |
| 查询当前状态 | 读取当前仿真连接和运行模型 |
| 有哪些模型／脚本 | 读取当前仿真机目录 |
| 载入 ball | 在编辑器载入已有模型 |
| 启动 ball | 启动模型，沿用原有模型同步流程 |
| 用 F450_PX4_lan.xml 启动 F450_PX4 | 校验脚本关联机型后运行地面脚本 |
| 暂停／继续／停止／重新运行仿真 | 使用原有生命周期接口 |
| 打开视景／日志／PX4 工具箱 | 打开对应界面 |
| 启动／停止软件飞控 | 使用软件飞控页已保存的配置 |
| 干跑当前测试脚本 | 通过共享测试引擎预演，不控制飞控 |
| 运行当前真实仿真测试 | 预览确认后使用当前脚本，保留原有 HIL 和控制源检查 |
| 结束当前测试 | 按当前测试标识退出，保留已有退出策略 |

本版模型控制针对实例 01；多实例时需先切回 01。不会直接通过语音解锁、起飞、
修改飞控参数、执行终端命令或生成并执行任意脚本。飞行动作使用用户在工具箱中准备的测试脚本。
这不是全双工实时语音或唤醒词监听；语音和文字共用同一套操作解析及执行流程。

## 操作与数据

动作采用固定白名单和严格参数校验，模型没有任意代码执行权限。
每个预览最多四步、有效 60 秒；执行前重新检查实例、模型、连接、测试脚本摘要和
软件飞控配置及仿真机地址、已知飞控标识。状态发生变化时拒绝旧预览。一步失败后停止，不自动重试，也不回滚已完成步骤。
取消会终止识别／大模型请求并阻止后续步骤；先到达的取消也会阻止尚未开始的同一请求。已经提交到仿真接口的步骤可能完成。

录音仅保存在当前电脑的私有临时目录，识别结束、取消或退出后删除。
录音时间上限由原生进程独立约束，即使界面失去响应也不会无限录音。
本机识别服务不保存录音、识别文字或认证头，静音会直接返回空文字。
API Key 保存在当前用户的 `voice-assistant.json`（Linux 权限 0600），不进入
浏览器 localStorage、命令参数或操作日志。可选识别服务认证使用 `VOICE_ASR_API_KEY` 环境变量。

## 验证

运行 `npm run test:voice` 执行无需套接字和真实设备的完整离线测试。
`bash scripts/test-voice.sh ui` 单独执行浏览器测试，`all` 执行两者；浏览器模式需要允许本机套接字。

```sh
cargo test --manifest-path src-tauri/Cargo.toml --test voice_assistant --offline
node tests/voice-actions.mjs
node tests/voice-runtime.mjs
python3 tests/voice-asr-service.py
.toolchains/voice/bin/python tests/voice-proxy.py
.toolchains/voice/bin/python tests/voice-asr-audio.py
node --experimental-websocket tests/voice-assistant-ui.mjs
npm run build
```

自动测试验证动作白名单、配置私密性、过期及目标变化拦截、取消和失败时不重试、
音频格式及分段上传。运行时集成测试直接加载真实 IPC 适配与共享测试状态，
只替换原生服务响应；识别服务集成测试通过内存中的 HTTP 连接执行真实请求处理器，
覆盖认证、模型不匹配、忙碌、静音和无效 WAV 等分支，不需要下载模型。界面测试使用模拟服务，不打开真实麦克风、不控制飞控。
真实语音准确率、推理速度、音频播放和 HIL 操作需要在具备麦克风、模型及服务的电脑联调。

协议参考：[Ollama Chat](https://docs.ollama.com/api/chat)、
[Ollama 兼容接口](https://docs.ollama.com/api/openai-compatibility)、
[faster-whisper](https://github.com/SYSTRAN/faster-whisper)。
