# MVP 实现状态

## P0

| 能力 | 状态 | 说明 |
|---|---|---|
| 首页、Zone 扫描准备 | 已实现 | 首页直达游园会 Zone 选择，不再收集关注重点或家人档案；UIKit、Dynamic Type、VoiceOver 标签、44pt 触控区 |
| 单房间扫描 | 已接入 | 复用 RoomPlan/ARKit；等待 LiDAR 真机验证 |
| 5 类稳定演示风险 | Mock 已实现 | 仅 `-AnjuDemoIssues` 显式启用；真实效果待模型和真机验证 |
| 世界锚点与短标签 | 已实现 | world point 才创建锚点，最多显示 5 个高价值标签 |
| 问题卡片与状态 | 已实现 | 确认、忽略、已处理；dismiss 在 Session 内抑制 |
| 12 类游园会规则 | 已实现 | 独立服务端 JSON 决定 severity、扣分、证据要求、A/B/C 和价格；旧 RASSAR Rubric 不再进入游园会风险链路 |
| 云端关键帧 | 已实现 | HTTPS、取消、分 Skill 超时、动态风险白名单 schema、结构化 Provider 错误与 request ID；火山方舟真实结构化图片调用已通过 |
| 报告与分享 | 已实现 | 优先级分组、详情、系统分享图和文本 |
| 无网失败态 | 已实现 | 一次 Turbo 都未成功时不生成空报告，提供重新扫描和退出 |

## P1

| 能力 | 状态 | 说明 |
|---|---|---|
| 历史帧深度反投影 | 已实现并单测 | captured image 顶点坐标、米、ARKit 相机轴、列主序变换均有注释 |
| 多关键帧融合 | 已实现 | 同类型近距离合并，不同来源标记为 fused |
| 问题位置图 | 已实现 | 相对当前相机显示 3 米内问题，等级同时用符号表达 |
| 语音提示 | 已实现 | 用户可选；高优先级问题每项最多播报一次 |
| H5 P01—P09 | 已实现 P0 | React 19 + TypeScript + Vite、HashRouter、Context/useReducer、移动优先和刷新恢复；单房间二次确认与多房间独立任务列表均已接入 |
| H5 图片上传 | 已实现 | 六类房间独立入口、1—6 张、方向校正/去 EXIF/缩放、中文质量状态、分房型拍摄建议和可删除分析副本 |
| v2 Assessment API | 已实现 | SQLite、访问令牌摘要、档案/房间/媒体/任务/风险/方案/报告/分享/埋点，v1 保持兼容 |
| 确定性评分与覆盖度 | 已实现 | 六类房间基础规则、档案系数、置信度、反馈重算、分房间覆盖度独立展示 |
| A/B/C 与预算 | 已实现 | 11 类风险均有三档方案，共33 条结构化价格规则、预算组去重与预计提升 |
| 视觉 Provider | 已接入 | 支持火山方舟和 OpenAI Responses API；方舟 `doubao-seed-2-1-pro-260628`、禁用思考及结构化图片请求已验证，实际风险识别效果仍需授权样本评测，正式失败不回退 Demo |
| 家属报告 | 已实现 | H5 支持报告预览、系统相册/隔空投送分享；未选时展示 A/B/C，选择后仅展示所选方案。旧只读 token 接口仅保留兼容，无 H5 入口 |
| 生产 Web 入口 | 已实现 | FastAPI/Uvicorn 完整迁移，单进程托管 React 构建；旧标准库 HTTP 服务和原生 DOM H5 已移除 |
| P0 H5 视频 | 已实现 | 浏览器本地解码、亮度/清晰度/感知哈希初筛、3—6 张代表帧确认上传；原视频不进入请求，跨帧重复在评分前合并 |
| P1 H5 相机 | 已实现 | 点击画面中央相机图标后才申请后置相机权限，无额外开启按钮；本地门控、单请求与退避；使用独立跨房型可见问题规则，场景选择只作为提示；最近已分析帧作为短暂冻结背景，bbox/polygon 以二维 SVG 对齐标注约 3 秒，不做跨帧跟踪或世界锚定；本页发现记录累计展示且刷新清空；临时建议不落正式风险、不计分 |
| P2 游园会 iPhone AR | 已实现 | 每个合格关键帧直接使用云端 Pro 级模型发现，结束扫描时不再调用模型，只由服务端确定性归并、评分和预算；iOS target 已移除 YOLO/Core ML 风险模型和本地风险同步；保留质量/变化门控、ARKit 历史深度定位、四 Zone、12 类独立规则和 A/B/C 预算 |

