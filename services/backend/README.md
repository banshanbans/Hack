# 长者友好家 H5 与本地服务

该服务同时保留 iOS 使用的 v1 Session API，并提供照片 H5 使用的 v2 Assessment API。v2 使用 SQLite 保存评估、反馈、整改方案、分享记录和事件，分析图片保存为已规范化副本。

## 安装与启动

后端已完整迁移到 FastAPI。建议通过仓库统一入口安装精确锁定的依赖：

```bash
make setup
```

先构建 React，再启动单 worker ASGI 服务：

```bash
make build-web
make dev-api
```

`PYTHONPATH=services python3 -m backend.app.server` 是调用同一 Uvicorn 应用的兼容入口，不再启动旧 `ThreadingHTTPServer`。

复制本地配置并填写服务端密钥，后端会自动读取项目根目录 `.env`：

```bash
cp .env.example .env
# 编辑 .env，只在本机填写 ARK_API_KEY
make dev-api
```

也可用 `ANJU_ENV_FILE=/absolute/path/to/file` 指定其他配置文件。进程环境变量优先于文件内容，生产容器仍通过 Compose `env_file` 注入，不依赖镜像内 `.env`。

如需切换回 OpenAI，设置 `ANJU_VISION_PROVIDER=openai`、`OPENAI_API_KEY` 和 `ANJU_OPENAI_MODEL`。

显式演示：

```bash
ANJU_MOCK_ANALYSIS=1 make dev-api
```

访问 `http://127.0.0.1:8080`。演示模式会在页面顶部显示固定样例提示；正式分析失败时不会回退到演示数据。

## 环境变量

