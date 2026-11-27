# 飞行视景

从“工作区 → 飞行视景”二级菜单进入。原来的“显示 → 3D”继续用于模型结构预览。

视景模式的顶部工具栏保留仿真机性能、飞控连接和 MCAP 日志状态，可点击查看详情；“多机控制”入口也仍可使用。

## 视景布局与自定义仪表

视景工具合并到顶部工具栏。左侧使用浮动工具条，飞机列表、图层、遥测和视图设置按需展开；遥测面板可以固定停靠。姿态趋势、小地图默认收起，相机视角通过左下角下拉菜单选择。“专注”隐藏辅助面板和仪表，顶部连接、暂停与录制状态、遥测过期提示仍可查看。

右下角数值条默认 2 行 × 5 列，宽度为视窗的 40%；圆形 HUD 直径为视窗宽度的 9.6%，在普通桌面窗口下按参考图比例并排贴底。HUD 保留 100 px 最小尺寸和 184 px 上限；窄视窗自动换行并将 HUD 移至上方，防止仪表相互遮挡。WebGL 测量使用布局尺寸，适配自动显示缩放与面板开合。

- 点击“数值”或任一单元格进入配置。支持 1–6 行、1–8 列，选择数据项、名称、单位、小数位，拖动交换位置，也可使用前移/后移按钮。缩减行列后，被移出的指标进入“未放置指标”，可重新加入；移除按钮只清除当前单元格。
- 内置高度、速度、姿态、时间、环境风、倾转、推力、各电机输出与 RPM。单位选项执行实际换算；RPM 台架回退保留 `≈` 和来源说明，不把尾桨旋转示意当作 RPM。
- 自定义 JSBSim 属性在路径框失焦或按 Enter 后提交到所选实例的 VMON 订阅，可设置原始值倍率与偏移。与已有观察/示波器共享 32 路上限。XCD20 移动平台启用时，平台、八路电机转速和运行中测试所需的观测优先保留，机身位姿随视景遥测接收。已有数值标签和示波器信号使用剩余名额。通道不足时会提示，自定义仪表配置栏会标出未订阅的属性，未知值显示 `—`。
- 数据保留各自采样时间，超过 2 s 后变灰并显示年龄。自定义属性按实例和模型代次隔离；演示场景不读取实时自定义属性。圆形 HUD 使用同一所选飞机位姿，上弧显示横滚、右弧显示俯仰，抬头时右弧向上。点击 HUD 可切换北向上或机头朝上。
- 布局、仪表显隐、航向模式和遥测停靠偏好以 `jsbsim-flight-scene-display-v1` 保存在本机，不写入飞机模型或场景文件。存储不可用时提示本次配置仅在窗口内保留。

场景编辑器优先显示所选物体属性，场景资源、在线加载、碰撞与物体列表可折叠。收起属性面板不会退出编辑，顶部“完成编辑”或面板“完成”退出编辑；保存入口保留在面板标题栏。

验证：`node tests/scene-instruments.mjs`、`node --experimental-websocket tests/scene-instruments-ui.mjs`。后者使用实际 React 仪表组件与隔离采样，检查参考比例、行列编辑、恢复指标、排序、采样代次、持久化和 320–1916 px 布局，不连接实际仿真机。

视景支持离线试验场、单机与多机位姿、航迹、局部位置小图、自由/跟随/地面/机载/编队相机，以及姿态和执行器状态。几何体使用米制尺寸。Voliro T 外形对应工程模型的两组前部共轴旋翼、单尾桨和前部共用倾转；MorphQuad 使用 H 构型、四组双轴云台及八个共轴旋翼，尺寸和通道见下文。其余飞机使用参考外形，不代表从 XML 重建的精确几何。

## 使用

- 移动平台模块配有离线工作船外形：下载的 Kenney CC0 船体、按模块尺寸生成的甲板与双杆。可在独立预览页 `/moving-platform-preview.html` 旋转船模、查看摇摆和碰撞网格。进入飞行视景即并行预读船模，通过现有 VMON 主动检测平台启用状态，不等待整棵属性树轮询；确认后订阅所选实例的平台位置、姿态和几何参数，按实际遥测显示。收到无此属性的回复后结束检测，切换模型代次重新检测。船模在同一窗口只读取和解析一次，多实例和重新进入视景共用缓存。未获得完整数据时提示等待，断流保持最后位姿并标注过期。船体不参与静态碰撞导出，接触仍由原 C++ 模块计算。资源来源及轴向定义见 `client/public/scenery/moving-platform/README.md`；验证：`node tests/moving-platform-scene.mjs`、`node --experimental-websocket tests/moving-platform-scene-ui.mjs http://127.0.0.1:5194`（后者需要该端口的 Vite 服务，覆盖无平台属性树的启动耗时、缺失属性回复及缓存复用，不连接硬件）。

- 实时模式只显示收到的数据，未连接时保持空场景。
- “演示场景”生成明确标注的 8 机演示。演示中的暂停、继续不发送任何仿真控制命令，退出演示后重新等待实时数据。
- 第 8 架演示机为 MorphQuad，选中 `08 · MorphQuad` 可查看四组独立云台角和八路 RPM。
- 实时模式的暂停/继续针对视景中所选实例。它不会自动启动模型。
- “清除航迹”只清除视景历史，不重启仿真。
- 参考地面海拔优先使用遥测。未知时显示参考平面，离地高度留空；可通过“视图设置”指定同一高程基准下的地面海拔。场景中的跑道、机库和参照物是示意资源，不改变 JSBSim 地面接触模型。
- 视景中的采样频率和数据年龄来自实际接收记录。数据年龄不等同于端到端网络延迟。

## 场景导入与编辑

点击右上角“编辑场景”，视窗暂用自由相机，右侧显示场景编辑器；点击“完成”退出编辑，导入物体继续显示，可通过左侧“遥测”展开飞行状态。

