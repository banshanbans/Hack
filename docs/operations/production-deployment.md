# 长者友好家生产部署运行手册

目标主机为 `ubuntu@1.14.75.189`，H5 使用 `shot.socialdog.cn`，API 使用
`shotapi.socialdog.cn`。本手册只描述可审计的 Docker Compose 发布；不得把本地
`.env`、API Key、用户照片或数据库复制进源码 release 或镜像。

## 1. 生产拓扑与边界

- `anju-app`：单 worker Uvicorn，同时提供 React 静态文件与 v1/v2 API；
- `caddy`：唯一公网入口，复用现有 TLS 数据卷；
- `/opt/anju/releases/<git-sha>`：不可变源码快照；
- `/opt/anju/current`：指向当前 release 的软链接；
- `/opt/anju/shared/.env.production`：权限 `0600` 的运行配置；
- `/opt/anju/shared/data`：SQLite 与规范化媒体副本；
- `/opt/anju/backups`：仅 root 可读的发布前备份。

SQLite 模式必须保持单 worker、单应用副本。`anju-app` 不映射公网端口，只有
Caddy 暴露 80/443。正式照片分析默认使用
`doubao-seed-2-1-pro-260628`；iOS 实时帧的候选配置为
`doubao-seed-2-1-turbo-260628`。方舟请求发送 `thinking.type=disabled`；最终风险等级、评分和预算仍由本地规则决定。
iOS 模型切换在完成[统一相机路线](../product/camera-roadmap.md)中的发布门禁前不得上生产。

## 2. 发布内容与密钥准备

发布只能来自明确的 Git SHA。工作区存在未提交改动时，先确认并提交需要上线的
内容，不得用 rsync 静默发布脏工作区。

在服务器创建目录：

```bash
sudo install -d -m 0755 /opt/anju/releases /opt/anju/deploy
sudo install -d -m 0700 /opt/anju/shared /opt/anju/shared/data /opt/anju/backups
sudo chown -R 10001:10001 /opt/anju/shared/data
```

从 `deploy/env.production.example` 生成 `/opt/anju/shared/.env.production`，只在
服务器填写真实 `ARK_API_KEY`：

```bash
sudo install -m 0600 deploy/env.production.example /opt/anju/shared/.env.production
sudoedit /opt/anju/shared/.env.production
```

必须确认：

- `ANJU_MOCK_ANALYSIS=0`；
- `ANJU_VISION_PROVIDER=ark`；
- `ANJU_ARK_MODEL=doubao-seed-2-1-pro-260628`；
- `ANJU_ARK_HOME_CAMERA_MODEL=doubao-seed-2-1-turbo-260628`；
- `ANJU_ENABLE_IOS_HOME_CAMERA=0`（新 App 公网冒烟后再开启）；
- `ANJU_ALLOWED_HOSTS` 只包含两个生产域名及容器健康检查需要的本机 Host；
- `ANJU_FORWARDED_ALLOW_IPS=172.30.25.2`；
- `.env.production` 未进入 release、镜像或 Git。

## 3. 本地发布门禁

从待发布提交执行：

```bash
make test
git diff --check
```

随后记录 SHA 并构建不可变镜像：

```bash
release_sha="$(git rev-parse HEAD)"
docker build -f deploy/Dockerfile -t "anju-app:${release_sha}" .
docker image inspect "anju-app:${release_sha}" --format '{{.Id}}'
```

发布记录至少保存 release SHA、镜像 digest、执行人、时间、环境变量名变更、门禁
结果、备份位置和回滚点；不得记录密钥值。

## 4. 上传 release 与生产配置

将精确源码快照放到 `/opt/anju/releases/<git-sha>`，并把 `deploy/Caddyfile`、
`deploy/compose.production.yml` 放到 `/opt/anju/deploy`。生产镜像使用同一 SHA
标签。若镜像在本地构建，应通过受控镜像仓库或 `docker save`/`docker load` 传输，
传输后再次核对 digest。

Compose 的 `${ANJU_RELEASE}` 是部署时变量，不从容器 `env_file` 解析。每次命令都
必须显式传入：

```bash
ANJU_RELEASE="<git-sha>" \
ANJU_ENV_FILE=/opt/anju/shared/.env.production \
docker compose -f /opt/anju/deploy/compose.production.yml config --quiet
```

不要执行会渲染并输出完整环境值的调试命令。

## 5. 候选版本验证（切流前）

先用独立容器绑定回环端口，不占用 80/443：

```bash
docker run --rm -d \
  --name anju-candidate \
  --env-file /opt/anju/shared/.env.production \
  -e ANJU_HOST=0.0.0.0 \
  -e ANJU_ALLOWED_HOSTS=127.0.0.1,localhost \
  -p 127.0.0.1:18080:8080 \
  -v /opt/anju/shared/data:/app/data \
  "anju-app:<git-sha>"
```

