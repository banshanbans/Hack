# 长者友好家 H5 与本地服务

该服务同时保留 iOS 使用的 v1 Session API，并提供照片 H5 使用的 v2 Assessment API。v2 使用 SQLite 保存评估、反馈、整改方案、分享记录和事件，分析图片保存为已规范化副本。

## 安装与启动

后端已完整迁移到 FastAPI。建议使用项目虚拟环境安装精确锁定的依赖：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
```

先构建 React，再启动单 worker ASGI 服务：

```bash
cd frontend
npm install
npm run build
cd ..
uvicorn backend.app.asgi:app --host 127.0.0.1 --port 8080 --workers 1
```

`python3 -m backend.app.server` 是调用同一 Uvicorn 应用的兼容入口，不再启动旧 `ThreadingHTTPServer`。

复制本地配置并填写服务端密钥，后端会自动读取项目根目录 `.env`：

```bash
cp .env.example .env
# 编辑 .env，只在本机填写 ARK_API_KEY
.venv/bin/python -m backend.app.server
```

也可用 `ANJU_ENV_FILE=/absolute/path/to/file` 指定其他配置文件。进程环境变量优先于文件内容，生产容器仍通过 Compose `env_file` 注入，不依赖镜像内 `.env`。

如需切换回 OpenAI，设置 `ANJU_VISION_PROVIDER=openai`、`OPENAI_API_KEY` 和 `ANJU_OPENAI_MODEL`。

显式演示：

```bash
ANJU_MOCK_ANALYSIS=1 .venv/bin/python -m backend.app.server
```

访问 `http://127.0.0.1:8080`。演示模式会在页面顶部显示固定样例提示；正式分析失败时不会回退到演示数据。

## 环境变量

- `ANJU_VISION_PROVIDER`：`ark` 或 `openai`；样例配置默认使用方舟。
- `ARK_API_KEY`：火山方舟服务端密钥，只通过运行时环境变量注入。
- `ANJU_ARK_MODEL`：默认 `doubao-seed-2-1-pro-260628`。
- `ANJU_ARK_ENDPOINT`：默认 `https://ark.cn-beijing.volces.com/api/v3/responses`。
- `OPENAI_API_KEY` / `ANJU_OPENAI_MODEL`：切换到 OpenAI Provider 时使用。
- `ANJU_ANALYSIS_TIMEOUT_SECONDS`：模型请求超时，默认 60 秒；网络超时最多重试一次。
- 方舟 Responses API 请求固定发送 `thinking.type=disabled`，关闭深度思考以降低质量检查和风险定位延迟。
- 方舟图片质量检查使用 `detail=low`，正式风险分析使用其支持的最高细节等级 `detail=high`。
- `ANJU_DB_PATH`：SQLite 路径，默认 `backend/data/anju.db`。
- `ANJU_MEDIA_ROOT`：规范化图片目录，默认 `backend/data/media`。
- `ANJU_SHARE_TTL_HOURS`：分享有效期，默认 24 小时，最大 168 小时。
- `ANJU_MOCK_ANALYSIS=1`：显式启用固定演示 Provider，默认关闭。
- `ANJU_HOST` / `ANJU_PORT`：默认 `127.0.0.1:8080`。
- `ANJU_STATIC_ROOT`：React 构建目录，默认 `frontend/dist`；缺失时 `/` 明确返回 503。
- `ANJU_ENABLE_API_DOCS=1`：仅在开发环境启用 Swagger、ReDoc 和 OpenAPI JSON。
- `ANJU_ALLOWED_HOSTS`：受信 Host 白名单，生产需要加入实际域名。
- `ANJU_FORWARDED_ALLOW_IPS`：允许提供转发头的边缘代理 IP，默认只信任本机。
- `ANJU_ENABLE_H5_VIDEO` / `ANJU_ENABLE_H5_CAMERA` / `ANJU_ENABLE_IOS_FAIR_AR`：P0—P2 独立能力开关，默认关闭，本地 `.env` 可显式开启。
- `ANJU_ARK_TURBO_MODEL`：游园会实时候选模型，当前验证值为 `doubao-seed-2-0-lite-260215`。
- `ANJU_ARK_PRO_MODEL`：游园会扫描后复核模型，当前验证值为 `doubao-seed-2-1-pro-260628`。

不要把 `.env`、密钥、数据库或用户照片提交到仓库。对外部署时必须使用 HTTPS，并为数据目录配置备份和删除策略。

## P0—P2 范围

- React 19 + TypeScript + Vite 的 P01—P09 主流程；
- 三项家人档案；
- 六类房间入口与可执行的基础风险、覆盖度、评分、A/B/C 方案和预算规则；
- 1—6 张照片上传、浏览器去 EXIF/缩放、质量检查；
- 火山方舟或 OpenAI Responses API 结构化视觉候选；
- 前端 SVG 风险标注、反馈与重新圈选；
- A/B/C 方案、参考价格、清单和报告 PNG 长图下载；旧只读分享 API 仅保留兼容；
- H5 视频只在浏览器解码，确认后上传 3—6 张代表帧，并保存来源字段用于跨帧合并；
- H5 相机使用临时检查接口和 `anju_h5_camera_adaptive_v1`，临时帧响应后删除，不进入分数；
- iPhone 游园会使用四 Zone、`anju_ios_fair_turbo_v1` 和 `anju_ios_fair_review_pro_v1`，Pro 后由规则生成参考分和 A/B/C 预算。

整改复查对比和 PDF 导出仍不在本次范围；移动浏览器和 LiDAR 真机效果以外部验收记录为准。

## 测试

```bash
.venv/bin/python -m unittest discover -s backend/tests -v
cd frontend && npm run typecheck && npm test && npm run build
python3 scripts/check_product_copy.py
```

单元测试使用本地 Stub 或显式 Demo Provider，不产生真实模型费用。真实调用必须同时设置 `ANJU_RUN_LIVE_TESTS=1` 和服务端密钥后单独执行人工样本验证。