- “导入 GLB/glTF”可一次选择多个模型。glTF 的 `.bin` 与贴图必须一起选择；有子目录、父目录引用或同名文件时，使用“导入目录”保留目录结构。支持相对路径和 URL 编码文件名，不在运行时下载网络资源。每个模型主文件作为一个可编辑物体，保留内部节点层级及原有尺寸，不自动归一化。
- Linux 桌面版“导入目录”使用原生目录选择器，补齐 WebKitGTK 不支持 HTML 目录上传的差异；仅扫描所选普通目录，保留子目录路径，读取上限为 100 MB / 2000 文件。取消选择不改变场景。
- 在物体列表或视窗中选择物体，通过“移动 / 旋转 / 缩放”切换三轴手柄，也可输入三轴数值。拖动手柄时暂停相机轨道操作，释放后恢复。支持物体重命名、显示/隐藏、重置变换、删除和定位；双击列表物体也可定位。
- 默认跑道、机库、32 棵树、机场风袋、停机坪和 F-35 共 37 个独立物体，直接显示在同一列表中，也能在视窗点击选择。每棵树可独立移动、旋转、非等比缩放；机库的门、地坪和阴影跟随整体变换。默认物体的“重置变换”恢复原始位置和尺寸，导入模型则恢复原点与单位缩放。
- 机库前方有 40 × 44 m 混凝土停机坪，带黄色安全边线、01 号机位和滑入引导线；F-35A 停在机位内，机头朝向机库外。机体采用用户下载的 shangus930 写实模型（CC BY 4.0），由 USDZ 转成自包含 GLB，保留颜色、法线、金属度、粗糙度及座舱透明材质，共 190514 个三角形、9 组材质、25 张内嵌贴图。USD 动画第 875 帧的起落架放下姿态烘焙为静态网格；源文件经 AR 展示归一化，转换时将机长恢复为 15.7 m，转换后包围盒为 10.954 × 4.547 × 15.7 m，机轮最低点对齐 Y=0。不是经测量校准的工程 CAD 或飞行动力学模型。来源、署名、变更及源文件校验值见 `client/public/aircraft/f35a/README.md` 和 `visual-model.json`；可用 `scripts/convert-f35a-usdz.py` 重建。
- 停机坪与 F-35 可分别编辑、隐藏、删除和保存，原有直升机起降点保留。停机坪默认参与碰撞导出，F-35 默认仅显示；勾选“参与仿真碰撞”后导出同一已加载的静态模型网格，资源未加载时明确报错。GLB 随应用离线提供，离开视景或删除全部 F-35 后释放模型资源；内置 F-35 类型及布局随 `.scene.json` 保存，模型资源由更新后的应用提供。独立 GLB 也可直接导入其他场景，并按导入模型的规则内嵌保存。已有 v2 场景保持其原有布局；若包含之前的内置 F-35，则自动使用新版外形。
- 位置以米计，X 向东、Y 向上、Z 向南，相对场景原点的参考地面。旋转为 XYZ 欧拉角，输入单位为度；缩放为正倍数。模型本身的节点变换保留，编辑变换作用于整个导入物体。“显示默认试验场”可隐藏默认地物，网格继续由场景图层控制。
- “保存场景”导出 `.scene.json`，内嵌模型主文件、二进制与贴图，保存物体布局、名称、可见性、默认试验场开关和参考地面海拔。“加载场景”替换当前场景，文件通过完整校验和资源加载后才生效。文件可在原模型目录不可用时重新加载。离开视景前请显式保存，当前没有自动保存。
- 场景格式 v2 将默认地物的类型、树木编号、变换、名称和可见性一起保存；隐藏或删除的默认地物不会在重载时重新出现。兼容读取 v1 文件：保留旧文件的导入模型与设置，并补上原先固定的默认地物。v2 的空物体列表保持为空。“显示默认试验场”同时控制默认地物及草地、远山，不改变单个物体已经保存的可见性。
- 单次导入最多 100 MB，场景文件最多 140 MB。当前支持不依赖额外解码器的模型；Draco、Meshopt 和 Basis/KTX2 压缩资源请先重新导出为未压缩 GLB/glTF。缺失或解码失败的贴图会提示错误并保留原场景。
- 读取模型时显示资源文件名和模型序号；每次异步文件读取或模型解码等待上限为 60 秒，也可点击“取消加载”。失败或取消保留原场景，迟到的加载结果不会覆盖后续操作。原生目录选择器等待用户选择时不计时。

## 地形与障碍物碰撞联动

移动平台的船体、驾驶舱和甲板已接入原生**动态碰撞网格**，默认随平台运动。飞机可由原有起落架在船上降落，表面速度包含平移与角运动；机体球形包络负责船舷/驾驶舱防穿透，甲板支撑使用起落架弹簧、阻尼和摩擦。“移动平台起降 → 场景 → 船体网格与甲板降落”控制该功能，“碰撞网格”预览可核对青色物理覆盖。需更新支持 `moving_platform_mesh=1` 的任务机固件后重新加载模型。船的移动网格不会被静止烘焙到下面的 `scene.collision` 中；367 个三角形的来源、参数、限制和原生回归命令见 `client/public/scenery/moving-platform/README.md`。

场景文件 v2 增加可选 `georeference`（大地纬度、经度、WGS84 椭球高，单位 °/°/m）、`collisionRadius`（m）及物体 `collision` 开关，旧 v1/v2 文件仍可加载。局部坐标固定为 X 东、Y 上、Z 南，1 单位 = 1 米；导入模型的单位差异通过物体缩放调整。

选择仿真模型后，地图原点经纬度自动读取“仿真配置 → 初始状态”（`config/models/<model>.json` 的 `initial`）；地心纬度转换为 WGS84 大地纬度。基准海拔读取该模型初始化 XML 的地面高程 `elevation`，按 `initGrnd.xml`、`initfile.xml`、`reset.xml` 顺序查找，支持米和英尺。配置的 `initial.altitudeM` 是机体初始海拔，不能作为地面：Voliro T 的机体约 583.0728 m（径向 ASL），地面为 582.57 m；将前者写进地图会使初始 CG 落入碰撞面内，并被双面碰撞推向下方。缺少地面高程时提示手动设置，不以机体海拔兜底。

