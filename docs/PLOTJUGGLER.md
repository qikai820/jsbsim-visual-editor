# PlotJuggler 实时曲线

桌面上位机通过 **工具 → PlotJuggler · 实时曲线** 打开独立 PlotJuggler 窗口，替代原 Live 仪表盘入口。JSBSim Live 插件自动接入，不需要填写端口或选择 JSON 格式。重复打开入口会复用进程并请求切换到其窗口。FDM 耗时可直接搜索 `fdm/run_ms`；如果固件上报统计值，还会出现 `fdm/average_ms`、`fdm/max_ms`、`fdm/samples`。

在 PlotJuggler 左侧将变量拖入绘图区。可以缩放、叠加曲线，并用原生菜单保存/加载布局。上位机在运行期间独立缓存最近约 300 秒、最多 32 MiB 的曲线数据；即使 PlotJuggler 尚未打开或已经关闭，重新打开时也会补绘这段历史。集成插件会将绘图窗口的初始缓存调到约 300 秒，避免 PlotJuggler 默认的 5 秒缓存立即删掉历史点。超过缓存范围的完整原始报文请用 **工具 → 遥测记录** 保存到 JSONL 文件。打开、关闭或重开 PlotJuggler 不会启动、停止或删除这份本机记录。上位机退出后停止转发，已保存的 JSONL 文件仍保留。

在 **仿真配置 → 运行与时间 → PlotJuggler 发送频率** 设置 0～200 Hz，点击“应用”立即生效，并在下次打开时恢复。默认 50 Hz；0 表示逐包发送。旧版保存的 0 会迁移为 50 Hz；如需逐包发送，请重新应用 0。旧版保存的非零频率保持不变。此项保存在上位机本地，不参与“保存到仿真机”。1～200 Hz 是上位机转发到 PlotJuggler 的频率上限，不改变仿真机产生遥测或上位机接收、记录遥测的频率。限速期间收到的不同数值变量会合并到下一次发送中，同一变量只保留最新值。没有新的遥测时不会生成样本。

## 数据含义

- 从 Rust 遥测接收器接受 JSON 对象的位置转发；默认上限为 50 Hz，可在仿真配置中调整。原始报文先送到独立 JSONL 记录器，再通过不阻塞接收线程的队列交给绘图缓存和 PlotJuggler；绘图队列积压时只丢绘图样本，不停止记录。USB/网络复用既有接收链路，不抢占板端连接或遥测端口。PlotJuggler 只读，不发送控制命令。
- 横轴是本次上位机运行以来的单调接收时间，单位秒。窗口重开后沿用同一时间轴；它包含传输时延，不等同于板端采样时刻。
- 原 `timestamp` 保存在 `simulation/time_s`。仿真重启归零不会使横轴倒退。
- `properties` 中的属性展开为原路径（去除开头 `/`），保持板端原始单位；没有收到的属性不会重复补点。
- 嵌套数值展开为路径，例如 `task_top/cpu_cores/0`。任务按 `task_top/tasks/pid_42/load` 命名，避免任务排序改变时串线。字符串、布尔字段不作为曲线。
- 不同模型/多次运行会留在同一会话中；需要隔离时关闭窗口后重新打开。长时间保存请继续使用上位机“遥测记录”，绘图缓冲不代替原始记录。
- 插件运行状态文件中的“已接收”是插件处理包数；“发送失败”只统计上位机发送错误，UDP 不保证可靠传输，两者不能证明板端零丢包。插件启动之前发送的数据也可能丢失。

## 构建和运行

当前实现面向 Linux。官方源码固定为 PlotJuggler **3.16.0**，提交 `5a0f01bcd5f8df7fd20923017b0dc3b72581337f`，不修改上游源码；专用插件位于 `integrations/plotjuggler/jsbsim_live.cpp`。

需要 CMake、C++17 编译器和 Qt5 Core/Widgets/PrintSupport/Concurrent/Xml/Svg/OpenGL/WebSockets/Network/X11Extras 开发组件，首次构建需联网获取上游依赖：

```bash
bash integrations/plotjuggler/build.sh
source .toolchains/env.sh
npm run build
cargo build --manifest-path src-tauri/Cargo.toml
```

本机缺少的 Qt X11Extras 已解压到 `.toolchains/plotjuggler-deps`；脚本优先使用该目录，否则使用系统安装。运行文件在 `.toolchains/plotjuggler-build/bin/`，插件和程序必须一起保留。工具缓存不提交 Git。

程序依次查找 `JSBSIM_PLOTJUGGLER_BIN` 指定的路径、桌面程序旁 `plotjuggler/bin/plotjuggler`、当前源码目录的构建产物。必须带有同版本构建的 `libJSBSimLive.so`。当前改动没有将 Qt 和 PlotJuggler 打进 AppImage；交付其他电脑时需单独部署运行组件及依赖。

运行日志、插件接收状态和隔离的 Qt 设置位于 Tauri 应用缓存目录下 `plotjuggler/`。启动失败时上位机会提示错误。只启用 JSBSim Live、CSV 导入和 CSV 导出插件。

## 验证

```bash
source .toolchains/env.sh
cargo test --manifest-path src-tauri/Cargo.toml --test plotjuggler
QT_QPA_PLATFORM=offscreen cargo test --manifest-path src-tauri/Cargo.toml --test plotjuggler -- --ignored --nocapture
```

第二条测试启动真实 PlotJuggler 和插件，验证自动监听、进程复用、逐包发送、10 Hz 限速以及关闭重开后的历史补绘。测试数据不经过板端，不等同于实板验收。实板验收需在仿真配置中设置不同发送频率，通过工具菜单打开 PlotJuggler，拖入真实 FDM 和其他属性验证曲线、暂停和重启行为。
