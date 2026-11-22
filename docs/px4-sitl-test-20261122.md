# PX4 软件飞控测试记录 · 2026-11-22

测试对象为当前工具箱软件飞控启动器及本次编译的 Linux PX4：
`/home/qikai820/chatgpt_pro/jsbsim_nuttx/build/px4_sitl_default`。
PX4 源码版本为 v1.15.2-1-g22c9c91afa，关闭 lockstep，使用独立测试工作目录。

| 检查 | 结果 | 证据或范围 |
| --- | --- | --- |
| 启动器 Rust 单元测试 | 4 项通过 | 目录和机型扫描、缺失可执行文件、参数校验、脚本生成及源目录保护、重复启动、stdout/stderr、子进程清理、异常退出及重新启动 |
| MAVLink 协议回归 | 通过 | 线协议、CRC、参数读写回读、日志分块、取消及超时等现有用例 |
| 转发来源选择回归 | 通过 | QGC/工具箱独立来源、过期选择、关闭状态和端口错误提示 |
| TypeScript 类型检查 | 通过 | `npx tsc --noEmit` |
| 前端生产构建 | 通过 | `npm run build`；保留项目既有打包警告 |
| PX4 可执行文件及依赖 | 通过 | `bin/px4 -h` 成功；动态库无缺失；机型和 rcS 文件齐全 |
| UDP 端口冲突集成测试 | 阻塞 | 当前执行环境创建 IPv4 UDP/TCP 套接字返回 `Operation not permitted`；未作为通过统计 |
| 真实 PX4 SIH 启动和主题测试 | 阻塞 | 已实际启动实例 9，但 Unix 套接字绑定 `/tmp/px4-sock-9` 返回 `Operation not permitted`。PX4 在启动脚本内无法执行 CLI，最终退出码 255；启动器正确记录输出与退出并清理进程。传感器及估计器断言未执行 |
| 浏览器界面测试 | 阻塞 | 已尝试 `tests/px4-sitl-ui.mjs`，Chrome 在进入界面断言前启动超时；不能计为界面测试通过 |
| 外部仿真机 UDP HIL 闭环 | 未验证 | 依赖上述网络能力及仿真机联机，不向真实飞控发送指令 |

完整联调尚未完成，不能据此宣称可以闭环飞行。

## 在系统终端补跑

测试脚本会先执行单测、类型和协议检查，再检查本机 UDP/TCP/Unix 绑定权限。
若权限不足，返回退出码 2 并标记 BLOCKED，不会输出整套测试通过。
权限允许时，继续运行真实端口冲突、真实 PX4 SIH、浏览器界面和生产构建测试。
真实 PX4 用例使用实例 9、10040 SIH 四旋翼，检查仿真模块、IMU、估计器姿态、SYS_HITL=0、重复启动及停止后的守护进程退出。
这套自动测试不替代外部 JSBSim 板端 UDP HIL 闭环联调。

```bash
cd /home/qikai820/chatgpt_pro/jsbsim_nuttx/jsbsim-visual-editor
./scripts/test-px4-sitl.sh
```

可用 `PX4_SITL_TEST_BUILD` 指定其他已编译目录；可用 `PX4_SITL_TEST_OUTPUT` 指定测试证据目录。
本次证据保存在 `/home/qikai820/chatgpt_pro/jsbsim_nuttx/diagnostics/px4-sitl-test-20261122`，
包含真实 PX4 启动快照 `startup.json`、测试日志及构建记录。