- `ANJU_VISION_PROVIDER`：`ark` 或 `openai`；样例配置默认使用方舟。
- `ARK_API_KEY`：火山方舟服务端密钥，只通过运行时环境变量注入。
- `ANJU_ARK_MODEL`：默认 `doubao-seed-2-1-pro-260628`。
- `ANJU_ARK_ENDPOINT`：默认 `https://ark.cn-beijing.volces.com/api/v3/responses`。
- `OPENAI_API_KEY` / `ANJU_OPENAI_MODEL`：切换到 OpenAI Provider 时使用。
- `ANJU_ANALYSIS_TIMEOUT_SECONDS`：模型请求超时，默认 60 秒；网络超时最多重试一次。
- `ANJU_TURBO_MAX_CONCURRENCY`：进程内 H5 实时相机并发上限，默认 2；满载的新帧快速返回可重试的 429。
- `ANJU_PRO_MAX_CONCURRENCY`：进程内质量检查、正式照片分析和 iOS 实时视觉分析共享并发上限，默认 1；等待过程在线程池完成，不阻塞事件循环。
- 方舟 Responses API 请求固定发送 `thinking.type=disabled`，关闭深度思考以降低质量检查和风险定位延迟。
- 方舟图片质量检查使用 `detail=low`，正式风险分析使用其支持的最高细节等级 `detail=high`。
- `ANJU_DB_PATH`：SQLite 路径，默认 `services/backend/data/anju.db`。
- `ANJU_MEDIA_ROOT`：规范化图片目录，默认 `services/backend/data/media`。
- `ANJU_SHARE_TTL_HOURS`：分享有效期，默认 24 小时，最大 168 小时。
- `ANJU_MOCK_ANALYSIS=1`：显式启用固定演示 Provider，默认关闭。
- `ANJU_HOST` / `ANJU_PORT`：默认 `127.0.0.1:8080`。
- `ANJU_STATIC_ROOT`：React 构建目录，默认 `apps/web/dist`；缺失时 `/` 明确返回 503。
- `ANJU_ENABLE_API_DOCS=1`：仅在开发环境启用 Swagger、ReDoc 和 OpenAPI JSON。
- `ANJU_ALLOWED_HOSTS`：受信 Host 白名单，生产需要加入实际域名。
- `ANJU_FORWARDED_ALLOW_IPS`：允许提供转发头的边缘代理 IP，默认只信任本机。
- `ANJU_ENABLE_H5_VIDEO`：历史兼容开关。2026-08-06 起本地视频关键帧能力已取消，必须保持关闭，不作为可启用产品能力。
- `ANJU_ENABLE_H5_CAMERA` / `ANJU_ENABLE_IOS_HOME_CAMERA`：H5 和 iPhone 居家实时相机开关，均默认关闭，便于分阶段发布。
- `ANJU_ENABLE_VOICE_ADVISOR`：房间级 AI 适老顾问实时语音开关，默认关闭；文字顾问不依赖此开关。
- `ANJU_ENABLE_KNOWLEDGE_ADVISOR`：首页通用 AI 适老顾问开关，默认关闭。匿名对话使用独立 token 和数据表，按最后活动后 24 小时滑动过期，不创建 assessment/room。
- `ANJU_KNOWLEDGE_ADVISOR_MODEL`：通用知识问答的可选模型覆盖；未设置时复用当前 Ark/OpenAI 正式分析模型。
- `ANJU_KNOWLEDGE_ADVISOR_TIMEOUT_SECONDS`：通用文字问答超时，默认 30 秒。正式失败不回退固定答案。
- `ANJU_ENABLE_RTC_VIDEO_ADVISOR`：扫描页 RTC 视频与视觉 Function Calling 开关，默认关闭；关闭后继续使用 RTC 音频和 HTTP 临时检查。
- `ANJU_ADVISOR_MAX_ACTIVE_RTC`：全局 RTC 席位上限，默认并强制最大为 8，为 10 路 TTS 并发保留 2 路余量。
- `ANJU_ADVISOR_MAX_QUEUED`：有效 FIFO 排队票据上限，默认 50；超过后返回 `429 advisor_capacity_busy`。
- `ANJU_ADVISOR_QUEUE_TTL_SECONDS` / `ANJU_ADVISOR_QUEUE_GRANT_SECONDS`：默认排队 180 秒、获席后保留 20 秒。
- `ANJU_ADVISOR_DEVICE_LEASE_SECONDS`：同房间设备租约和无心跳回收周期，默认 90 秒。
- `ANJU_VOLC_FC_CALLBACK_URL`：火山 Function Calling 公网 HTTPS 回调地址，生产建议为 `/api/internal/rtc/function-calls`。
- `ANJU_VOLC_FC_CALLBACK_SIGNATURE`：独立高熵回调签名，只存服务端，不得复用 assessment token 或写入日志。
- `/health` 的 `rtc_video_advisor` 只有在静态配置完整且最近 30 分钟内成功完成一次签名视觉帧 Function Calling 后才为 `true`；服务重启后需重新执行探测。
- `ANJU_VOLC_RTC_APP_ID` / `ANJU_VOLC_RTC_APP_KEY`：火山 RTC 应用凭据；AppKey 仅限服务端，浏览器只领取 15 分钟房间 Token。
- `ANJU_VOLC_ACCESS_KEY` / `ANJU_VOLC_SECRET_KEY`：服务端调用 `StartVoiceChat` / `StopVoiceChat` 的火山 OpenAPI 凭据。
- `ANJU_DOUBAO_SPEECH_API_KEY`：新版豆包语音直连 API Key，仅用于 Speech API；RTC `StartVoiceChat` 使用账号下已绑定的 ASR/TTS 资源，不将该 Key 下发给客户端。
- `ANJU_DOUBAO_ASR_RESOURCE_ID` / `ANJU_DOUBAO_TTS_RESOURCE_ID` / `ANJU_DOUBAO_TTS_VOICE`：直连语音资源与默认音色；当前默认为 ASR 2.0 小时版、TTS 2.0 和 Vivi 2.0。
- `ANJU_VOLC_VOICE_CONFIG_JSON`：`StartVoiceChat` 的 ASR/TTS/LLM 模板 JSON，可能包含厂商密钥，禁止提交或下发到前端。
- `ANJU_VOLC_VOICE_API_VERSION`：火山 AI 音视频互动 API 版本，当前默认 `2025-06-01`；必须使用“音视频互动智能体”应用 AppId。
- `ANJU_VOLC_VOICE_MODEL_ID`：语音顾问实时 LLM 的日志标识，应与 `ANJU_VOLC_VOICE_CONFIG_JSON.Config.LLMConfig.ModelName` 一致。
- `ANJU_ENABLE_RENOVATION_PREVIEW`：房间级 AI 改造效果预览开关，默认关闭；只在用户已选择方案并主动确认原图后调用。
- `ANJU_ARK_IMAGE_EDIT_MODEL` / `ANJU_ARK_IMAGE_EDIT_ENDPOINT`：火山图片编辑模型和端点，默认使用 `doubao-seedream-4-5-251128`。
- `ANJU_ARK_IMAGE_EDIT_SIZE`：图片编辑输出清晰度，默认 `2K`。
- `ANJU_ARK_RENOVATION_GROUNDING_MODEL`：对比改造前后图片并返回生成细节归一化 bbox 的结构化视觉模型；未设置时使用 `ANJU_ARK_MODEL`。定位失败不会使效果图生成失败。
- `ANJU_RENOVATION_PREVIEW_TIMEOUT_SECONDS`：图片编辑供应商请求超时，默认 90 秒；生成结果只接受经过限大和图片格式校验的 Base64 数据。
- `ANJU_RENOVATION_PREVIEW_DAILY_LIMIT`：每个房间滚动 24 小时内最多创建的效果版本数，默认 3。
- `ANJU_ARK_HOME_CAMERA_MODEL`：H5 与 iOS 共用的 HTTP 临时检查模型；RTC 不可用或连续失败时回退使用，未设置时回退到 `ANJU_ARK_TURBO_MODEL`。
- `ANJU_ARK_TURBO_MODEL`：H5/iOS 实时相机的兼容回退配置。
- `ANJU_ARK_PRO_MODEL`：保留给正式照片或后续 iOS Pro 复核流程，不再决定 iOS 实时帧模型。

