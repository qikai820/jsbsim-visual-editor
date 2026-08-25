# JSBSim Visual Editor — 软件设计说明

## 1. 项目概述

### 1.1 项目目标

JSBSim Visual Editor 是一个基于 Web 的可视化飞机建模工具，提供类似 Simulink 的拖拽式界面，用于创建、编辑和可视化 JSBSim 飞行力学模型的 XML 配置文件。

### 1.2 核心能力

- **可视化建模**：基于 React Flow 的节点-边图形化编辑界面
- **XML 双向转换**：JSBSim XML ↔ 可视化节点的自动解析与生成
- **文件引用解析**：自动搜索并合并 JSBSim 目录中的发动机、系统、螺旋桨等引用文件
- **表达式编辑器**：可视化编辑飞控函数和气动力系数的数学表达式
- **多维数据表**：气动力系数表格的图表化显示与编辑（1D 折线图、2D 热力图）
- **3D 预览**：基于 Three.js 的飞机三维可视化，展示各模块空间位置
- **飞机模型库**：内置 59 个 JSBSim 飞机模型，一键加载
- **创建向导**：引导式新建飞机模型（固定翼/多旋翼/直升机）
- **数据持久化**：localStorage 自动保存，刷新不丢失

### 1.3 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript |
| 图形编辑 | React Flow (@xyflow/react) |
| 构建工具 | Vite |
| 3D 渲染 | Three.js |
| 图表 | Recharts |
| 状态管理 | Zustand |
| 后端 | Node.js + Express |
| XML 解析 | fast-xml-parser |

---

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    浏览器 (Client)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Toolbar  │  │ Canvas   │  │ Property │  │ Palette│ │
│  │          │  │(ReactFlow)│  │  Panel   │  │        │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │              │              │             │      │
│  ┌────┴──────────────┴──────────────┴─────────────┴───┐ │
│  │              Zustand Store (flowStore)              │ │
│  │   nodes[] | edges[] | aircraft | selectedNodeId     │ │
│  └────────────────────┬───────────────────────────────┘ │
│                       │ HTTP API                        │
└───────────────────────┼─────────────────────────────────┘
                        │
┌───────────────────────┼─────────────────────────────────┐
│                 Node.js Server                          │
│  ┌────────────────────┴───────────────────────────────┐ │
│  │              Express Router                        │ │
│  │  /api/parse-xml    → XML → JSON Graph              │ │
│  │  /api/generate-xml → JSON Graph → XML              │ │
│  │  /api/aircraft-library → 列出内置飞机               │ │
│  │  /api/load-aircraft  → 加载内置飞机                 │ │
│  │  /api/generate-aircraft → 向导生成 XML              │ │
│  │  /api/jsbsim-files   → JSBSim 文件索引              │ │
│  │  /api/save, /api/load → 项目文件保存/加载            │ │
│  └──────┬─────────────────────────────┬───────────────┘ │
│         │                             │                 │
│  ┌──────┴──────┐  ┌──────────┐  ┌────┴──────────────┐  │
│  │ xmlParser   │  │xmlGen    │  │ expressionXml     │  │
│  │ (解析引擎)   │  │(生成引擎) │  │ (表达式树解析)    │  │
│  └──────┬──────┘  └──────────┘  └───────────────────┘  │
│         │                                               │
│  ┌──────┴──────────────────────────────────────────┐    │
│  │         JSBSim 文件索引 (347 XML files)          │    │
│  │  aircraft/ | engine/ | systems/ | propeller/     │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 数据模型

### 3.1 节点 (Node)

每个 JSBSim 模块对应一个可视化节点：

```typescript
interface AircraftNodeData {
  label: string;              // 显示名称
  componentType: ComponentType; // 组件类型
  params: Record<string, any>; // 参数键值对
}

type ComponentType =
  | 'wing' | 'fuselage' | 'inertia' | 'landing_gear'
  | 'engine' | 'propeller' | 'fuel_tank'
  | 'system' | 'aero_coefficients' | 'output';
```

### 3.2 节点类型与参数映射

| 组件类型 | XML 来源 | 关键参数 |
|---------|---------|---------|
| wing | `<metrics>` | wingarea, wingspan, chord, location |
| fuselage | `<mass_balance>` | emptywt, CG location |
| inertia | `<mass_balance>` | ixx, iyy, izz, ixz |
| landing_gear | `<ground_reactions>` | spring, damping, friction, brake_group |
| engine | `<propulsion>/<engine>` | engine_type, file, thruster_file, location, orient |
| propeller | `<thruster>` | file, location, orient, sense, p_factor, tables[] |
| fuel_tank | `<propulsion>/<tank>` | capacity, contents, location |
| system | `<system>` | channels[] (含 functions, sensors, actuators) |
| aero_coefficients | `<aerodynamics>` | axes[] (lift, drag, side, roll, pitch, yaw) |
| output | `<output>` | name, type, rate, properties |

