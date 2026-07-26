# 长者友好家

长者友好家是基于 RASSAR 二次开发的环境安全辅助筛查产品。当前 iPhone 版只用于游园会现场，通过分 Zone 空间扫描、云端 Pro 级模型实时发现和服务端确定性规则生成辅助报告，扫描结束时不再发起第二次模型复核。

本产品不是医疗诊断、建筑验收、无障碍认证或施工鉴定工具。所有建议都需要结合现场情况判断。

## 当前可运行范围

- 首页 → 游园会 Zone 准备 → 扫描 → 问题详情 → 报告；
- 10 类适老化安全规则，规则等级由本地知识库决定；
- 世界锚点、屏幕短标签、空间去重、稳定观测和 dismiss 抑制；
- iPhone 风险发现不使用端侧 Core ML；本地仅保留画质/变化门控和 ARKit/RoomPlan 定位；
- HTTPS 关键帧分析接口、结构化响应校验、白名单和最多 5 项限制；
- 历史帧位姿、内参和深度反投影；无可靠深度时只生成证据卡；
- 多来源候选融合、问题位置图、可选中文语音提示；
- 确认、忽略、标记已处理、优先级报告和系统分享；
- FastAPI/Uvicorn 单进程服务、SQLite 持久化和 React 九页照片 H5；
- 默认空分析实现和显式隔离的演示 fixture。

## iOS 构建

要求：

- Xcode 14 或更高版本；
- iOS 16.1 或更高版本；
- 真正的房间扫描需要支持空间扫描的 iPhone；
- 真机安装前请在 Xcode 中选择自己的签名团队。

打开 `RASSAR App.xcodeproj`，选择 scheme `RetroAccess App`。命令行无签名编译：

```bash
xcodebuild \
  -project "RASSAR App.xcodeproj" \
  -scheme "RetroAccess App" \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/anjuguard-build \
  CODE_SIGNING_ALLOWED=NO \
  build
```

离线演示问题只在添加启动参数 `-AnjuDemoIssues` 后启用。若要在模拟器直接验收报告页面，可在 Debug scheme 添加 `-AnjuOpenDemoReport`。这两个入口均由显式启动参数控制，正式运行不会硬编码检测结果。

远端分析默认关闭。要启用，请在 scheme 环境变量中设置 HTTPS 地址：

```text
ANJU_ANALYSIS_BASE_URL=https://your-service.example
```

App 不接受 HTTP 地址，也不携带模型厂商永久密钥。

## 本地领域测试

```bash
cd Packages/AnjuCore
swift test
```

覆盖规则解析、类型白名单、等级规则、证据要求、空间去重、稳定升级、状态转换、报告排序、bbox 校验、深度离群值过滤、历史帧反投影、远端 schema 和多来源融合。

## 本地开发服务与 H5

安装锁定依赖并构建 React：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
cd frontend && npm install && npm run build && cd ..
.venv/bin/python -m backend.app.server
```

然后打开 `http://127.0.0.1:8080`。FastAPI 同时提供 v1/v2 API 和 `frontend/dist`；缺少构建产物时返回 503。只有显式设置下面的环境变量才会返回固定演示结果：

```bash
ANJU_MOCK_ANALYSIS=1 .venv/bin/python -m backend.app.server
```

后端测试：

```bash
.venv/bin/python -m unittest discover -s backend/tests -v
cd frontend && npm run typecheck && npm test && npm run build
```

v2 将状态保存到 SQLite，并在 `ANJU_MEDIA_ROOT` 保存规范化分析副本；用户删除照片或评估时同步删除。面向真机或外部网络部署时，必须放在 HTTPS 入口后，并将模型密钥放在服务端环境变量或密钥管理服务中。

## 关键数据流

```text
本地检测 / 房间对象 / 远端候选
  → 白名单与证据校验
  → 本地规则决定风险等级
  → 历史帧深度反投影或 Raycast
  → 空间去重与稳定观测
  → 世界锚点；无世界点则证据卡
  → 用户确认 / 忽略 / 已处理
  → 按优先级报告
```

## 验证状态

当前已完成：

- Swift 领域测试通过；
- Python 后端测试通过；
- 规则 JSON、产品文案和工程文件校验通过；
- generic iOS Debug 无签名编译通过；
- iPhone 17 Pro（iOS 26.3）模拟器 Debug 编译、安装和首页启动通过；
- FastAPI 健康检查、React H5 九页主路径和 v1/v2 请求通过。

当前未完成的外部验证：

- 尚未在 LiDAR 真机验证锚点稳定性、扫描 3 分钟内存、弱网、VoiceOver 和 Dynamic Type；
- 火山方舟与 OpenAI Responses Provider 已接入；真实风险识别效果仍需授权样本评测；
- 演示的 5 类固定问题仅属于显式 Mock，不代表真实模型效果。

详见 [实现状态](docs/IMPLEMENTATION_STATUS.md) 和 [真机测试记录](docs/DEVICE_TEST_RECORD.md)。

## 上游与许可

本项目基于 [UW Makeability Lab 的 RASSAR](https://github.com/makeabilitylab/RASSAR) 修改，保留原始 MIT `LICENSE` 和版权声明。第三方模型及数据集状态见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