不要把 `.env`、密钥、数据库或用户照片提交到仓库。对外部署时必须使用 HTTPS，并为数据目录配置备份和删除策略。

## 当前产品范围

- React 19 + TypeScript + Vite 的 P01—P09 主流程；
- 三项家人档案；
- 六类房间入口与可执行的基础风险、覆盖度、评分、A/B/C 方案和预算规则；
- 1—6 张照片上传、浏览器去 EXIF/缩放、质量检查；
- 火山方舟或 OpenAI Responses API 结构化视觉候选；
- 前端 SVG 风险标注、反馈与重新圈选；
- A/B/C 方案、参考价格、清单和报告 PNG 长图下载；旧只读分享 API 仅保留兼容；
- 房间级 AI 改造效果预览：按已选方案生成前后对比并可保存进报告；生成图不是风险证据、评分输入或整改后复查结果；
- H5 正式评估只接收照片；本地视频选择、自动抽帧和 `video_frame` 正式识别已取消，既有字段与代码仅作历史兼容并保持关闭；
- H5 与 iOS 使用房间绑定的临时检查接口与 `anju_home_camera_discovery_v1`；服务端从 `room_id` 获取房型，不信任客户端声明，临时建议不写入正式风险。
- iOS 代表帧以 `ios_camera_frame` 上传；扫描结束后只完成 camera session 并返回照片页，由用户点击“开始 AI 检查”发起正式分析，`ios_ar_frame` 只做历史可读兼容。
- H5 与 iOS `WKWebView` 共用 `/advisor/:roomId` 文字/语音顾问页；临时提示和正式风险分阶段展示，业务写操作需确认卡，原始音频不入库。
- RTC 启动前必须调用 `POST .../rtc-queue` 取得席位，再以 `X-Advisor-Client-ID` 和 `X-Advisor-Queue-Ticket` 调用 `/voice` 或 `/realtime`；获席后每 20 秒心跳，退出时删除票据。
- 顾问事件断线后通过 `POST .../events-token` 重签两分钟、单次消费的 WebSocket token；访问日志会统一遮蔽 token 查询参数。写操作确认按 `pending → processing → approved/rejected` 原子领取，失败标记为 `failed`。
- 新数据库不再创建 fair 表，旧数据库历史表不做破坏性删除，`/api/v2/fair-scans` 固定返回 404。

整改复查对比和 PDF 导出仍不在本次范围；移动浏览器和 LiDAR 真机效果以外部验收记录为准。本地视频关键帧能力不进入后续验收。

## 测试

```bash
make test
```

单元测试使用本地 Stub 或显式 Demo Provider，不产生真实模型费用。真实调用必须同时设置 `ANJU_RUN_LIVE_TESTS=1` 和服务端密钥后单独执行人工样本验证。