### 3.3 表达式树 (Expression Tree)

用于飞控函数和气动力系数：

```typescript
type ExprNode =
  | { kind: 'value'; value: number }
  | { kind: 'property'; name: string }
  | { kind: 'product' | 'sum' | 'difference' | 'quotient'; children: ExprNode[] }
  | { kind: 'table'; tableType: '1D' | '2D' | '3D'; data: number[][]; breakpoints: number[] }
  | { kind: 'sin' | 'cos' | 'tan' | ...; children: ExprNode[] }
  | { kind: 'ifthen'; children: ExprNode[] };
```

### 3.4 系统通道模型

```typescript
interface SystemChannel {
  name: string;
  items: SystemItem[];
}

interface SystemItem {
  type: 'function' | 'sensor' | 'actuator' | 'kinematic' | 'switch' | 'pid';
  name: string;
  expression?: ExprNode;       // function 类型的表达式
  componentProps?: Record<string, { value: string; attrs: Record<string, string> }>;
}
```

---

## 4. 核心模块设计

### 4.1 XML 解析引擎 (xmlParser.js)

**职责**：将 JSBSim XML 文件解析为节点-边图形数据

**核心流程**：
1. `parseXml()` — 主入口，按顺序解析各 section
2. `resolveSectionFile()` — 处理 section 级文件引用 (`<metrics file="Metrics.xml"/>`)
3. `resolveFileParams()` — 递归解析 engine/thruster 文件引用
4. `buildFileMap()` — 构建文件索引，支持自动搜索 JSBSim 目录
5. `parseTableData()` / `extractTables()` — 提取多维数据表
6. `applyLocationLayout()` — 根据 3D 坐标计算 2D 布局位置
7. `createLogicalEdges()` — 根据物理连接关系创建边

**文件引用解析策略**：
```
用户文件 (最高优先级)
    ↓
JSBSim aircraft/ 目录
    ↓
JSBSim engine/ 目录
    ↓
JSBSim systems/ 目录
```

**坐标布局算法**：
- 有 location 的节点：JSBSim 3D 坐标 → 2D 屏幕坐标（顺时针旋转 90°）
- 无 location 的节点：按类型分类，两列排列在右侧

### 4.2 XML 生成引擎 (xmlGenerator.js)

**职责**：将节点-边图形数据转换回 JSBSim XML

**核心流程**：
1. 按 componentType 分组节点
2. 根据组件定义 (componentDefs) 生成对应 XML 元素
3. 表达式树 → XML 运算标签 (`<product>`, `<sum>`, `<table>` 等)
4. 数据表 → `<tableData>` 标签

### 4.3 表达式解析器 (expressionXml.js)

**职责**：JSBSim XML 运算标签 ↔ 表达式树的双向转换

**支持的运算**：
- 算术：`product`, `sum`, `difference`, `quotient`, `pow`
- 三角函数：`sin`, `cos`, `tan`, `asin`, `acos`, `atan`
- 其他：`sqrt`, `abs`, `exp`, `ifthen`
- 查表：`<table>` (1D/2D/3D)

### 4.4 属性面板 (PropertyPanel.tsx)

**职责**：显示和编辑选中节点的所有参数

**功能特性**：
- 根据 componentType 动态渲染字段类型（string, number, select, location, vector3, table）
- 系统节点：通道编辑器（可增删组件，内联编辑属性）
- 表达式编辑器集成：点击 📐 按钮弹出可视化表达式编辑器
- 多维数据表编辑器：1D 折线图、2D 热力图
- 传感器属性编辑：input, lag, noise (含属性), gain, bias, delay, output

### 4.5 表达式编辑器 (ExpressionEditor.tsx)

**职责**：可视化编辑数学表达式

**交互方式**：
- 左侧模块面板：点击或拖拽添加到画布
- 中间画布：React Flow 节点编辑器
- 右侧属性面板：编辑选中模块的参数

**模块类型**：
- 输入：Property（属性路径）、Value（常量）
- 运算：Product, Sum, Difference, Quotient, Pow
- 函数：Sin, Cos, Tan, Sqrt, Abs, Exp
- 逻辑：IfThen
- 查表：Table (1D/2D/3D)

### 4.6 飞机模型创建向导 (AircraftWizard.tsx)

**职责**：引导式创建新飞机模型

**11 步流程**：
1. 类型选择（固定翼/多旋翼/直升机）+ 单位制
2. 基本信息（名称、版本、作者、描述）
3. 几何参数（机翼面积、翼展、弦长、尾翼、参考点）
4. 质量惯量（空重、转动惯量、重心、集中质量）
5. 起落装置（接触点配置）
6. 动力系统（发动机、推力器、油箱）
7. 飞控系统（自动生成占位通道）
8. 气动系数（自动生成 6 轴占位）
9. 传感器（IMU、气压计、GPS）
10. 输出配置
11. 预览生成 XML 并导入

