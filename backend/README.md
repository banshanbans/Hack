# 本地开发服务

该服务用于跑通 Session、关键帧结构化响应、反馈、完成报告、分享 token 和照片 H5。它不包含真实视觉模型。

启动：

```bash
python3 -m backend.app.server
```

环境变量：

- `ANJU_HOST`：默认 `127.0.0.1`；
- `ANJU_PORT`：默认 `8080`；
- `ANJU_MOCK_ANALYSIS=1`：显式启用一个固定演示问题；默认返回空数组。

健康检查：`GET /health`。

面向 iOS 真机部署时，请使用 HTTPS 反向代理或托管平台。iOS 客户端会拒绝 HTTP 分析地址。
