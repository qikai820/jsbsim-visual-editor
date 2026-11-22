# MorphQuad 矢量 HIL 姿态测试接口（可选开发产物）

当前工作台已按用户要求取消自定义接口前置检查，默认使用现有矢量固件的主杆/AUX 映射。**本目录不是当前工作台的运行前提，也不应为默认映射启用 VEC_HIL_TEST。** 以下保留先前准备的可选接口和构建记录，飞控未刷写。

适配现有 MorphQuad 矢量控制链，基于 PX4 提交 `73a4d3d36e`。修改保持在 `vector_att_control` 和 `vector_pos_control` 的测试输入层，原矢量姿态/角速度反馈、合力控制与分配器继续工作。

源码补丁已应用到 `/home/qikai820/src/PX4-Autopilot`；完整目标 `make cuav_7-nano_volirot -j4` 构建通过。这个目标名是本地 CUAV 7 Nano 矢量构建配置，模型仍由现有 `CA_AIRFRAME=16` 的 MorphQuad 参数确定。

- 固件：[cuav_7-nano_morphquad_vector_hil_20261117.px4](cuav_7-nano_morphquad_vector_hil_20261117.px4)
- 构建目标、SHA-256 和大小：[build-manifest.json](build-manifest.json)
- 可审查补丁：[vector-hil-manual.patch](vector-hil-manual.patch)
- 修改后的完整文件：[overlay](overlay)

**尚未刷写飞控，未修改板端参数，未执行解锁或 HIL 飞行。**

## 接口

新参数 `VEC_HIL_TEST` 默认 0。启用接口需 `VEC_HIL_TEST=1`、`VEC_REF_EN=1`、`CA_AIRFRAME=16`，并由飞控自身 `vehicle_status.hil_state` 确认处于 HIL。接口不以待重启的 `SYS_HITL` 参数值代替实际 HIL 状态。

已解锁、已离地、新鲜有效且来源为 MAVLink 的 MANUAL_CONTROL 输入才可给出姿态目标。AUX1 / AUX2 分别是绝对 roll / pitch，±1 映射为 ±120°，内部按模式限制：

| 模式 | 角度限制 | 油门含义 |
| --- | --- | --- |
| MANUAL / STABILIZED | ±45° | 垂向 NED 合力，经当前姿态转为机体系，交给原矢量分配器 |
| ALTCTL | ±45° | 原有升降杆和高度环 |
| POSCTL | ±120° | 原有升降杆和位置环 |

手动模式新增的是 HIL 全矢量测试输入语义，不能将测试结果视为对原普通 RC 倾角/机体系油门映射的飞行验证。非 HIL、未开启参数、其他机型均保留原行为。位置控制在 HIL 输入停止时将独立姿态需求归零；Hold 继续使用平滑参考回平。

当前上位机不查询或要求 VEC_HIL_TEST，也不自动启用此接口、刷写或切换控制器。使用此可选接口需要单独选择与之对应的固定 AUX 映射；默认工作台已改回现有固件映射。

仅针对本目录可选接口的参数（不是当前默认工作台的设置要求）：

```text
COM_RC_IN_MODE = 1
VEC_HIL_TEST = 1
VEC_REF_EN = 1  # 维持 MorphQuad 的现有设置；修改它需要重启
```

## 验证

`python3 tests/vector-hil-firmware.py` 验证了 HIL/输入来源/机型/解锁/离地约束、45°/120° 限制、四元数目标及手动垂向合力方向，并使用现有 CUAV ARM 编译配置编译两个修改后的控制器。完整板端固件也已链接和打包成功。构建成功不代替真实板端闭环 HIL 验证。

`python3 scripts/prepare-vector-hil-patch.py` 从固定基线生成 overlay 和补丁，只写本目录，不写 PX4 源码或设备。文件系统权限审批后已单独应用该补丁并执行完整构建；本目录保留具体变更以供审查。