**预设模板**：根据飞机类型自动填充典型参数值

### 4.7 飞机模型库 (AircraftLibrary.tsx)

**职责**：浏览和加载 JSBSim 内置飞机模型

**功能**：
- 自动扫描 `jsbsim/aircraft/` 目录，提取 59 个飞机模型
- 按类型分类（固定翼 57 / 多旋翼 1 / 直升机 1）
- 搜索和筛选
- 详情面板（描述、版本、作者、文件大小、子文件列表）
- 一键加载：自动解析所有引用文件并导入编辑器

---

## 5. 服务器 API 设计

### 5.1 API 端点列表

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/parse-xml` | XML → JSON 图形 |
| POST | `/api/generate-xml` | JSON 图形 → XML |
| GET | `/api/aircraft-library` | 列出内置飞机库 |
| POST | `/api/load-aircraft` | 加载指定飞机 |
| POST | `/api/generate-aircraft` | 向导生成 XML |
| GET | `/api/jsbsim-files` | JSBSim 文件索引 |
| POST | `/api/save` | 保存项目到文件 |
| POST | `/api/load` | 从文件加载项目 |
| GET | `/api/projects` | 列出已保存项目 |

### 5.2 核心 API 详细设计

#### POST /api/parse-xml

**请求**：
```json
{
  "xml": "<fdm_config>...</fdm_config>",
  "files": [{ "name": "Metrics.xml", "content": "..." }]
}
```

**响应**：
```json
{
  "aircraft": { "name": "F450", "version": "2.0", "release": "BETA" },
  "nodes": [{ "id": "node-1", "type": "aircraftComponent", "position": {...}, "data": {...} }],
  "edges": [{ "id": "e1", "source": "node-1", "target": "node-2", ... }]
}
```

#### POST /api/load-aircraft

**请求**：
```json
{ "aircraftId": "F450" }
```

**处理流程**：
1. 读取 `jsbsim/aircraft/F450/` 目录
2. 找到包含 `<fdm_config>` 的主 XML 文件
3. 收集目录下所有子文件
4. 调用 `buildFileMap()` 构建完整文件索引（含 JSBSim engine/systems 目录）
5. 调用 `parseXml()` 解析并返回

---

## 6. 前端组件架构

```
App.tsx
├── GlobalErrorBoundary     — 全局错误捕获
├── ReactFlowProvider       — React Flow 上下文
└── AppContent
    ├── Toolbar             — 工具栏（导入/导出/保存/向导/模型库）
    ├── Palette             — 左侧组件面板（拖拽添加节点）
    ├── Canvas              — 中间画布（React Flow 编辑器）
    │   └── AircraftNode    — 自定义节点组件
    ├── PropertyPanel       — 右侧属性面板
    │   ├── TableDataEditor — 多维数据表编辑器（含图表）
    │   ├── SystemChannelEditor — 系统通道编辑器
    │   └── ExpressionEditor — 表达式编辑器弹窗
    ├── FileManager         — 子文件管理器
    ├── Airplane3DViewer    — 3D 预览（Three.js）
    ├── AircraftWizard      — 飞机创建向导弹窗
    └── AircraftLibrary     — 飞机模型库弹窗
```

### 6.1 状态管理 (Zustand Store)

```typescript
interface FlowState {
  nodes: Node<AircraftNodeData>[];
  edges: Edge[];
  aircraft: { name: string; version: string; release: string };
  selectedNodeId: string | null;
  subFiles: SubFile[];

