# PX4 工具箱

从「工具 → PX4 工具箱 · 参数 / 日志 / NSH」打开。工具箱自动接收**仿真机已有的 MAVLink 转发数据**，没有独立连接按钮，也不在电脑上另开飞控 USB 串口。

## 数据入口

- 默认自动监听仿真机**开机常驻转发服务的 UDP 14553**，没有加载模型也可读取飞控。切换模型或实例不会重建该通道，参数和 NSH 会话保持。
- 转发模块已从画布和部件库移除；旧缓存和导入 XML 不再生成转发节点，保存模型时移除旧的 `MAVLINK_FORWARD` 输入。
- PX4 目标 SYS/COMP 从心跳识别；取得仿真机地址时只接受该主机的数据。识别后固定 UDP 回传来源，其他发送端不能改变参数、日志或终端指令的回传目标。
- 当前入口使用网络转发。UDP 端口被其他程序占用时会显示明确错误；QGC 和工具箱分别使用不同端口。

### 与 QGC 同时使用

仿真机独立 `mavlink_router` 任务共享现有 USB 读取线程，向电脑发送两路完整报文：
QGC 使用 UDP 14550，工具箱使用 UDP 14553，两路均支持指令回传。
关闭编辑器不影响 QGC，单个客户端退出也不影响另一客户端。
QGC 普通 UDP 连接不要勾选“高延迟链路”。

板端持久配置位于 `/mnt/home/mavlink-router.conf`，与模型 XML 无关：

```ini
device=/dev/ttyACM0
baud=921600
host=192.168.3.109
qgc_port=14550
toolbox_port=14553
```

在工具箱的 **转发设置** 页读取和管理板端服务：

- 显示独立服务状态、仿真机地址，以及 QGC/工具箱两路累计收发字节和错误。
- 修改 USB 设备、波特率、目标电脑 IPv4、QGC UDP 端口和工具箱 UDP 端口。
- “保存并应用”在同一仿真机执行保存前比较、暂存回读、替换及最终回读；运行中的服务重新启动，停止的服务保持停止。工具箱自动采用实际运行端口。
- 配置变化或目标仿真机变化会拒绝过期保存；应用失败会尝试恢复旧配置、重新启动并核对实际运行配置。
- “停止服务”只停止本次运行的转发，仿真机重启仍会自动启动。未保存修改时须先保存或放弃修改，再启停服务。

转发设置不再写入模型 XML，无需重载模型。板端仍可通过 `jsbsim router status`、
`jsbsim router stop`、`jsbsim router start` 管理。服务关闭继承的管理会话句柄，
停止转发后保留任务组，避免中断仍被 HIL 使用的共享 USB 线程。

## 参数

获取和修改 PX4 参数，支持完整列表、缺失索引重试、全局搜索、收藏、固件类别/分组、前缀分组及本机自定义分组。选中参数后，在详情区输入新值或选择枚举，点击“写入飞控”；使用默认值只填充输入框。写入采用 PARAM_SET，收到目标参数的 PARAM_VALUE 后，再通过 PARAM_REQUEST_READ 按名称独立回读；值一致才提示成功并更新列表。超时重试，拒绝、断开或回读不符会显示明确结果，未确认时须重新读取核实。此操作不会自动重启飞控。

整型按实际参数类型与飞控编码写入，浮点型按 FLOAT32 精度确认。输入须符合参数类型；匹配飞控的元数据还约束数值范围及只读属性，并提示重启要求。内置参考库的范围只供参考。`.params` 导出使用 QGC 的 SYS、COMP、名称、值、类型列格式，部分读取会在文件头标明。

分组与说明参考 QGC 的元数据机制：`category/group`、`shortDesc/longDesc`、默认值、范围、单位、枚举、位掩码及重启要求。优先读取飞控发布的 COMPONENT_METADATA / COMPONENT_INFORMATION 和参数元数据 URI，支持 MAVLink FTP、HTTP(S)、JSON/XZ 与本地 XML/JSON 导入。带 CRC32 的数据校验后按 URI/CRC 缓存，缺失时回退到内置 QGC/PX4 参考库。参考库或手动导入不会显示为已验证的固件匹配；自定义固件应发布对应元数据。

缺少元数据的参数按前缀归类，并显示“暂无元数据说明”。参数值按 PX4 字节编码解析整型/浮点型，不把整型参数的 float 容器直接当作数值。

## 日志

通过 MAVLink LOG 协议读取板载列表并下载，可选择多个日志依次保存、查看进度和取消。按块追踪覆盖范围，重试缺块，校验 ULog 后才将隐藏的 `.part` 文件替换为目标 `.ulg` 文件；取消或失败不会覆盖原文件。

支持打开本地 `.ulg`，查看时长、主题/实例、采样数量与频率、参数记录、固件信息以及 dropout。当前支持 ULog v1、单个文件最多 512 MiB；本地截断文件会明确标示，下载的截断文件不作为完整日志保存。

## NSH

工具箱 NSH 经同一仿真机转发链路使用 MAVLink SERIAL_CONTROL Shell，进入页签后自动建立持续会话。键盘字节、Ctrl+C 和终端输出持续传输，ANSI 光标/清屏与长时间输出由共享的 xterm 终端处理；切换页签保留会话，退出工具箱释放会话。

原有「NuttX NSH 控制台」与工具箱共用终端组件。原入口在网络模式下自动使用仿真机 Telnet 地址（端口沿用 `NSH_TELNET_PORT`，默认 23）；USB 与自动模式的旧单条命令接口保留兼容路径，不将其伪装成持续会话。

Linux 桌面的 HTTP(S) 元数据下载使用 `curl`，失败时保留具体地址与服务器错误。XZ 元数据使用应用内的 liblzma 解压，兼容 PX4 preset-9 的 64 MiB 字典，并分别限制解压工作内存（128 MiB）和解压结果（16 MiB）；无需外部 `xz` 命令。当前工具不配置 MAVLink 签名密钥，签名帧会明确拒绝。

## 本地验证

```bash
node tests/px4-protocol.mjs
node tests/px4-simulator-source.mjs
node --experimental-websocket tests/px4-toolbox-ui.mjs
cargo test --offline --manifest-path src-tauri/Cargo.toml --test px4_files --test serial_assistant
npx tsc --noEmit
npm run build
```

测试使用独立 MAVLink 线协议样例、本机 UDP/TCP/PTY 和浏览器原生键盘事件，不发送真实设备命令。主机验证不代替仿真机/飞控联调。