## 明确未实施

整改前后复查对比、PDF 导出、按城市价格、跨房间永久地图、直播、商品服务和训练管线仍未实施。P0—P2 的代码与自动验证已完成，但移动 Safari/Chrome、LiDAR 真机、弱网和游园会连续现场演示仍属于外部验收，不得写成已验证效果。

## 尚需外部条件

1. 核实方舟模型的正式发布授权、配额和费用上限；
2. 将 P0—P2 能力开关部署到 HTTPS 生产服务；
3. 在支持空间扫描的 iPhone 上完成四 Zone 真机测试记录；
4. 建立获授权的视频、H5 相机和游园会样本并记录召回、误报、定位和建议质量；
5. 完成 Safari/Chrome 与游园会现场连续三次演示。

## 本地验收记录

- generic iOS Debug 无签名编译通过；
- iPhone 17 Pro（iOS 26.3）模拟器 Debug 编译、安装和首页启动通过；
- `-AnjuOpenDemoReport` 可在 Debug 构建中绕过相机、空间扫描与模型，直接验收 5 类演示问题的报告 UI；
- Swift 领域测试当前 19 项、Python/FastAPI 当前 42 项、React/Vitest 当前 27 项通过；
- v2 创建评估、档案、上传、异步分析、风险反馈、三档方案、预算和兼容只读分享 API 已做 HTTP 冒烟测试；
- 显式 Demo Provider 下已在移动端完成 P01→P09、刷新恢复、多房间计划、档案编辑返回和报告 PNG 下载实际交互验收；浏览器控制台无错误；
- 火山方舟实际 API 已完成最小文本与结构化图片连通性验证；密钥未写入仓库，模型效果仍需授权样本评测。
- 旧版 `anju_h5_camera_adaptive_v1`、`anju_ios_fair_turbo_v1` 和 `anju_ios_fair_review_pro_v1` 均完成真实方舟结构化调用冒烟；新版实时发现 Prompt `anju_h5_camera_discovery_v2`、`anju_ios_fair_turbo_v2` 已完成自动化契约测试，仍需发布后使用授权画面做真实 Provider 复测。

## 2026-07-26 H5 实时相机模型切换

- H5 实时相机新增独立的 `ANJU_ARK_H5_CAMERA_MODEL`，生产值为 `doubao-seed-2-1-turbo-260628`；未配置时兼容回退到旧的 `ANJU_ARK_TURBO_MODEL`；
- iPhone 游园会保持直接使用 `ANJU_ARK_PRO_MODEL=doubao-seed-2-1-pro-260628`，不受 H5 切换影响；
- Provider 单测、完整 Python 测试和产品文案校验通过；候选及正式容器使用受控演示图片完成真实方舟冒烟，审计返回 H5 `model_name=doubao-seed-2-1-turbo-260628`；
- 生产镜像为 `anju-app:d1c1e47-wip-h5turbo-20260726-091412`，公网 `/health` 与 H5 首页验证通过；真实家庭/游园会效果仍需授权画面评测。

## 2026-07-25 生产相机会话故障修复

生产只读日志确认：服务器重装后 SQLite 中的 assessment 已不存在，但浏览器仍保留旧的
`anju_h5_session_v2`，实时相机连续收到 `assessment_access_denied` 404。同期新建 assessment
的 H5 相机、iOS Turbo 和 Pro Review 请求均返回 200，Analytics 未记录 Provider 失败，因此
本次直接原因不是方舟模型不可用。

工作区已完成、等待重新发布的修复：

- API 遇到 `assessment_access_denied` 时清除本地会话并通知全局状态；相机自动新建一次 assessment 后继续；
- H5 区分会话过期、请求占用、模型超时、非法响应、拒绝和离线状态；
- `quality_usable=false` 的相机帧不再保存为正式检查代表帧；
- FastAPI 将 `ProviderError` 映射为安全的 422/502/503/504 JSON，并返回 `X-Request-ID`；
- 模型请求 Schema 动态注入当前房间或 Zone 的风险代码枚举，避免未知代码被静默过滤成空结果；
- Analytics 记录模型耗时、原始/通过/拒绝候选数量和质量状态；
- H5 相机与 iOS Turbo 使用 15 秒服务端预算且不做长重试，iOS 客户端 Turbo 为 20 秒，Pro 为 70 秒；
- iOS 对非 2xx 解析安全错误码，并在远端失败时给出可访问的用户提示，本地扫描继续。