无需启动模型或等待遥测。经纬度显示 7 位小数，保存和导出保留读取精度。选中有实时遥测的仿真实例后，自动基准使用本次运行首次收到的有效位置和地面高程。这个基准在本次运行中保持固定。等待或读取失败时留空并提示状态。与仿真启动规则一致，JSON 中为 0 的经纬度字段优先沿用初始化 XML 的对应坐标。F450_PX4 随 `initGrnd.xml` 使用北纬 44.725801°、西经 93.075866°，地面海拔 285.2111 m。模型位置与地面高程读取等待上限为 15 秒，可点击“重新读取模型基准”重试。若旧场景已保存错误的机体海拔，需点击“使用模型基准”，重新保存场景并同步碰撞地图；只改界面不会修复仿真机现有文件。

手动修改过的基准和加载 `.scene.json` 时保存的基准保持固定；选择其他模型不会覆盖，可点击“使用模型基准”显式恢复自动值。更改基准属于地图编辑，必须重新保存、导出及加载；海拔基准转换不会自动进行。演示模式仍用演示位置与地面高程初始化，不读取仿真机模型配置。

“飞机包络半径”下方的“视景地面高度偏移 / m”用于微调飞机与地面的显示距离，首次使用默认 0，支持 -100～100 m，步进 0.01 m。正值整体抬高视景地面与地物，缩短显示距离；负值降低地面。默认场地、导入地物、地面网格、参考阴影和地面相机使用同一偏移；飞机仍按遥测坐标显示，海拔/离地高度数值及碰撞几何、版本均不改变。修改后自动保存为本机偏好，下次进入视景或重新打开上位机时恢复上次值，无需点击“保存场景”。参数也以 `visualGroundOffsetM` 随 `.scene.json` 保存；加载带此参数的场景时采用文件值并自动保存，旧场景未携带该参数时保留当前本机偏移。仅调整此值无需向仿真机同步地图。

1. 在“编辑场景”设置原点、基准海拔、飞机包络半径，并编辑物体。半径以飞机重心为球心；应根据机体尺寸及起落架高度选择，过大可能先于起落架接地。这是无弹性球形包络，不是机体网格或损伤模型。
2. 保存 `.scene.json`。选择仿真实例后，点击“同步到模型（读回校验）”，或导出 `scene.collision` 手动放进实际加载的飞机模型目录（与模型 XML 同目录）。同步目标路径是存储库的 `jsbsim/aircraft/<model>/scene.collision`；同模型的实例共用该文件，各实例在启动时独立加载。
3. 上传读回成功仅表示存储文件一致。停止并重新启动实例，使新 FGFDMExec 加载该文件。核对启动日志 `Scenery loaded` 后的**实际路径**、版本及三角形数量，再核对视景中的运行端版本。“与本次导出一致”要求运行端新鲜版本与当前未修改布局的导出版本一致。版本是内容的 32 位 FNV-1a 标记，用于版本核对，不是安全签名。编辑、加载另一场景或断流后不会继续显示已核对状态。旧固件缺少这些属性时显示未知。
4. SD、ROMFS、其他存储的选择由运行端现有模型搜索顺序决定；不能以上传路径推断活动路径。若启动日志仍指向 ROMFS，先按既有模型同步流程解决路径优先级。无碰撞文件时保持原有地面模型；碰撞文件存在但格式错误、截断、非普通文件或不可读时，模型加载失败，不静默回退。移除活动模型目录中的 sidecar 后重新启动可恢复原地面模型。

同步期间显示上传量，以及临时文件读回、提交、最终读回阶段；不再显示“读取模型与贴图”。网络资产上传使用 1 KiB / 5 ms 的分块节流，避免小型 XML 的 256 B / 60 ms 节流使 20 MiB 地图耗时超过 80 分钟；实际速度取决于设备和网络。FTP 通道等待上限为 5 秒，上传和读回使用有限、按文件大小计算的超时。临时文件通过校验后才替换正式文件，正式文件读回一致后才报告成功。USB 写入内部已包含逐字节读回校验，不再额外读取整份地图。同步属于远端写入，等待结果期间不会提供仅取消界面等待的“取消加载”按钮。

仿真核心本地构建三角形 BVH，无需浏览器持续发送高度。最高表面高度及坡面法向通过 `FGGroundCallback` 供 AGL 和原起落架接地点使用；树干、树冠、机库外壳、门、顶部和导入网格通过预测球体扫掠生成非穿透约束，进入原有投影 Gauss–Seidel 求解器。查询计入本步速度与加速度，启动首步也预先求解。地图启用时平动采用半隐式 Euler（先速度后位置），避免多步积分携带碰撞前速度穿墙；角运动仍沿用原积分设置。无地图时保持原积分器。

默认草地、起降坪、跑道、机库外壳及每棵树的简化树干和树冠参与导出；物体隐藏或取消“参与仿真碰撞”后不导出，移动、XYZ 旋转和非等比缩放会烘焙到顶点。阴影贴片、网格辅助线及远山背景不作为实体。草地之外/导入地图没有垂直命中的位置使用固定基准海拔的平地供起落架接地。表面查询选择最高面，因此第一版不支持桥下、隧道、洞穴和封闭体内部起飞；请在实体外初始化。碰撞面视为双面静态表面，无障碍物摩擦、弹性、碎裂、结构损伤或精确机翼接触力矩。动态蒙皮、实例化导入网格和非零形变会拒绝导出，需先转换为静态网格。

文件上限为 100 万个非退化三角形，坐标范围 ±1000 km（几何校验上限，非地理精度保证）。局部切平面与海拔差适用于局部试验场；大范围地球曲率与测绘高程转换需另外处理。单步最多 16 个接触约束，接近同一方向的约束合并并保留更严格的间隙；复杂密集凹形接触及大步长须针对所用机型验证。每个实例分别占用网格/BVH 内存，板端实时性与多实例内存预算须实测。