  // Actions
  addNode, removeNode, updateNodeParams,
  onNodesChange, onEdgesChange, onConnect,
  loadProject, clearAll
}
```

### 6.2 数据持久化

- **导入后**：项目数据 + 原始 XML 存入 localStorage
- **编辑时**：500ms 防抖自动保存
- **刷新时**：自动从 localStorage 恢复
- **版本控制**：缓存版本号，旧版缓存自动清除
- **新建时**：清除 localStorage

---

## 7. JSBSim 兼容性

### 7.1 支持的 XML 特性

| 特性 | 支持状态 |
|------|---------|
| Section 级文件引用 (`<metrics file="..."/>`) | ✅ |
| Engine 文件引用 (`<engine file="..."/>`) | ✅ |
| Thruster 文件引用 (`<thruster file="..."/>`) | ✅ |
| System 文件引用 (`<system file="..."/>`) | ✅ |
| 嵌套文件引用 (engine → thruster) | ✅ |
| 自动搜索 JSBSim 目录 | ✅ |
| 表达式树解析 (product/sum/table...) | ✅ |
| 多维数据表 (1D/2D/3D) | ✅ |
| 传感器组件属性 | ✅ |
| 单位制 (IMPERIAL/METRIC) | ✅ |

### 7.2 支持的发动机类型

| 类型 | XML 根标签 | 枚举值 |
|------|-----------|--------|
| 活塞发动机 | `<piston_engine>` | piston |
| 涡轮发动机 | `<turbine_engine>` | turbine |
| 涡桨发动机 | `<turboprop_engine>` | turboprop |
| 火箭发动机 | `<rocket_engine>` | rocket |
| 电动机 | `<electric_engine>` | electric |
| 无刷直流电机 | `<brushless_dc_motor>` | brushless_dc |

### 7.3 内置飞机库

共 59 个飞机模型，涵盖：
- 固定翼：C172、B737、B747、A320、F16、F22、Concorde 等
- 多旋翼：F450
- 直升机：AH-1S

---

## 8. 文件结构

```
jsbsim-visual-editor/
├── client/
│   └── src/
│       ├── components/
│       │   ├── expression/
│       │   │   ├── ExpressionEditor.tsx   — 表达式编辑器
│       │   │   ├── ExpressionPalette.tsx  — 模块面板
│       │   │   └── FunctionBlockNode.tsx  — 函数块节点
│       │   ├── nodes/
│       │   │   └── AircraftNode.tsx       — 飞机组件节点
│       │   ├── AeroEditor.tsx            — 气动系数编辑器
│       │   ├── AircraftLibrary.tsx        — 飞机模型库
│       │   ├── AircraftWizard.tsx         — 创建向导
│       │   ├── Airplane3DViewer.tsx       — 3D 预览
│       │   ├── Canvas.tsx                — 画布组件
│       │   ├── FileManager.tsx           — 文件管理器
│       │   ├── Palette.tsx               — 组件面板
│       │   ├── PropertyPanel.tsx          — 属性面板
│       │   ├── SubFileEditor.tsx          — 子文件编辑器
│       │   └── Toolbar.tsx               — 工具栏
│       ├── store/
│       │   └── flowStore.ts              — Zustand 状态管理
│       ├── utils/
│       │   ├── componentDefs.ts           — 组件定义
│       │   └── expressionConverter.ts     — 表达式转换工具
│       ├── App.tsx                        — 主应用
│       ├── App.css                        — 全局样式
│       ├── main.tsx                       — 入口
│       └── types.ts                       — TypeScript 类型定义
├── server/
│   ├── index.js                           — Express 服务器
│   ├── xmlParser.js                       — XML 解析引擎
│   ├── xmlGenerator.js                    — XML 生成引擎
│   └── expressionXml.js                   — 表达式树解析
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## 9. 部署与运行

### 9.0 外部 PX4 HIL 模式

当 JSBSim 由 `px4-jsbsim-bridge/jsbsim_server` 管理时，visual editor
只作为上位机监控和手动接管界面，不启动本地 JSBSim。推荐使用独立 UDP
端口：

```bash
SIM_EXTERNAL=1 \
SIM_UDP_PORT=5801 \
SIM_UDP_CTRL_PORT=5802 \
SIM_UDP_HOST=127.0.0.1 \
node server/index.js
```

其中 5801 接收 JSON 遥测，5802 发送 `VCTL` 手动控制帧。bridge 侧对应设置
`VIS_UDP_TELEM_PORT=5801`、`VIS_UDP_CTRL_PORT=5802` 和
`VIS_DEST=127.0.0.1:5801`。外部模式下 `/api/sim/start`、`stop`、`pause`、
`resume` 和 `restart` 不会操作本机 JSBSim 进程。

### 9.1 开发环境

```bash
# 安装依赖
npm install

# 启动后端服务器 (端口 3001)
node server/index.js

# 启动前端开发服务器 (端口 5173)
npm run dev
```

### 9.2 生产构建

```bash
npm run build    # 构建前端到 dist/client/
node server/index.js  # 服务器同时提供 API 和静态文件
```

### 9.3 环境要求

- Node.js >= 18
- JSBSim 源码目录（用于飞机模型库和文件引用解析）

---

## 10. 版本历史

| 版本 | 日期 | 主要变更 |
|------|------|---------|
| 1.0 | 2026-07 | 初始版本：基础可视化编辑 |
| 1.1 | 2026-07 | XML 引用解析、发动机/螺旋桨分离 |
| 1.2 | 2026-07 | 表达式编辑器、多维数据表图表 |
| 1.3 | 2026-07 | 3D 预览、气动系数分组 |
| 1.4 | 2026-07 | 文件引用自动合并、发动机类型识别 |
| 1.5 | 2026-07 | 传感器属性编辑、系统通道管理 |
| 1.6 | 2026-07 | 数据持久化、两列布局、坐标旋转 |
| 1.7 | 2026-07 | 飞机创建向导、内置模型库 (59 架) |