至少验证：

```bash
curl --fail --silent --show-error http://127.0.0.1:18080/ >/dev/null
curl --fail --silent --show-error http://127.0.0.1:18080/health
```

`/health` 必须为 200，且 `analysis` 必须为 `ark`，不得是 `demo` 或
`not_configured`。使用仓库允许发布的测试图片走完：创建 assessment、保存档案、
创建房间、上传、质量检查、发起分析、轮询完成、读取结果、生成报告、删除临时
assessment。还要验证：

- 非法 Host 被拒绝；
- 超过 6 MiB 的请求被拒绝；
- 未授权 assessment 访问被拒绝；
- 容器重启后 SQLite/media 仍可读取；
- 日志不包含密钥、原图、完整档案或内部堆栈；
- 分析事件记录的模型名为 Pro ID，且没有启用 Demo 回退。

验证后停止候选容器：

```bash
docker stop anju-candidate
```

## 6. 首次替换旧 SoloShot

1. 核对 DNS、安全组仅开放 22/80/443，并验证 SSH ED25519 指纹；
2. 记录旧 `/opt/soloshot` Compose 配置、容器状态和镜像 ID；
3. 备份旧配置及 Caddy/PostgreSQL/Redis/MinIO 命名卷，备份权限设为 `0600`；
4. 备份当前 `/opt/anju/shared/data`（若存在），并验证备份可读；
5. 校验新 Caddyfile 和 Compose 配置；
6. 停止旧 SoloShot 栈，但不得执行 `down -v`、删除镜像或删除旧目录；
7. 启动新栈：

```bash
ANJU_RELEASE="<git-sha>" \
ANJU_ENV_FILE=/opt/anju/shared/.env.production \
docker compose -f /opt/anju/deploy/compose.production.yml up -d
```

8. 等待 `anju-app` 健康后确认 Caddy 已启动；
9. 将 `/opt/anju/current` 原子更新到对应 release；
10. 从服务器本机和外部网络执行第 7 节验收；
11. 连续观察至少 15 分钟后再宣布切换完成。

稳定观察期建议 7 天。维护者确认后才可清理旧容器和旧业务数据；清理前再次制作
可恢复备份。

## 7. 公网验收

```bash
curl --fail --silent --show-error https://shot.socialdog.cn/ >/dev/null
curl --fail --silent --show-error https://shot.socialdog.cn/health
curl --fail --silent --show-error https://shotapi.socialdog.cn/health
```

另外验证：

- H5 静态资源无 404，主流程可完成；
- API 子域只开放 `/api/*` 和 `/health`，其他路径返回 404；
- `/docs`、`/redoc`、`/openapi.json` 不可访问；
- HTTPS 证书、HTTP 跳转、gzip/zstd 正常；
- 无持续 5xx、容器重启、SQLite 写入失败或模型超时；
- `docker compose ps` 显示应用健康；
- 不在终端打印 Compose 展开的密钥配置。

## 8. 普通版本更新

普通更新重复“发布门禁 → 固定 SHA 镜像 → 候选验证 → 数据备份”。确认数据库
Schema 向前/向后兼容后，再用新 `ANJU_RELEASE` 执行 `docker compose up -d`。
保留上一个镜像、release 目录和与其兼容的数据备份。不得使用 `latest` 作为唯一
版本标识。

## 9. 回滚

以下任一情况立即回滚：公网健康检查失败、持续 5xx、H5 主路径不可用、容器反复
重启、SQLite 无法写入、模型凭据或证书异常、敏感信息泄漏。

普通版本回滚：

```bash
ANJU_RELEASE="<previous-git-sha>" \
ANJU_ENV_FILE=/opt/anju/shared/.env.production \
docker compose -f /opt/anju/deploy/compose.production.yml up -d
```

如有不兼容 Schema，先停止新应用，再恢复与旧镜像对应的 SQLite/media 备份。首次
替换失败时，停止 Anju 栈并保留现场，恢复旧 Caddy/TLS 卷引用和 `/opt/soloshot`
Compose 栈。回滚后验证旧域名与健康检查，记录失败时间、release SHA 和日志摘要。
任何回滚都不得删除故障现场或新旧数据卷。

## 10. 运行维护

- 每日使用 SQLite 在线备份机制备份数据库和媒体目录，默认保留 7 天；
- 监控 HTTPS、`/health`、容器重启数、磁盘、备份结果和模型超时率；
- 磁盘 70% 告警，80% 停止非必要上传并人工处理；
- Docker 日志保持 `10m × 3` 轮转；
- 用户删除请求同步删除在线数据，备份在生命周期结束后自然淘汰；
- 模型密钥只在 `/opt/anju/shared/.env.production` 或密钥管理服务中维护；
- 密钥轮换后重建应用容器并重新执行真实 Provider 健康与主链路验证。
