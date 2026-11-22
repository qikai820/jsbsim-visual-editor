# 上位机测试引擎命令行入口

直接编译使用桌面端的 `flight_test`、`tool_transport`、`serial_assistant` 和 `scene_telemetry` 源文件；没有另一套控制器或模拟飞控反馈。`--run` 才执行脚本，不加该选项只校验 XML、检查实际链路与模型。保留 HIL、真实模型时钟、四元数反馈和 ACK/状态双确认，不限制 `COM_RC_IN_MODE` 的取值，不增加自定义固件检测。

运行时独占**现有工具箱转发端口**（默认 UDP 14553），固定仿真机来源和实际 PX4 心跳端点。不使用端口复用，不修改路由配置，不打开另一条飞控 USB 链路。桌面工具箱应先释放该端口，QGC 的独立通道可继续工作。

桌面上位机已占用 5801 时，Linux `dumpcap` 只读复制来自指定仿真机的视觉遥测。数据经过 pcap/IP/UDP 来源、长度和分片检查后送入原有场景遥测缓存。上位机关闭、UDP 5801 空闲时，入口独占该视觉端口接收数据，并每秒发送已有 VCMD 7 心跳，防止仿真机因上位机超时停止；端口已有监听时继续使用只读抓取，不复用端口。不会用主机时间生成假的仿真时钟。需要已安装的 `dumpcap` 具有正常抓包权限；容器的 `no_new_privs` 可能阻止已有文件能力，须在允许该能力的宿主执行环境运行。

```bash
cd /home/qikai820/src/jsbsim-visual-editor
cargo build --offline --manifest-path tools/flight-test-cli/Cargo.toml --target-dir src-tauri/target

# 先启动当前 MorphQuad 仿真实例，再运行。按实际网口和地址调整。
src-tauri/target/debug/px4-flight-test-cli \
  --source examples/flight-tests/morphquad-attitude/morphquad_complete.xml \
  --sim-host 192.168.101.82 --capture-interface enp0s31f6 \
  --local-port 14553 --instance 1 \
  --output /home/qikai820/tmp/morphquad-complete-run --run
```

结果目录必须未用于其他运行，防止覆盖记录。`report.json` 为桌面端同格式的完整结果（包含源 XML、绑定、轨迹、事件和退出确认），`status.json` 每 250 毫秒保存进度（终端摘要每 5 秒输出），`events.jsonl` 保存事件，`scene.pcap` 保存只读模型遥测副本，`capture.log` 保存抓取工具状态。启动失败也保存报告并返回非零退出码。

按 Ctrl+C 或在结果目录创建 `STOP` 文件，会执行原脚本的异常退出策略并确认，随后保存报告。命令行默认正常退出主动降落，继续发送中位输入和心跳，等待实际着陆并确认上锁；异常退出默认请求 Hold。可用 `--on-finish` / `--on-abort` 指定 `land`、`hold` 或 `release`。Hold 是一次模式交接，停止输入后仍会按飞控的输入丢失配置处理。入口本身不启动或重置模型、不修改参数，也不自动解锁；是否解锁、手动起飞由传入脚本决定。本次完整脚本包含解锁和手动油门起飞阶段。

所有外层错误都先停止原有引擎并完成退出，再关闭链路。最终报告区分启动失败、执行失败、停止和完成；发送目标不计为姿态到位。

遥测优先复用 PX4/QGC 已在发送的新鲜反馈，避免每次开始/退出都重新配置。缺失时才逐条请求姿态 50 Hz、本地位置速度 20 Hz、高度 10 Hz、着陆状态 2 Hz，并确认周期配置回执；飞行中不再高频 `REQUEST_MESSAGE`，硬件身份每 5 秒查询一次。只在同一新鲜 HIL 身份仍有效且飞控上锁时，退出才恢复本次新增流的默认周期；已解锁时保留反馈流。这不写飞控参数；恢复的是固件默认周期，其他客户端的自定义周期由该客户端重新请求。

地面手动起飞要求当前相对高度在 ±1 m 内。模型重建后若仍引用上次飞行的高度参考，预检查直接终止，避免油门模块追赶错误高度。手动普通姿态激励与回位均在原生控制循环内检查异常倾角/角速度；停止结果仍须核对退出确认和飞控上锁状态。
