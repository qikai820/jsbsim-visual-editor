# 移动平台工作船

船体：Kenney **Watercraft Kit**, `ship-cargo-c.glb`。

- 官方来源：https://kenney.nl/assets/watercraft-kit
- 许可：[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
- 实际下载：shorepine/kenney 镜像，固定提交 `3694c6879e487c108f55677be7dd2ca75b07cc3b`，完整 URL 和 SHA-256 见 `visual-model.json`。
- `vessel.glb` 将原模型外置的 `Textures/colormap.png` 嵌入 GLB，保留原始几何，运行不访问外网。重建：`python3 scripts/download-moving-platform.py`。

上位机在下载船体上增加参数化起降甲板、H 标线、安全边线、双杆和杆座。场景单位为米；局部 X 右、Y 上、Z 后，对应模块前右下坐标 `(x,y,z)` → `(y,-z,-x)`。甲板顶面严格对应 `Y=-deck-z-m`；双杆底端对应 `Y=cg-z-m-sleeve-m/2`，间距、长度与模块同值。甲板中心是平台局部原点的水平位置。船体按甲板尺寸缩放并放在下方，原船外形是显示参考，不是测量 CAD。

编辑器中的模块预览直接使用当前参数。进入飞行视景即并行预读船模，并在现有 VMON 中使用一条临时启用状态订阅主动发现模块，无需等待完整属性树轮询。无此属性的明确回复会结束检测，模型代次变化后重新检测。发现启用的模块后，使用完整实测平台相对位置和姿态定位，不按场景编号重算运动。配置和位姿缺失时等待完整数据；过期保持最后位姿并标注，不以零补齐。平台参数仍遵守 32 路限制及已有用户信号的优先权。船模的文件读取和解析在同一 WebView 内合并为一个请求，缓存一个不可变源模型，模块预览、多实例与重新进入视景共享几何和材质；各平台只创建独立节点层级和甲板、双杆等附加物。缓存随窗口关闭释放。船体及标线不作为静态场景碰撞导出，接触仍由 C++ 移动平台模块计算。

独立预览：应用服务器 `/moving-platform-preview.html`。此页默认显示 4 × 3 m 甲板和 1.5 m 双杆，可旋转、缩放、改尺寸、查看场景摇摆。

`moving-platform.glb` 是包含默认 4 × 3 m 甲板和 1.5 m 双杆（间距 0.36 m）的完整静态外形，可直接导入其他视景；贴图内嵌，单位为米。应用运行时使用 `vessel.glb` 与参数化附加物，支持不同尺寸。完整 GLB 由同一实际预览模型通过 Three.js GLTFExporter 导出，`tests/moving-platform-scene-ui.mjs` 可在 `/tmp/moving-platform-complete.glb` 重建；其校验值见 `visual-model.json`。
