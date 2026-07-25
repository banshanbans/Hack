# 生产部署运行手册

生产目标为 `1.14.75.189` 上的 Docker Compose，使用现有
`shot.socialdog.cn` 与 `shotapi.socialdog.cn` 域名。详细安全边界、
服务器基线、首次切换和回滚要求见工作区根目录 `AGENTS.md` 第 21 节。

## 架构

- `anju-app`：单 worker Uvicorn，同时提供 React 构建产物与 v1/v2 API；
- `caddy`：唯一公网入口，复用现有 `soloshot_caddy_data` TLS 数据卷；
- `/opt/anju/shared/data`：SQLite 和媒体文件持久化目录；
- `/opt/anju/shared/.env.production`：权限 `0600` 的生产配置。

SQLite 部署不得增加 worker 或应用副本。应用容器不映射公网端口。

## 发布前检查

```bash
.venv/bin/python -m unittest discover -s backend/tests -v
cd frontend
npm ci
npm run typecheck
npm test
npm run build
cd ..
python3 scripts/check_product_copy.py
docker build -f Dockerfile.production -t anju-app:<git-sha> .
```

生产环境文件从 `deploy/env.production.example` 创建。不得把真实密钥写入
仓库、镜像、部署日志或 Compose 渲染输出。

## 公网路由

- `shot.socialdog.cn/*` 转发到 `anju-app:8080`；
- `shotapi.socialdog.cn/api/*` 和 `/health` 转发到同一应用；
- API 子域其他路径返回 404；
- Swagger、ReDoc 和 OpenAPI JSON 在生产关闭。

首次切换前必须备份旧 `/opt/soloshot` 配置、容器镜像 ID 和命名卷。
首次切换不得删除旧目录、旧镜像或执行 `docker compose down -v`。

## 验收

切换前先在 `127.0.0.1:18080` 验证候选镜像。公网切换后至少检查：

```bash
curl --fail --silent --show-error https://shot.socialdog.cn/ >/dev/null
curl --fail --silent --show-error https://shot.socialdog.cn/health
curl --fail --silent --show-error https://shotapi.socialdog.cn/health
```

`/health` 中 `analysis` 必须为已配置的真实 Provider，不得为
`not_configured` 或 `demo`。还应使用非真实家庭测试图片完成一次创建评估、
档案、房间、上传、分析、报告的主链路。

## 回滚

保留上一个 `anju-app:<git-sha>` 镜像、对应 SQLite 备份和旧 SoloShot 栈。
新版本失败时先保留现场，再切回旧 Caddy/Compose 配置；不得在故障处理中
删除新旧数据卷。数据库 Schema 有变化时必须使用与旧镜像兼容的备份。
