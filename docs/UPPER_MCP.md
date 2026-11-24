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
| `upper_nsh_command` | 通过现有工具箱 NSH 执行一条非交互命令，返回输出及成功标记；未解锁、新鲜双向连接，与测试和参数操作互斥 |
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
- 修改参数、重启、终端控制与测试控制需要互斥。不能让两套控制源同时修改同一架飞行器；界面原有写入限制继续生效。MCP NSH 复用现有交互终端，不打开原始 MAVLink 或独立设备连接；UI 中可取消当前 MCP 命令。
- 停止必须给当前测试 `id`；过期 id 不会停止后来的测试。未在 5 秒内被界面领取的启动请求会失效，不会在界面恢复后突然执行。已领取但超时的控制请求不自动重试，先查询当前状态。
- 退出 MCP 适配器只断开客户端。正常退出上位机仍走现有测试退出策略；上位机崩溃或强杀时，原飞控失联保护仍负责处理。

## 连接与认证

上位机启动时分配 `127.0.0.1` 的随机 TCP 端口，生成 256 bit 随机令牌，并将端点元数据原子写入权限 `0600` 的文件。适配器只接受本机端点，逐次读取文件，因此上位机重启后无需重启适配器，不会重放控制指令。令牌不进入 MCP 工具结果或界面展示。

此 TCP 协议是适配器与上位机之间的私有桥接，不是 HTTP MCP 服务。对客户端暴露的是标准 stdio MCP，按行读写 JSON-RPC，仅向 stdout 输出协议消息。协议协商支持 `2025-11-25`、`2025-06-18`、`2025-03-26` 与 `2024-11-05`；未实现 MCP Apps、HTTP/SSE 或公网访问。

参考：[MCP stdio 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

## NSH 命令

`upper_nsh_command({"command":"param show SYS_HITL","timeoutMs":10000})` 经主窗口路由到拥有连接的工具箱，复用同一个 Px4Shell、会话和 SYS/COMP。每次最多一条非交互命令、256 字符，超时 1～30 秒，输出最多 65536 字符并报告截断。返回 `succeeded` 来自命令后的唯一成功/失败标记，不伪造精确退出码。命令和回显也显示在工具箱 NSH 页。

测试、来源切换、参数/重启操作或另一条 NSH 命令进行中时拒绝执行；飞控已解锁、心跳过期、连接改变或终端没有回到空闲 `nsh>` 时也拒绝。超时不重放、不自动中断远端程序；显式 UI 取消只中断本次工具持有的命令。此前未被窗口领取的请求仍在 5 秒后失效。使用状态改变命令前应确认实际目标及任务授权。

新增工具需要运行包含此改动的上位机后端，并重新加载 stdio MCP 工具目录。已有对话若尚未发现新工具，可使用同一个 `tools/upper-mcp/server.py` 适配器与当前认证端点；它仍不拥有设备连接。

## 机载日志下载

`upper_list_logs({})` 复用 PX4 工具箱现有连接，返回 `logs` 列表及 SYS/COMP、连接会话和硬件 UID。读取需要新鲜、上锁的双向连接，且与测试、NSH、参数、刷写等操作互斥。

从列表取出原始的 `id`、`size`、`time` 后调用：

```json
{"id":3,"expectedSize":24273822,"expectedTime":1795438296}
```

将以上对象传给 `upper_download_log`。下载前重新核对列表，返回 `jobId` 后在后台继续；不等待完整文件，也不弹保存对话框。`upper_get_status` 的 `logDownload` 返回状态、已接收字节 `received`、已落盘字节 `savedBytes`、总字节、平均 `bytesPerSecond`、预计 `remainingSeconds` 和最终文件路径。

`upper_cancel_log_download({"jobId":1})` 取消相应任务；界面“取消下载”同样有效。取消和失败清理未完成文件，任务不会自动重启。上位机退出或连接失效不保留可恢复下载。下载期间若飞控解锁、重启、UID 或连接会话改变，传输会停止。最终再次验证机载日志身份、完整字节覆盖及 ULog 文件结构，只有成功完成后才发布 `.ulg` 文件并加入工具箱日志库。

完成文件保存在应用数据目录 `px4-logs/<独立任务目录>/px4_log_<编号>.ulg`，目录由上位机生成，不接受远程传入目标路径。单个日志上限为 512 MiB。接收器处理乱序、重复和丢包，在数据空闲时逐段补传；不会同时发出多个互相覆盖的 PX4 `LOG_REQUEST_DATA` 范围。文件写入以不超过 64 KiB 的分块执行。

### 仿真机 USB 固件升级

固件升级的 USB 连接现在由仿真机拥有。`upper_firmware_status` 返回带 `simulator` 地址的目标；`upper_firmware_prepare` 支持 `source=simulator`（默认）和 `local`；`upper_firmware_start` 必须带当前 `selectionId`、`simulator`、`port`；`upper_firmware_cancel` 带升级任务 `id`，仅取消等待 Bootloader。完整步骤见 [PX4 工具箱](px4-toolbox.md#px4-固件升级)。安装新仿真机固件、重启上位机并重新连接 MCP 后生效。控制请求不得自动重试。
