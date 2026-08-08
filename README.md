# 安心家 AI（AnjuGuard）

安心家 AI 是基于 RASSAR 二次开发的家庭环境安全辅助检查产品。它不是医疗诊断、建筑验收、无障碍认证或施工报价工具。

## 统一用户旅程

- iOS 启动后以持久化 `WKWebView` 加载线上 H5，P01—P09、相册上传、分析、方案和报告均由 H5 承担。
- 原生层只提供房间单张拍照与中央相机实时扫描。
- 中央相机先在 H5 选择六类房间并创建/复用 room；扫描页内可以与能看到当前 RTC 画面的 AI 适老顾问文字或语音对话。
- 扫描结束只上传并保存代表帧，然后返回照片页；用户确认并点击“开始 AI 检查”后才启动正式分析。
- 实时建议与 AR 锚点都是临时内容，不计分；正式结果只来自代表帧的重新分析与确定性规则。
- 支持 RoomPlan/LiDAR 时使用 `spatial_ar`；其他 ARKit 设备降级为 `camera_2d`，不生成虚假空间锚点。
- 未填家人档案时可先扫描，正式分析前前后端均强制补齐三项档案。
- 不实现账号、注册、跨设备或 App 与外部 Safari 的 assessment 同步。

历史游园会 fair API、Zone DTO、规则、方案、价格和原生报告入口已移除。旧 App 调用 `/api/v2/fair-scans` 直接得到 404；已有数据库的历史表不做破坏性 DROP。

## 产品范围

- FastAPI/Uvicorn v2 Assessment API、SQLite 持久化与 React/TypeScript H5；
- 六类房间、1—6 张照片、质量检查、二维风险区域、确定性评分与独立覆盖度；
- A/B/C 整改方案、结构化价格和预算清单；
- H5 与 iOS 共用 `anju_home_camera_discovery_v1` 居家实时发现配置；
- iOS Bridge v1：`capture_photo`、`start_live_scan`、`cancel_native_capture`；
- 扫描页顾问共用房间级对话历史；H5 将现有浏览器相机 Track 发布到火山 Web RTC，iOS 将 ARFrame 作为外部 NV12 视频推入锁定的 `VolcEngineRTC/Core`；
- 显式稳定帧经签名 Function Calling 只生成待确认提示；RTC 故障自动回退原 HTTP 临时检查，正式风险仍由代表画面重新分析和规则确认；
- RTC 顾问全局最多 8 个席位，额外请求进入 FIFO 排队；同一房间 90 秒租约内只允许一个设备实时连接；
- iOS 对 RTC 上行、AR 实际帧率和热状态做滞回自适应，在压力下由 720p/15fps 降至 540p/10fps，不停止 AR 建图；
- H5 本地视频选择、自动抽帧和视频帧正式识别不在产品范围。

## 本地开发与测试

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
cd frontend && npm install && npm run build && cd ..
pod install
.venv/bin/python -m backend.app.server
```

```bash
cd Packages/AnjuCore && swift test
cd ../..
.venv/bin/python -m unittest discover -s backend/tests -v
cd frontend && npm run typecheck && npm test && npm run build
cd .. && python3 scripts/check_product_copy.py
```

iOS 无签名编译：

```bash
xcodebuild \
  -workspace "RASSAR App.xcworkspace" \
  -scheme "RetroAccess App" \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/anjuguard-build \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## 上线边界

- `ANJU_ENABLE_IOS_HOME_CAMERA` 默认关闭，按“后端/H5 → 新 iOS → 真机冒烟 → 开启”的顺序发布。
- `ANJU_ENABLE_RTC_VIDEO_ADVISOR` 默认关闭；只有公网回调、实时视觉/Function Calling endpoint 与 H5/iOS 真机门禁通过后才能开启。
- 当前代码与自动测试不等于 RTC 厂商协议、LiDAR、弱网、VoiceOver、Dynamic Type 和真实模型效果已完成外部验证。
- App 只接受受信 HTTPS 主框架 Bridge；assessment token 仅存于当次原生操作内存，不进入 URL、日志、UserDefaults 或 Keychain。

详见 [实现状态](docs/IMPLEMENTATION_STATUS.md)、[iOS 语音顾问](docs/IOS_VOICE_ADVISOR.md)、[相机路线](docs/CAMERA_UPGRADE_ROADMAP.md) 和 [隐私说明](PRIVACY.md)。

## 上游与许可

本项目基于 [UW Makeability Lab 的 RASSAR](https://github.com/makeabilitylab/RASSAR) 修改，保留原始 MIT `LICENSE` 和版权声明。