验证命令及证据见 `jsbsim_realtime/Tools/test_scene_collision.cpp` 和编辑器 `tests/scene-collision.mjs`。本机山地资源约 16.3 万三角形，导出约 20.3 MiB；优化构建的单线程 10000 组高度+扫掠查询测得 p50 9.81 µs、p95 17.07 µs、最大 37.76 µs（仅该主机和采样，非设备实时性验收）。本地测试覆盖坡面高度/法向、地图边缘、屋顶、薄墙、初始重叠、树干/树冠、变换、旧格式及文件拒绝。浏览器隔离测试验证视景，不等同于硬件碰撞验收。

可复现的本地检查（从工作区根目录执行）：

```bash
source jsbsim-visual-editor/.toolchains/env.sh
cmake -S jsbsim_realtime -B jsbsim_realtime/build/native -DBUILD_SCENE_COLLISION_TESTS=ON
cmake --build jsbsim_realtime/build/native -j 8
ctest --test-dir jsbsim_realtime/build/native -R SceneCollision --output-on-failure
cd jsbsim-visual-editor
node tests/scene-collision.mjs
node tests/scene-collision.mjs --builtins-only # 无需外部山地资源，检查内置地物及 F-35 可选碰撞
node tests/scene-document.mjs
node tests/scene-monitor-subscription.mjs
cargo test --manifest-path src-tauri/Cargo.toml --test scene_collision
cargo test --manifest-path src-tauri/Cargo.toml --test scene_asset_upload -- --test-threads=1
```

`scene-collision.mjs` 同时导出 `/tmp/mountain-scene.collision` 与 `/tmp/tree-scene.collision`，可作为原生测试第二、第三参数检查真实导出物：

```bash
jsbsim_realtime/build/native/test_scene_collision jsbsim_realtime/data/aviation /tmp/mountain-scene.collision /tmp/tree-scene.collision
```

核心新增查询器采用头文件实现，现有 `FGFDMExec.cpp`、`FGAccelerations.cpp`、`FGPropagate.cpp` 已在 POSIX/NuttX 的 CMake 和 Make 源表中，无需额外 `.cpp` 源表项。此变更已做主机编译与运行验证。全量 Cargo 测试仍受其他测试夹具缺失 transport 接口等编译问题阻断，碰撞格式校验使用独立集成测试；未刷写设备，未执行板端 SD/ROMFS 版本确认、碰撞或 deadline/jitter 验收。原生测试“重启”使用新 FGFDMExec；旧接口在同一个 FGFDMExec 上重复 `LoadModel` 存在属性绑定清理问题，本流程使用停止/重新启动实例。

## MorphQuad 视景模型

模型名包含 `MorphQuad`（不区分大小写，也支持 `MorphQuad_bridge`、`MorphQuad_test` 等变体）时自动选择专用外形。通道顺序沿用 `jsbsim_realtime/data/aviation/aircraft/MorphQuad/Propulsion.xml`：前右、前左、后左、后右依次对应 M1/M2、M3/M4、M5/M6、M7/M8，每组为上下共轴反转桨。

