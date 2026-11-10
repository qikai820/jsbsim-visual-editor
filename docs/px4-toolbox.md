# PX4 工具箱

从「工具 → PX4 工具箱 · 参数 / 日志 / NSH」打开。工具箱自动接收**仿真机已有的 MAVLink 转发数据**，没有独立连接按钮，也不在电脑上另开飞控 USB 串口。

## 数据入口

- 当前模型有 MAVLink 转发部件时，沿用其 `qgc_port`、启用状态与双向配置。多个转发部件可选择数据来源。
- 没有对应编辑器节点的旧模型，自动监听默认 UDP 14550。运行实例、转发配置变化时释放旧会话并重新识别数据源。
- PX4 目标 SYS/COMP 从心跳识别；取得仿真机地址时只接受该主机的数据。识别后固定 UDP 回传来源，其他发送端不能改变参数、日志或终端指令的回传目标。
- 转发须已在仿真机上运行，且支持双向回传。当前入口使用现有网络转发，不增加 USB Bulk 协议。UDP 端口被 QGC 等程序占用时会明确显示等待/绑定失败，不以端口复用分流报文；可在模型转发配置中分配不同端口。

### 与 QGC 同时使用

在仿真机模型中配置两个 `MAVLINK_FORWARD` 输入，共用同一个 USB 设备和波特率，
目标均为电脑在仿真机网段的 IP。QGC 使用 14550；工具箱使用另一个空闲端口，
例如 14553，并将该转发的标识设为 `px4-toolbox`。两路均启用双向转发。
现有串口层只保留一个 USB 读取线程，通过多个订阅转发完整 MAVLink 帧。

工具箱自动优先选择已启用的 `px4-toolbox` / `toolbox` 通道，手动选择的数据源
仍优先。QGC 对应的普通 UDP 连接不要勾选“高延迟链路”；该选项会请求飞控启用
高延迟遥测，不适用于这里的普通 UDP 转发。连接参数更改后需重新加载模型生效。

```xml
<input type="MAVLINK_FORWARD" id="qgc" source="USB" device="/dev/ttyACM0"
       baud="921600" qgc_host="192.168.3.109" qgc_port="14550"
       enabled="true" bidirectional="true"/>
<input type="MAVLINK_FORWARD" id="px4-toolbox" source="USB" device="/dev/ttyACM0"
       baud="921600" qgc_host="192.168.3.109" qgc_port="14553"
       enabled="true" bidirectional="true"/>
```

## 参数

只读获取 PX4 参数，支持完整列表、缺失索引重试、全局搜索、收藏、固件类别/分组、前缀分组及本机自定义分组。`.params` 导出使用 QGC 的 SYS、COMP、名称、值、类型列格式，部分读取会在文件头标明。

分组与说明参考 QGC 的元数据机制：`category/group`、`shortDesc/longDesc`、默认值、范围、单位、枚举、位掩码及重启要求。优先读取飞控发布的 COMPONENT_METADATA / COMPONENT_INFORMATION 和参数元数据 URI，支持 MAVLink FTP、HTTP(S)、JSON/XZ 与本地 XML/JSON 导入。带 CRC32 的数据校验后按 URI/CRC 缓存，缺失时回退到内置 QGC/PX4 参考库。参考库或手动导入不会显示为已验证的固件匹配；自定义固件应发布对应元数据。

缺少元数据的参数按前缀归类，并显示“暂无元数据说明”。参数值按 PX4 字节编码解析整型/浮点型，不把整型参数的 float 容器直接当作数值。

## 日志

通过 MAVLink LOG 协议读取板载列表并下载，可选择多个日志依次保存、查看进度和取消。按块追踪覆盖范围，重试缺块，校验 ULog 后才将隐藏的 `.part` 文件替换为目标 `.ulg` 文件；取消或失败不会覆盖原文件。

支持打开本地 `.ulg`，查看时长、主题/实例、采样数量与频率、参数记录、固件信息以及 dropout。当前支持 ULog v1、单个文件最多 512 MiB；本地截断文件会明确标示，下载的截断文件不作为完整日志保存。

## NSH

工具箱 NSH 经同一仿真机转发链路使用 MAVLink SERIAL_CONTROL Shell，进入页签后自动建立持续会话。键盘字节、Ctrl+C 和终端输出持续传输，ANSI 光标/清屏与长时间输出由共享的 xterm 终端处理；切换页签保留会话，退出工具箱释放会话。

原有「NuttX NSH 控制台」与工具箱共用终端组件。原入口在网络模式下自动使用仿真机 Telnet 地址（端口沿用 `NSH_TELNET_PORT`，默认 23）；USB 与自动模式的旧单条命令接口保留兼容路径，不将其伪装成持续会话。

Linux 桌面元数据网络获取/解压使用 `curl`、`xz`，缺少依赖时仍可使用内置参考库与未压缩的本地元数据。当前工具不配置 MAVLink 签名密钥，签名帧会明确拒绝。

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
