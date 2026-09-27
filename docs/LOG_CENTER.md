# 日志中心（板端 MCAP）

入口：工具 → 日志中心。选择“仿真机日志”，点击“刷新仿真机”，展开日期目录。
选择文件后可以下载；较小的文件会下载并自动打开，超过 64 MiB 的文件需从本地
日志手动打开。打开本地 MCAP 后可选择变量、查看曲线并导出 CSV。

板端已完成的日志位于 `/mnt/sdcard/LOG/YYYY-MM-DD/`，以 `.mcap` 结尾。
仿真运行时使用 `.active` 临时文件；STOP 成功保存后才重命名为 `.mcap`。
日志中心只列出 `.mcap`，所以正在运行的段和保存失败保留的 `.active` 不会显示。
每次 START 会创建新段。日期来自板端时钟；上位机启动仿真前会尝试同步该时钟。

如果仿真结束后列表没有新文件：

1. 在日志中心点击“刷新仿真机”，查看是否有读取失败提示，并检查其他日期目录。
2. 确认板端 SD 卡已挂载、`/mnt/sdcard/LOG` 可写，且该模型运行配置启用了 MCAP。
3. 在板端检查 `LOG` 日期目录内是否只有 `.active`；同时查看串口输出中的
   `JSBSim MCAP: cannot create`、`cannot start logger`、`save failed`、`saved` 和
   `finalized on simulation stop`。保存失败时应保留 `.active` 与错误路径。
4. 若板端存在 `.mcap` 而列表仍为空，检查上位机“本地设置 → 仿真机通信”的
   USB/网络模式及连接状态。文件传输在自动模式下按 USB 协议探测结果选用 USB
   或网络；参见 [USB Bulk 说明](usb-bulk.md)。

“工具 → 遥测记录”是独立的**本机 JSONL**记录功能，保存上位机收到的报文，
不会创建板端 MCAP，也不会填充日志中心的“仿真机日志”列表。
参见 [本机遥测记录](TELEMETRY_RECORDING.md)。