该修复尚未写为生产已上线；发布后仍需用旧 localStorage、弱网、真实 iPhone Turbo/Pro 和
低质量帧完成外部复测。

## 2026-07-26 实时相机评委体验增强

- H5 首页原“从视频画面开始检查”入口改为“使用实时相机开始检查”，直接进入实时相机页；进入页面时不提前创建 assessment，仍由用户点击画面中央相机图标后申请权限并按需创建会话；
- 新增版本化 `live-camera-rules-2026-07-25-v2`，与正式房间评分规则分离；只描述画面中直接可见的问题；
- H5 使用 11 类跨房型临时发现规则，`room_type` 降为场景提示，不再把卫生间等单一房型作为候选白名单；
- iOS 四个游园会 Zone 使用同一套 9 类临时发现规则，新增湿滑地面和通行高差；Zone 只记录位置，不缩窄候选类型；
- 服务端为临时候选返回规则确定的 `title`、`short_advice` 和 `rule_version`，模型只负责可见证据、位置和置信度；
- H5 实时相机复用现有 Turbo 模型配置以缩短交互等待；正式照片分析和 iOS Pro 复核仍使用 Pro 模型；
- H5 每次发现追加到页面内存历史，画面 1/3 处一次显示一条短建议约 3 秒；刷新后清空，不写入正式风险或浏览器持久化；
- iOS 在相机下方显示可滚动的本次扫描临时建议历史；按产品要求不增加 3 秒浮层；
- Analytics 记录原始、通过、拒绝候选数量、画面质量和实时相机规则版本，但不记录原始相机帧或完整模型响应。
- FastAPI 在读取请求体后把 H5 相机、iOS Turbo、上传质量检查和 Pro 复核移入线程池；H5/iOS Turbo 共享进程内 2 并发闸门，满载帧返回可重试 429；质量检查、正式照片分析和 Pro 复核共享 1 并发闸门并在线程池排队。

以上改动仍在工作区，尚未部署到生产，也尚未完成 Safari/Chrome 与 LiDAR iPhone 真机视觉验收。

## 2026-07-26 iOS Pro 复核前资源释放

- 扫描完成路径不再强制解包 `appContext`；上下文异常时改为可恢复的部分结果提示；
- 进入纯网络 Pro Review 前暂停并脱离 ARKit / RoomPlan session 和 delegate，清理 RealityKit 锚点、风险标签、Core Image 缓存和语音队列；
- 清理 `RoomObjectReplicator` 的 RoomPlan 对象图，并断开 `Settings` 单例对扫描页和 replicator 的强引用；
- 报告仍仅使用释放前已同步到 `AnjuCore` repository 的风险，不依赖已清理的 AR 资源。

该优化尚需真机连续扫描和 Pro 超时场景验证内存曲线；若仍发生退出，需结合 iPhone `.ips` / jetsam 日志定位。

## 2026-07-26 iOS 游园会云端 AI 全链路

- App target 不再编译或打包 `yolov5-Medium.mlmodel`、`ObjectDetection`、`YOLOResizer`、`BoundingBox` 和空本地视觉服务；扫描页不再运行 0.2 秒端侧检测、本地暗光风险或旧 Rubric 同步。
- 本地只保留 AR tracking、5 秒间隔、0.15m/0.14rad 变化门控、单请求和亮度 28—232 / 清晰度 5 质量门控；最长边 1280，JPEG 质量 0.72。
- 游园会规则、证据代码、标题、短建议、扣分、36 个方案和 3 个价格规则已从 Python/Swift 硬编码迁入独立服务端 JSON。
- 新增持续拥堵、明确标识的出口通道占用和低位悬挂物；单帧拥堵不计分，出口候选需同时有标识和障碍证据。
- 引导流程改为“首页 → Zone 准备 → 扫描”；一次 Turbo 都未成功时不生成空报告。

以上代码与自动化门禁已完成；LiDAR 真机四 Zone 连续三次、弱网、Turbo/Pro 超时、暗光和 jetsam 仍属外部验收。