2026-11-18 细化版的公开尺寸来自[论文 v5](https://arxiv.org/html/2607.02764v5) 的机械设计章节及 Table S1：机体前后中心距 380 mm、左右中心距 406 mm，桨径 152.4 mm（三叶），含起落架高度 310 mm。论文旋翼中心相对质心的垂直坐标为 0；场景坐标为右/上/后，因此四组中心为 `(±0.203, 0, ±0.190)` m。当前 JSBSim XML 的水平力臂仍为 ±0.225 m，视景细化不改写动力学或控制参数。

外观按论文 Figure 4/5 的照片与机械示意重建：双层碳纤增强 PLA 板、安装支柱与四脚支架、四个单环云台、正交内横梁、共轴双电机、偏置外轴舵机及皮带轮、空心轴走线，以及电池/束带、Jetson 风扇散热器、飞控板、八只 ESC、相机和线束。每个云台只含一个外环，内轴带动横梁、电机及两副桨一起转动。桨叶使用有弦长、后掠及名义桨距的三维曲面，上下桨具有相反手性；暂停时的 60° 初相差只用于看清共轴两层，不代表实机相位同步。

环径/截面、板轮廓、电子设备包络、上下桨间距（70 mm）及名义桨距（沿用已有 6×3 模型）按照片或既有模型估计，未由实物 CAD 验证。尺寸集中在 `client/src/sim/sceneMorphQuad.ts`，刚体装配在 `sceneMorphQuadVisual.ts`；同一刚体内按材质合并网格，关节之间保持独立，资源随组件卸载释放。不依赖网络纹理。

四组云台分别读取 `fcs/gimbal-outer-rad[0..3]`（α）及 `fcs/gimbal-inner-rad[0..3]`（β）。关节层级使用场景坐标 `Rx(-α) Rz(-β)`，使旋翼轴对应 `GimbalVectoring.xml` 中的机体推力方向 `(sin α cos β, sin β, -cos α cos β)`，保留超过 90° 和倒置时的符号。关节直接在 WebGL 帧循环读取各自的最新模型角；未采到的轴暂用零位且面板留空，过期样本保留最后角度并显示灰色。推力方向箭头只在两轴采样都新鲜时显示。

八路 RPM 使用 `propulsion/engine[0..7]/propeller-rpm`，旋向优先读取对应的 `propeller-sense`，缺失时使用 XML 中的 `[-1,+1,+1,-1,-1,+1,+1,-1]`。未收到 RPM 时保留静止外形、数值留空。暂停或 RPM 过期时停止桨叶动画。

MorphQuad 视景候选共 35 路信号：六路位姿、三路碰撞状态、两路地面属性、八路云台角、八路 RPM 和八路旋向。32 路订阅预算优先保留位姿、碰撞状态、地面属性、云台和 RPM，剩余旋向使用既有机型默认值；用户已有信号仍优先占用总通道额度，通道不足的属性显示为空。原生精简缓存与前端高速队列均接收八桨及四组云台，云台/RPM 包不会刷新机体位姿年龄。

专项验证：`node tests/scene-morphquad.mjs`、`node tests/scene-monitor-subscription.mjs`、`node tests/flight-scene-native.mjs`。`node --experimental-websocket tests/scene-morphquad-visual.mjs [输出目录]` 渲染实际编辑器组件，检查 380×406 mm 桨位、310 mm 高度、八副三叶桨、四组独立云台的推力方向、GPU 资源复用及渲染预算，并输出整体/俯视/倾转截图。`flight-scene-ui.mjs` 另检查完整视景中的通道桨位、四组反转桨、三叶桨、倒置推力方向、无需面板刷新即可更新的云台和过期保持，并生成 `/tmp/jsbsim-flight-scene-morphquad.png` 预览。

## 数据链路

NuttX UDP/USB JSON 和 POSIX bridge 紧凑 JSON 通过现有 `SimClient` 接收。`scene_telemetry.rs` 在原始完整位姿包处缓存数据，约每 33 ms 通过 Tauri `scene-frames` 事件广播精简快照。现有多机列表事件的频率不变。没有修改仿真机固件或 FDM 循环。

快照保留实例、模型、运行代次、仿真时间、采集时钟或接收序号、位置和姿态。原生位姿快照中的位置与姿态来自一个完整原始包。辅助包和不完整位姿包不能刷新位姿年龄，旧包和已退出的运行代次会被忽略。

每架飞机收到有效的 `scene-frames` 快照后，优先使用该通道与实际高速采样；普通 `telemetry` 事件仅兼容尚未提供视景快照的实例，避免缺少机构属性的普通帧把右侧数值反复清空。主视景流中断后按原规则显示过期，普通事件不会将其重新标为在线。

机构缓存包括这些数值属性：`position/h-agl-ft`、`position/terrain-elevation-asl-ft`、`fcs/voliro_t/pitch-rad`、`fcs/esc-out[0..4]` 和 `fcs/voliro_t/thrust-lbf[0..4]`，以及下文的 RPM 与旋向属性。选中飞机时，这些属性并入现有 VMON 信号订阅，切换实例或退出视景时恢复编辑器订阅。共享的 32 路上限优先保留用户已有信号，再用空余通道提供视景采样。演示模式不启用视景专用订阅。

位置与姿态的六个实测属性也并入同一 VMON 订阅：`position/lat-geod-deg`、`position/long-gc-deg`、`position/h-sl-meters`、`attitude/phi-rad`、`attitude/theta-rad`、`attitude/psi-rad`。加入转速属性后，Voliro 共需 26 路，四旋翼参考机型共需 16 路。通道不足时保留用户已有订阅，未齐全的六项不会生成位姿。

高速协议每包最多返回四路，因此前端等待六项都完成本轮新采样、最早与最晚接收时间相差不超过 250 ms、全部未过期，并且不早于当前位姿后才提交新的实测位姿。姿态由弧度转换为度；纬度使用大地纬度，海拔使用米。位姿年龄取六项中最旧样本的年龄，不使用机构包到达时间。旧原生快照不会回滚新的监视位姿，更新的完整原生快照仍可正常接续。即使尚未收到原生位姿快照，完整的六项实测采样也能初始化视景。

原始 `monitor.samples` 的实际机构值在 Rust 接收端直接进入视景缓存，不必等待属性树整轮轮询；属性路径统一化，较旧的树切片不能覆盖较新的高速采样。机构属性不保证与位姿同时采样。前部倾转关节在 WebGL 帧循环中读取最新实际角度，不经过面板的 200 ms 刷新或位置插值缓冲。

对于已经运行的旧桌面进程，前端也会从现有无丢包信号队列接入相同采样，不依赖原生程序重启。采样代次和序号独立校验，低速树快照不会覆盖新监视值，只有完整的六项实测位姿采样可以更新机体；单独的机构采样不会刷新机体位姿的连接年龄。姿态区显示“位姿高速采样”“位姿遥测采样”或“保留上次位姿”，并显示实际采样年龄。开发诊断可通过 `VITE_SCENE_DIAGNOSTICS=1` 启用，仅向本地 Vite 通道发送采样来源和年龄。

每个属性分别记录采样年龄和来源。超过 2 s 的已知值保留并显示为灰色，悬停可查看年龄；从未收到的属性才显示为空。机构区标明“机构高速采样”“属性轮询采样”或“保留上次采样”。旧采样不会冒充在线数据，模型重载清除前一代属性。前部推力箭头表示倾转轴方向，不用长度表示力值。

仿真机重启可能复用相同的 `tree_generation`，同时采集时钟、仿真时间和监视序号归零。原生缓存断流至少 2 s 后，需要两个连续前进的低时钟完整位姿包确认新的接收代次，通过 `scene_epoch` 告知前端，清除上一轮属性和历史。单个迟到包、重复缓存包不会触发重启确认。

监视链路发现断流后时间与序号一起回退，会换一个新的 VMON 订阅版本，并等待运行端返回这个新版本。收到确认后重新收齐六项实测位姿，允许同一模型代次从小时间重新开始。波形与航迹按新运行重新记录；旧订阅响应和旧原生快照不能覆盖恢复后的采样。该过程只重建监视订阅，不启动、停止或重启仿真机。

`FlightSceneFeed` 每机保存最多 128 个插值样本、300 个趋势样本和 600 个航迹点。位置和四元数姿态沿仿真时间插值，接收时间用于数据年龄和缓冲估计，避免低频遥测或 IPC 批量到达造成停顿后跳动。普通飞机缓冲根据最近接收间隔在 80–250 ms 内调整，播放时间通过小幅调速适应缓冲变化，保持向前推进；机体与相机使用同一 WebGL 帧时钟。显示不预测超出最新实测位姿的运动，超过缓冲能力的长时间断流仍会停留在已知位置。暂停或超过 2 s 未收到有效位姿后停止插值，恢复连接时重置播放缓冲。重载清空该机历史。后台标签页卸载 WebGL 画布。静态场景与桨叶组件复用，航迹只在新增点、清除或原点变化后重建几何，不随面板刷新重复分配。

移动平台与飞机共用同一显示时间。六个交错到达的平台位置/姿态通道按各自的仿真采样时间对齐，再结合该时刻的飞机位置还原船的世界位姿，随后逐帧插值世界位置和四元数，避免相对位置与姿态在远距离下放大误差。原生缓存通过 `scene_property_time_sec` 保留每个属性的实际采样时刻；旧版缓存可由数据年龄推算，原始 VMON 路径直接使用采样时间。平台缓冲按实测通道周期在 80–750 ms 内调整，两者共同延迟显示；2–2.5 Hz 平台流的隔离测试中显示约滞后 0.6–0.75 s。暂停时两者停在共同的实测时刻，平台断流时冻结最后世界位姿，飞机继续接收数据也不会拖动船。重新定位视图仍正确变换已冻结的船，模型代次变化会清空平台历史。这些处理只影响显示，不改变接触求解或飞控输入。

坐标链路为机体 FRD → 航空 ZYX 姿态 → NED → Three.js 右/上/后坐标。地理位置使用 WGS84 局部切平面计算水平距离，并保留仿真器原有海拔基准。旧 POSIX 紧凑包的地心纬度会先转换为大地纬度。适用范围为局部试验场；大范围地形、地球曲率和高程基准转换需要另外设计。

## 外观与渲染开销

本地试验场使用随应用打包的 Poly Haven CC0 摄影素材：[Kloppenheim 03 (Pure Sky)](https://polyhaven.com/a/kloppenheim_03_puresky) 天空、[Grass Ground](https://polyhaven.com/a/grass_ground) 草地、[Asphalt 02](https://polyhaven.com/a/asphalt_02) 沥青和 [Concrete Floor 01](https://polyhaven.com/a/concrete_floor_01) 混凝土。天空使用官方已映射为普通亮度的全景 JPG，表面使用颜色纹理。四个优化 JPG 合计约 187 KiB，运行时只访问本地资源，无需 Poly Haven API、CDN 或互联网。来源、作者、许可、原始 MD5 和本地 SHA-256 记录在 `client/public/scenery/polyhaven/manifest.json`，重建和离线校验见同目录 `README.md`。

天空全景为 1024×512。沥青与混凝土在打开视景时绘入跑道、直升机起降点和停机坪纹理，标线与磨损烘入同一张图。草地按 2.51 m 宽度采样 512×512 实拍底图，并以 1.4 m 尺度混合 1024×1024 细草叶纹理。细草纹理使用最高 8× 各向异性过滤，改善贴地斜视的清晰度。机库的门、侧窗、金属板与双坡顶共用一张图集，碰撞导出采用同一外壳。枝叶、机库和细草素材由本项目生成，见 `client/public/scenery/airfield/README.md`。十张共享场地纹理含 mipmap 约占 28.7 MiB。图片只填充现有纹理一次，图层切换和面板刷新复用同一 GPU 纹理，离开或进入后台卸载视景时释放。摄影素材缺失或解码失败时保留即时生成的场地外观，重新进入视景可重试。

32 棵树按四种树形实例化，共用一个地面阴影批次，合计五次绘制，每棵树保存独立变换，选中和拖动不拆分绘制，编辑时更新对应实例矩阵。远山使用低面数示意几何。草地按固定的场地坐标混合两种草皮，呈现不同尺度的斑块和低对比度的修剪纹路，并按实际视距融入雾色。树木采用简单光照，飞机保留受光材质。天空按视线方向采样全景，太阳方向与场地直射光对齐，地平线与远山和草地共用雾色。天空在不透明地物之后以最远深度绘制，透明桨盘和航迹仍可叠加。F-35 保留 25 张 PBR 贴图（包括法线），以 9 组材质绘制；为其金属表面一次生成本地中性环境光探针，后续逐帧复用，其他飞机保持原有光照。不增加后处理、逐帧环境反射或实时阴影贴图，像素比上限仍为 1.5。

飞机与地面之间的淡柔影投到已知高程的参考平面，随高度扩大、淡出；未知地面高程时不显示飞机柔影。它是距离参照，不是精确机体投影。场景草地、远山和地物均为外观资源，不改变仿真接地面或代表真实 DEM。

`flight-scene-ui.mjs` 在阻断 Poly Haven API/CDN 后检查本地素材正常加载，并覆盖场地摄影素材丢失后的降级和恢复（F-35 继续加载）。八机加静态 F-35 的广角场景检查暂停时至多 241 次绘制、少于 252112 个三角形，运行时至多 256 次绘制、少于 254112 个三角形，共享十张场地纹理、25 张 F-35 贴图和一个中性光照探针，最多另有一张机身碳纤维纹理，并保持阴影贴图关闭。帧耗时需在固定视角、分辨率、像素比与渲染设备下比较；软件 WebGL 的结果不能当作目标电脑 HIL 帧率。

## 验证

```bash
npx tsc --noEmit
npm run build
python3 tools/prepare_polyhaven_scene.py --check
node tests/flight-scene-state.mjs
node tests/flight-scene-playback.mjs
node tests/moving-platform-playback.mjs
node tests/flight-scene-native.mjs
node tests/scene-monitor-subscription.mjs
node tests/scene-document.mjs
node tests/scene-wind.mjs
cargo test --manifest-path src-tauri/Cargo.toml --test scene_files --offline
# 在另一个终端启动 Vite 后；测试使用 Chromium 软件 WebGL 和隔离 IPC。
node --experimental-websocket tests/flight-scene-ui.mjs http://127.0.0.1:5174
node --experimental-websocket tests/scene-editor-ui.mjs http://127.0.0.1:5174
node --experimental-websocket tests/scene-windsock-ui.mjs http://127.0.0.1:5174
```

`scene-editor-ui.mjs` 检查真实 GLB、带二进制与贴图的 glTF 目录、三轴拖动与相机隔离、数值变换、保存后刷新页面再加载、取消/超时及迟到结果、同步阶段与失败后重试，以及删除物体释放几何与贴图，并生成 `/tmp/jsbsim-scene-editor.png` 与 `/tmp/jsbsim-scene-sync-progress.png`。`scene_asset_upload` 使用隔离 curl/存储夹具验证大文件节流、分阶段进度、临时文件校验失败不替换原文件，以及最终读回失败不误报成功；该测试不会访问实际设备。

本版尚未包含卫星影像、DEM 高程接入和日志回放。已有本地进程 CSV 遥测未接入本版视景，使用 bridge JSON 链路。硬件 HIL 性能和长时间运行须在目标电脑与仿真机上另行验证。

## 机场风袋

默认试验场在起飞区西侧 `[-6, 0, 0]` 增加一个红白五段机场风袋，立杆约 3.5 m、袋长 1.8 m。它是可编辑的内置物体，可以移动、旋转、缩放、隐藏、删除并随 `.scene.json` 保存。已有 v2 场景保持原物体列表；可用“编辑场景 → 添加机场风袋”补上。

支持连续放置多个风袋：“添加机场风袋”自动生成唯一编号并在原点西侧附近寻找空位；选中风袋后，“复制风袋”保留其旋转、缩放和碰撞设置，在原物体附近错开放置。自动放置只避开已有风袋，基础间距为 5 m，并随场景中风袋的水平缩放增大；可以使用三轴手柄或位置数值自行布局。每个风袋独立显示、隐藏、编辑与删除，关闭“显示默认试验场”不会隐藏风袋，因此也可放在导入的自定义地景中。全部位置与属性随场景文件保存并恢复，仍受场景总物体数 1000 的现有限制。

风袋与左侧风信息均随所选飞机实例切换，读取 JSBSim `FGWinds` 的 `atmosphere/total-wind-{north,east,down}-fps`。总风包含稳态风、阵风、余弦阵风和湍流；客户端将 ft/s 换算为 m/s，并将 NED 映射到场景东/上/南。袋尾指向风吹去的方向，界面“来向”采用从北顺时针的来风方位：北向速度为正时，袋尾向北，来向 180°。水平静风没有虚构来向，垂直风另外显示。

三分量加入现有 VMON 订阅和原生精简缓存，各分量保留年龄；向量要求三项齐全且采样偏差不超过 250 ms，年龄采用最老一项。Voliro 无其他观测时共 32 路，F450 共 22 路；MorphQuad 的候选项共 38 路，受现有 32 路上限约束时优先保留位姿、风、地面、云台和 RPM，再保留桨旋向。用户已有信号仍优先占用订阅容量；风数据不完整时显示等待，不使用配置风或飞行速度替代。独立风包不能刷新机体位姿；过期 2 s、暂停或停止时冻结最后形态，恢复有效数据后继续。演示场景明确显示“演示风场”。

风袋朝向使用世界坐标，旋转立杆的 Y 角不会改变环境风方向。无风时袋尾下垂，风增强时逐渐鼓起、接近风向，小幅波动表现布料飘动。布料采用轻量程序几何，约 640 个三角形，不增加纹理、阴影贴图或物理求解器。形变在约 7 m/s 达到完全鼓起的显示上限，这个映射和布料摆动未做实物标定；风数值来自仿真，外观是近似表现。当前采用飞机采样点的环境风，未独立求解风袋位置/高度的局部风、遮挡或旋翼下洗。风袋默认不参与碰撞；手动开启时仅导出固定立杆、底座，布料不参与静态碰撞。

`scene-wind.mjs` 覆盖单位、四向、静风/垂直风、采样一致性、实例隔离、暂停/过期、快速采样合并和模型重载。`scene-windsock-ui.mjs` 使用隔离 IPC 的真实 WebGL 画面检查四向、风强响应、立杆旋转、保存/增删、暂停、机体数据仍在更新时的风断流、恢复和实例切换，并检查连续添加、多个风袋独立变换/隐藏/删除、复制、隐藏默认试验场后的显示与刷新页面后重新加载布局，生成 `/tmp/jsbsim-windsock.png` 和 `/tmp/jsbsim-multiple-windsocks.png`。

## 螺旋桨转速与动画

视景按每个桨的转速独立驱动桨叶，在 WebGL 帧循环内更新，保持同轴桨反向旋转、尾桨正反转与前部共用倾转。高速时叠加半透明桨盘；暂停、停止或对应采样超过 2 s 时冻结桨叶并去掉桨盘，已知数值保留为灰色。

优先使用模型的 RPM：Voliro 的接口为 `fcs/voliro_t/rpm[0..4]`（可带符号），标准 JSBSim 模型使用 `propulsion/engine[i]/propeller-rpm` 及 `propeller-sense`。这些属性并入同一 VMON 订阅，也进入原生精简缓存，分别记录采样年龄；RPM 包不能刷新机体位姿。Voliro 共用 26 路视景信号，四旋翼参考模型共用 16 路，仍优先保留用户已有信号并受 32 路上限约束。

旧版 Voliro 模型或尚未加载独立 RPM 模块时，按用户确认采用以下回退：M1–M4 根据实际 `fcs/esc-out`，插值现有 `m6208_310kv_6s_22x7.8_bench.csv` 的 22 个 23 V 单桨测试转速点；33% 以下从零线性外推，输出限制在 0–100%。面板明确显示“台架估算”和 `≈`。该估算没有考虑电压变化、双桨相互作用及安装负载，不能当作实际 RPM 反馈。M5 没有转速标定数据，仅随有符号 ESC 输出作正反转示意，标注“旋转示意”，不编造 RPM 数值。收到模型 RPM 后（包括真实零转速）优先显示采样值；RPM 过期时不切换估算来掩盖断流。

Voliro 桨位对应当前 XML：M1/M2 右上/右下，M3/M4 左上/左下，M5 为三叶尾桨。标准四旋翼和固定翼使用参考外形；其引擎编号对应通道编号，外观布局不替代模型几何。演示场景的 RPM 也明确属于演示数据。

转速专项回归：`node tests/scene-rotors.mjs`。此更改不修改仿真器受力、推力曲线或电机动态，不需要改写板端模型。

## JSBSim RPM 状态与可见旋转

`VoliroTRotorSpeeds.xml` 可在运行端增加五个独立的一阶转速状态 `fcs/voliro_t/rpm[0..4]`。视景直接订阅这些模型输出，并显示“JSBSim RPM 状态”；这与客户端 ESC 台架换算是不同来源。该模块不替换原有 ESC、推力、力矩或共轴模型。`rpm-model/version` 用于识别独立状态模型，`rpm-model/tail-calibrated` 用于标识尾桨加载转速是否已标定；这两项也经过同一 VMON 和原生缓存链路。

前四桨的稳态目标使用单桨台架转速曲线，动态极点按现有电机配置 9.6/s 建模。尾桨默认采用 1900 KV × 23 V 的空载参考上限；它不是带 6045 桨的实测负载转速，界面明确显示“未标定”。可通过模型参数 `tail-loaded-full-rpm` 替换为已标定的加载满速。它们是新增模型中的仿真状态，不是物理电调反馈。

约 2400 RPM 在 40 FPS 下每帧恰好转一圈，直接绘制可能看起来静止。视景保留完整的模型 RPM 数值和物理角速度，仅对显示相位压缩并限制每帧角步长，确保可见旋转方向；高速桨盘继续表达高速状态。面板注明“动画作可视化降速，RPM 数值保持原值”。暂停、停止和对应采样过期仍停止动画。
# Voliro T photo reconstruction (2026-11-11)

`client/src/sim/sceneVoliroT.ts` builds the black carbon T-frame, bevelled shell,
round cross/tail tubes, four motor housings in two common-tilt coaxial pods, tail
motor, GPS mast/puck, controller case, wiring and three landing legs. Static pieces
are batched by material. Five independent rotor animations retain the existing
RPM and stale-data handling. The rotor planes now use the model's actual 110 mm
spacing, with centres relative to the simulated CG: front X=+0.07 m, Y=±0.45 m;
tail X=-0.71 m. Scene coordinates are (body Y, -body Z, -body X).

`voliroTGeometry.json` records provenance. The user's three photographs establish
appearance; the existing simulation establishes motor centres, CG and contacts.
The latest user-supplied MSC 21x6.3 sheet establishes the front visual propeller
diameter (533.4 mm) and nominal pitch (160.02 mm). Shell dimensions and electronics are estimates. The supplied hardware Word
document confirms 25 mm tube OD and the M6208 68.7 x 25.8 mm reference housing.
On 2026-11-12 the user set all three landing contacts to 0.19 m below CG.
The existing attachment points and footprint are retained; the preview ground
follows that height. The slanted-leg end caps terminate at the contact plane. This is a visual reconstruction,
not a photogrammetric CAD measurement or a revised mass/inertia model.

The Tattu 177 x 65 x 56 mm battery is mounted beneath the fuselage, with its
177 mm length along body X and its front face aligned to the front cross-tube
centreline. It is laterally centred. Its centre is body (-0.0185, 0, +0.075) m
relative to the existing simulated CG; the 4 mm clearance beneath the lower
plate is a visual mounting allowance. The pack, straps and connector remain
fixed to the body during pod tilt. This visual mounting update does not
recalculate the existing rigid-body mass/CG/inertia or the 30-station drag model.

Generate full/bare GLB assets, metadata and an entirely offline interactive preview:

```sh
node scripts/export-voliro-visual.mjs /tmp/voliro-visual
node --experimental-websocket tests/scene-voliro-visual.mjs http://127.0.0.1:8788/preview.html /tmp
```

The same geometry JSON is deployed as `data/airframe_geometry_20261111.json` beside
the aircraft model. The companion `VoliroTBodyDrag.xml` uses distributed, passive
wind-relative drag at 30 stations. Its coefficients and shell sizes are engineering
estimates, not identified flight data. Mass, inertia, CG and propulsion remain unchanged. The 2026-11-12 gear update
changes only contact Z (0.50 to 0.19 m), the initial height and leg drag geometry.
The 0.50 m scene obstacle sphere is retained; deployed-gear support is verified
with the current landing-surface solver. External model files take effect on the next model
load; deploying an asset does not restart a running or armed HIL instance.

## MSC 21×6.3 桨叶与硬件资料更新

前部四支主桨的视景采用用户提供的 MSC 21×6.3 PDF 和图片，直径 533.4 mm、名义螺距 160.02 mm、整桨质量 47 g。`scenePropeller.ts` 生成带弦宽、后掠、近似扭转、厚度和安装孔的几何；M1/M4 为 CCW 外形，M2/M3 为镜像 CW 外形。尾部保持三叶 6045。离线预览默认显示全部五支桨，可关闭显示以检查机架。几何不代表经过测量的完整翼型或加工模型。

来源、17 组厂家性能点及范围限制已写入 PX4 的 `docs/zh/voliro_t_five_motor_design.md`，数据归档在 `docs/assets/voliro_t/msc_21x6p3_{specification.json,performance.csv}`。原始厂家表未给出 M6208 KV310 / 6S / ESC 油门映射。前部推力/扭矩现由实际 RPM 查询 MSC 21×6.3 曲线，共轴表按新桨径生成，旧悬停倍率改为 1。油门到转速仍使用暂定参考，默认上限 5000 RPM；低于首个 3320 RPM 测点为二次外推。旧加速反作用候选尚未重新辨识，也不将 47 g 桨重重复加到总质量。
