# 上位机 MCP

第一版通过 stdio MCP 接入正在运行的 JSBSim Visual Editor。外部适配器只连上位机的本机 TCP 接口，不打开 USB、UDP 14553 或视景 UDP 5801，不启动第二套飞控测试引擎。

```mermaid
flowchart LR
  UI[上位机界面] --> S[共享会话与测试引擎]
  AI[MCP 客户端] --> P[Python stdio 适配器]
  P --> B[本机认证接口]
  B -->|读取缓存| S
  B -->|启动与停止：经过界面操作流程| UI
  S --> L[现有飞控与仿真链路]
```

## 使用

1. 启动包含此改动的新上位机；右上角出现 **MCP**，悬停可看端点文件位置，点击可打开工具箱。
2. 在 PX4 工具箱建立正常的双向 HIL 连接，选择要测试的实例。工具箱隐藏后连接继续保留。
3. 在支持本地 stdio MCP 的客户端中添加：

```json
{
  "mcpServers": {
    "jsbsim-upper": {
      "command": "python3",
      "args": ["/home/qikai820/src/jsbsim-visual-editor/tools/upper-mcp/server.py"]
    }
  }
}
```

客户端采用其他配置格式时，填同样的可执行命令与参数。适配器无需安装第三方 Python 包。Python 最低版本为 3.10。使用 `--endpoint /absolute/path/mcp-endpoint.json` 或 `JSBSIM_MCP_ENDPOINT` 可指定其他应用数据目录。Linux 默认路径是 `~/.local/share/com.jsbsim.visual-editor/mcp-endpoint.json`，遵循 `XDG_DATA_HOME`。

Codex 使用 TOML 配置，对应片段如下。`tool_timeout_sec` 设为 180，以容纳停止测试时等待降落的过程。

```toml
[mcp_servers.jsbsim-upper]
command = "python3"
args = ["/home/qikai820/src/jsbsim-visual-editor/tools/upper-mcp/server.py"]
startup_timeout_sec = 10
tool_timeout_sec = 180
```

也可用 `codex mcp add jsbsim-upper -- python3 /home/qikai820/src/jsbsim-visual-editor/tools/upper-mcp/server.py` 注册，再在该项补上超时配置。配置位置与加载规则见 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。配置不会把新工具自动注入已经运行的本次工具调用清单；客户端重新加载后以实际出现的 `upper_*` 工具为准。

接口提供：

| 工具 | 行为 |
|---|---|
| `upper_get_status` | 读取现有飞控/视景缓存、数据年龄、测试进度与最近调用；不追加飞控遥测请求 |
| `upper_list_scripts` | 列出当前上位机构建内置的脚本 |
| `upper_get_script` | 读取指定内置脚本 XML |
| `upper_validate_script` | 解析 XML，不控制飞控 |
| `upper_start_test` | 使用当前工具箱实例与连接启动共享测试；显式指定 `dryRun` |
| `upper_stop_test` | 按测试 `id` 停止，等待现有退出策略完成 |
| `upper_get_report` | 读取已退出测试的结果，轨迹分页，每页最多 1000 点 |
| `upper_save_report` | 将完整记录保存到应用数据目录 `test-reports`，返回绝对路径 |

例如先调用 `upper_get_status` 核对缓存年龄、模型、实例、HIL 与上锁状态，然后用 `upper_validate_script({"script":"morphquad_complete"})` 校验当前构建内置的 MorphQuad 完整脚本。`upper_start_test({"script":"morphquad_complete","dryRun":true})` 只干跑；只有明确指定 `false` 才会进入现有 HIL 控制流程。也可以传 `source` XML，`source` 与 `script` 二选一。

MCP 启动默认采用 50 Hz、实时时钟及完整 RC 遥控器模拟，完成和中止均降落。主杆、油门、AUX 和开关统一走 `RC_CHANNELS_OVERRIDE → rc_update → SOURCE_RC`，不要求 HIL 专用固件接口。它不覆盖用户编辑的脚本，也不自动修改飞控参数；已有引擎的来源绑定、硬件 UID、HIL 与实例检查继续生效。所有脚本均不限制 `COM_RC_IN_MODE` 的取值。没有新增自定义固件检测。

## 共享操作规则

- 查看视景、查询状态、编辑本地模型不占有控制权。查询返回缓存年龄，断线缓存不会被当成实时状态。
- UI 与 MCP 共用一个测试引擎，已有测试时拒绝第二次启动。启动经过同一个 `beforeRun` 流程，关闭 NSH 并停止元数据加载；其他飞控操作忙碌时拒绝启动。
- 运行中界面显示 **MCP 发起**，工具箱与视景仍能查看并终止同一个测试。MCP 断开不停止测试，主杆发送仍由上位机自己的线程负责。
- 修改参数、重启、终端控制与测试控制需要互斥。不能让两套控制源同时修改同一架飞行器；界面原有写入限制继续生效。第一版 MCP 不提供任意控制台、原始 MAVLink 写入或独立连接工具。
- 停止必须给当前测试 `id`；过期 id 不会停止后来的测试。未在 5 秒内被界面领取的启动请求会失效，不会在界面恢复后突然执行。已领取但超时的控制请求不自动重试，先查询当前状态。
- 退出 MCP 适配器只断开客户端。正常退出上位机仍走现有测试退出策略；上位机崩溃或强杀时，原飞控失联保护仍负责处理。

## 连接与认证

上位机启动时分配 `127.0.0.1` 的随机 TCP 端口，生成 256 bit 随机令牌，并将端点元数据原子写入权限 `0600` 的文件。适配器只接受本机端点，逐次读取文件，因此上位机重启后无需重启适配器，不会重放控制指令。令牌不进入 MCP 工具结果或界面展示。

此 TCP 协议是适配器与上位机之间的私有桥接，不是 HTTP MCP 服务。对客户端暴露的是标准 stdio MCP，按行读写 JSON-RPC，仅向 stdout 输出协议消息。协议协商支持 `2025-11-25`、`2025-06-18`、`2025-03-26` 与 `2024-11-05`；未实现 MCP Apps、HTTP/SSE 或公网访问。

参考：[MCP stdio 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。
