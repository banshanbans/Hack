# 实现状态

> 更新：2026-08-08

## 已实现代码

| 范围 | 状态 | 说明 |
|---|---|---|
| H5 P01—P09 | 已实现 | 档案、六类房间、照片、分析、风险、A/B/C、预算和报告 |
| 比赛 Hero Demo | 已实现 | `hero-demo/` 独立 Three.js 展示前端，已接入经维护者确认授权的 iPhone GLB，并支持原生屏幕网格 VideoTexture、程序化设备兜底、28 秒摄影机时间轴和动态流程兜底；仅用于比赛展示，不代表新增识别能力 |
| H5 新手引导 | 已实现代码，待外部验证 | 5 步跨页面蒙版、版本化本地进度、单步跳过与“我的”重播；第 3 步同时指引上传照片或中央相机 |
| iOS Web 容器 | 已实现 | 持久化 `WKWebView`，受信 HTTPS 主框架 Bridge，失败原生重试页 |
| Bridge v1 | 已实现 | `capture_photo`、`start_live_scan`、`cancel_native_capture`，token 仅内存保留 |
| 房间绑定临时检查 | 已实现 | 后端从 room 获取房型，临时建议不写入正式风险 |
| iOS 双模式扫描 | 已实现 | RoomPlan/LiDAR `spatial_ar`；其他 ARKit 设备 `camera_2d` |
| 代表帧 | 已实现 | 2 秒候选、质量/变化门控、5 秒模型间隔、30 次上限、顺序上传与部分成功 |
| `ios_camera_frame` | 已实现 | 可进入现有 v2 正式分析、覆盖度和改造预览 |
| 档案门禁 | 已实现 | H5 受控 `return_to`；后端 `409 profile_incomplete` |
| 历史 fair 链路 | 已移除 | API/Provider/DTO/规则/价格/Zone UI/原生报告不再使用；旧路径 404 |
| 新数据库 fair 表 | 已移除 | 现有生产数据库历史表不做破坏性 DROP |
| AI 适老顾问 | 已实现代码 | 扫描页内顶部指引、提示上下文、文字/语音抽屉；`/advisor/:roomId` 只承担正式结果后追问 |
| 火山 RTC 音视频顾问 | 已实现代码，待外部验证 | 服务端 `/realtime` 启动视觉任务；H5 复用浏览器相机 Track，iOS 推送 ARFrame 外部 NV12 视频；正常 720p/15fps/900kbps，弱网、AR 掉帧或设备过热时降至 540p/10fps/500kbps |
| 显式稳定帧与 Function Calling | 已实现代码，待真实账号验证 | 720px 检查图片登记、60KB 分片、GroupID 清理、签名/房间/任务/inspection 归属校验、工具幂等；健康能力仅在 30 分钟内完成过签名视觉工具闭环时为真 |
| RTC 代表帧衔接 | 已实现代码 | H5/iOS 均使用最多 8 张、24MB 临时缓存，优先建议引用帧、感知哈希去重并最多上传 6 张；正式分析重新识别 |
| iOS 深度上下文锁 | 已实现代码 | `AnjuCore` actor 容量 8；`inspection_id → frame_id` 严格锁定，锁定帧不淘汰；不匹配、过期或无深度时只显示二维提示，35 秒兜底释放 |
| RTC 全局席位与设备租约 | 已实现代码 | 全局最多 8 个 `granted/active/draining`，FIFO 队列最多 50；20 秒获席保留、20 秒心跳、90 秒设备租约，同房间不同设备不可同时启动 |
| H5 顾问排队页 | 已实现代码 | `/advisor-queue/:roomId` 隐藏底部导航，2 秒轮询、取消、获席后自动返回；不展示不可靠预计时间 |
| 扫描顾问与自动分析 | 已实现代码 | H5/iOS 共用 `camera_session_id`/房间对话历史；结束扫描后补档或直接启动分析，不再进入待确认顾问页 |

## 仍需外部验证

- 在一台 LiDAR 和一台非 LiDAR iPhone 上完成 TestFlight P01—P09 冒烟。
- 验证旋转 JPEG、模型 bbox、深度图和世界锚点的真机坐标一致性。
- 验证权限拒绝、前后台、系统中断、弱网、模型超时、上传中断、媒体已满和 H5 发布版本变化。
- 在 Safari、Chrome 和 App 内 `WKWebView` 验证新手引导的双挖孔定位、安全区、横竖屏、VoiceOver 焦点与系统文件/相机弹窗恢复。
- 配置获授权且确实支持实时视觉与 Function Calling 的火山 endpoint，验证公网回调可达、`StartVoiceChat` 参数与图片消息/分片协议；配置完整目前只代表静态预检通过。
- 完成外部 H5 与 iOS 原生 RTC 视频各 10 分钟通话、首帧/结构化建议时延、三次打断、镜头转向、前后台和来电/音频中断恢复门禁。
- 在 LiDAR 与非 LiDAR iPhone 各验证两个 3 秒窗口低于 24fps 降档、10 秒稳定恢复、`serious/critical` 热状态与延迟回调不误建锚点。
- 完成 8+1 真实设备压测：8 个独立 assessment/room 同时占席，第 9 台 FIFO 排队，释放后自动获席，TTS 并发不超限。
- 连续三次完成“选房 → 扫描 → 自动上传 → 补档案 → 删除/补拍 → 正式分析 → 方案和报告”。
- 建立授权评测集后才能给出真实模型召回、误报和定位结论。

## 发布顺序

1. 发布后端/H5，保持 `ANJU_ENABLE_RTC_VIDEO_ADVISOR=0` 与 `ANJU_ENABLE_IOS_HOME_CAMERA=0`。
2. 在公网候选环境完成回调与模型能力门禁，再发布新 iOS 并完成双设备冒烟。
3. 先开启 `ios_home_camera`，再小范围开启 `rtc_video_advisor`；持续观察回退率、时延、超时、上传失败和容器重启。

比赛现场每台设备必须新建独立 assessment 和 room，不共享链接、`room_id`、RTC Token 或浏览器标签页。

旧 App 从切换时起不再受支持。当前代码完成不等于真机和模型效果验收已完成。
