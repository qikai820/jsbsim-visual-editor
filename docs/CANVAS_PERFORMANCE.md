# 大运算符画布的加载与后台计算

画布初始化仅构建节点身份、信号依赖和完整临时网格，不在 React 挂载期间运行 Dagre。所有模块使用相同路径。读取保存坐标后，按实际测量尺寸检查坐标完整性和矩形重叠；有效布局直接恢复，空布局、部分布局或因端口/尺寸变化失效的布局在后台重新排列。

自动布局使用 ELK 原生 Worker；连线避障、平行线分离、共享分支整理使用独立的模块 Worker，包括同步 WebAssembly 计算。测量布局完成后立即显示所有节点和连接并开放节点交互，再在后台细化路径。选择、平移和缩放不会重新计算全图；编辑几何结构会中止旧任务并整理最新状态。

每次计算拥有独立 Worker。画布卸载、开始新布局或拖动使旧任务失效时，通过 AbortSignal 终止计算；60 秒超时也会清理 Worker。结果应用前检查当前画布状态，防止旧计算覆盖编辑。Worker 只接收节点尺寸、位置、端口和路径数据，原节点数据及连线监视信息在界面侧保留。

新节点使用 React Flow 自带的批量 ResizeObserver 测量；端口变化需要强制刷新时按画布合并到同一批次，避免逐节点广播全图更新。每条线在界面侧只绘制路径，不逐帧扫描全图障碍物，也不会因避障未完成而隐藏逻辑连接。空间不足的路径保留并以虚线提示；详细路由失败时保留 ELK 布局和全部连线。连线复用输出分支索引，选择高亮只订阅两端节点状态，并复用已有鼠标命中路径，避免重复 SVG 交互路径。主画布、公式画布和模块画布共享监视节点索引及稳定的节点/边数组；未保存标记缓存基准图和每个输入端口的连接签名。

布局计算仅更新本地布局元数据，不调用模型内容变更回调。序列化保留原组件顺序，禁止按屏幕坐标重新排序执行逻辑。

## 验证

生产构建压力测试（自动构建临时页面、启动预览并清理）：

```sh
node --experimental-websocket tests/canvas-performance-ui.mjs --production
CANVAS_LARGE_ONLY=1 node --experimental-websocket tests/canvas-performance-ui.mjs --production
```

开发模式先运行 Vite，再传入服务地址：

```sh
npx vite --host 127.0.0.1 --port 5179
node --experimental-websocket tests/canvas-performance-ui.mjs http://127.0.0.1:5179
CANVAS_EXPRESSIONS=1 node --experimental-websocket tests/canvas-performance-ui.mjs http://127.0.0.1:5179
node --experimental-websocket tests/runtime-tuning-ui.mjs http://127.0.0.1:5179
node --experimental-websocket tests/signal-monitor-ui.mjs http://127.0.0.1:5179
```

压力用例包含 240 个双输入组件（276 个节点、492 条连线），以及混合不同输入数量的组件，覆盖已保存布局、空布局、部分坐标、重叠旧布局、路由失败、拖动、平移、缩放和选择。另包含 1000 个运算组件（1368 个节点、4352 条连线）的显示和取消测试。除路径数据数量外，逐一检查实际 SVG 路径、端口端点、节点矩形重叠和居中后的视口范围。它不连接仿真机，也不修改工程文件。

同一测试还加载 `jsbsim_realtime/data/aviation/aircraft/C130/C130.xml` 的真实气动表达式，包括 26 个函数、6 个派生查表块，共 79 个节点和 130 条连线，检查首次整理、保存布局恢复以及模型内容未被布局改动。

`tests/signal-layout-ui.mjs` 的 H7 共享主干断言在本次修改前的源码中也会失败；该断言保留，不能将整套 H7 布局测试报告为通过。浏览器测试不代替桌面 WebView 的实际复测。
