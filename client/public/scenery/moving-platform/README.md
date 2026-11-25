# 移动平台工作船

船体：Kenney **Watercraft Kit**, `ship-cargo-c.glb`。

- 官方来源：https://kenney.nl/assets/watercraft-kit
- 许可：[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
- 实际下载：shorepine/kenney 镜像，固定提交 `3694c6879e487c108f55677be7dd2ca75b07cc3b`，完整 URL 和 SHA-256 见 `visual-model.json`。
- `vessel.glb` 将原模型外置的 `Textures/colormap.png` 嵌入 GLB，保留原始几何，运行不访问外网。重建：`python3 scripts/download-moving-platform.py`。

上位机在下载船体上增加参数化起降甲板、H 标线、安全边线、双杆和杆座。场景单位为米；局部 X 右、Y 上、Z 后，对应模块前右下坐标 `(x,y,z)` → `(y,-z,-x)`。甲板顶面严格对应 `Y=-deck-z-m`；双杆底端对应 `Y=cg-z-m-sleeve-m/2`，间距、长度与模块同值。甲板中心是平台局部原点的水平位置。船体按甲板尺寸缩放并放在下方，原船外形是显示参考，不是测量 CAD。

编辑器中的模块预览直接使用当前参数。进入飞行视景即并行预读船模，并在现有 VMON 中使用一条临时启用状态订阅主动发现模块，无需等待完整属性树轮询。无此属性的明确回复会结束检测，模型代次变化后重新检测。发现启用的模块后，使用完整实测平台相对位置和姿态定位，不按场景编号重算运动。配置和位姿缺失时等待完整数据；过期保持最后位姿并标注，不以零补齐。平台参数仍遵守 32 路限制及已有用户信号的优先权。船模的文件读取和解析在同一 WebView 内合并为一个请求，缓存一个不可变源模型，模块预览、多实例与重新进入视景共享几何和材质；各平台只创建独立节点层级和甲板、双杆等附加物。缓存随窗口关闭释放。船体及标线不作为静态场景碰撞导出，接触仍由 C++ 移动平台模块计算。

独立预览：应用服务器 `/moving-platform-preview.html`。此页默认显示 4 × 3 m 甲板和 1.5 m 双杆，可旋转、缩放、改尺寸、查看场景摇摆。

实时视景先按实际采样时间对齐平台的六个位姿通道，再还原世界位姿，与飞机共用显示时钟逐帧插值位置和四元数。低频平台通道采用 80–750 ms 自适应缓冲，2–2.5 Hz 测试流的实际显示滞后约 0.6–0.75 s；不向最新实测位姿之后外推。平台断流保持最后世界位姿，模型重载清空历史。此缓冲只影响显示，不影响仿真接触或控制。验证：`node tests/moving-platform-playback.mjs`，覆盖交错通道、批量到达、延迟变化、倍速、暂停、断流和模型重载；WebGL 检查还核对飞机与船的显示时间相同。

## 船体动态碰撞与甲板降落

2026-11-24 增加原生移动船体碰撞。由同一 `vessel.glb` 提取 355 个非退化船体三角形，配上参数化实体甲板的 12 个三角形，共 367 个。七个零面积源三角形被去除；标线不参与碰撞，导向杆继续由原有限长杆/套筒模型处理。原生几何与视景使用相同缩放、偏移和轴向。`scripts/generate-moving-platform-hull.py` 可重建 `jsbsim_realtime/src/models/MovingShipAsset.h`，生成文件保留来源与 GLB SHA-256。

- `moving-platform/ship-collision=1` 默认开启船体网格和甲板降落，适用于甲板、双杆及组合模式；双杆模式的离杆后不自动重新接合。设为 0 使用原接触算法。`moving-platform/collision-radius-m` 默认 0.2 m，用于机体中心的球形防穿透包络，不是旋翼/机翼精确碰撞体。
- 船体 BVH 在模型加载时构建一次。每步将预测位移变换到运动中的船局部坐标进行扫掠；约束使用船体平移速度与接触点的角运动速度。船舷、驾驶舱和实体甲板均参与，位置和姿态不依赖浏览器持续传输。
- 地面查询合并静态地形与船体，选择较高的接触面，并返回接触法向及移动表面速度。飞机使用原有轮式或固定支撑点的弹簧、阻尼和摩擦在甲板降落；CG 包络在可由起落架支撑的甲板/屋顶面让位，避免架空起落架。平台原四点弹簧在网格模式下关闭，防止重复施力。旧甲板刚度/阻尼参数仅用于旧四点路径。
- 船体没有静止烘焙到 `scene.collision`，而是作为移动碰撞网格参与同一原生接触求解，避免船驶离后留下固定障碍。甲板上方的 AGL 使用真实船面；场景地面高程与地图基准仍使用静止地形。
- 原生状态：`moving-platform/ship/loaded`、`ship/triangle-count`、`ship/contact-count`；甲板接触与支撑力仍使用 `moving-platform/deck/contact-mask`、`deck/normal-force-n[i]`。网格模式下支撑力由原起落架计算，平台总外力字段主要反映导向杆，原起落架总力应从 gear/加速度通道查看。
- 需要任务机固件能力 `moving_platform_mesh=1`，新前端会在启动前校验，旧固件会提示升级。XML 部件版本仍为 1，运行模块版本为 2。仅更新网页/GLB 不会改变旧固件的物理模型。模块“场景”组可开启船体碰撞；“碰撞网格”预览按钮用青色线框显示物理覆盖范围。

本机原生回归：`cmake -S jsbsim_realtime -B jsbsim_realtime/build/native -DBUILD_SCENE_COLLISION_TESTS=ON`，构建后 `ctest --test-dir jsbsim_realtime/build/native -R 'SceneCollision|MovingShipCollision' --output-on-failure`。20 kg 原生接触夹具覆盖静止/3 m/s 直航/3 m/s 轻晃船的重力降落、起落架持续支撑、静止与直航船上的施力起飞后再次落舰、40 m/s 接近驾驶舱的防穿透、固定倾角降落、包络与支撑点差异、运动表面速度、有限船体外普通地面回退和关闭网格。夹具不写飞机位姿，不代表 PX4 自动着舰或板端 HIL 验收。

`moving-platform.glb` 是包含默认 4 × 3 m 甲板和 1.5 m 双杆（间距 0.36 m）的完整静态外形，可直接导入其他视景；贴图内嵌，单位为米。应用运行时使用 `vessel.glb` 与参数化附加物，支持不同尺寸。完整 GLB 由同一实际预览模型通过 Three.js GLTFExporter 导出，`tests/moving-platform-scene-ui.mjs` 可在 `/tmp/moving-platform-complete.glb` 重建；其校验值见 `visual-model.json`。
