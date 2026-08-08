# iOS 扫描页 RTC 音视频顾问

## 依赖与锁定

- CocoaPods 仅引入 `VolcEngineRTC/Core` `3.60.15.8550`，版本和校验值由根目录 `Podfile.lock` 锁定。
- 该 SDK 是火山引擎的专有软件，仅按其 Podspec 中的 `Core` 子模块集成；不引入视频特效、美颜、屏幕共享等插件。
- iOS 系统库只能提供相机帧、麦克风权限和 `AVAudioSession`，不能代替 RTC 房间、字幕、打断和火山实时视觉任务协议，因此需要该第三方依赖。
- `httpx==0.28.1` 作为后端运行时依赖，用于服务端带超时、签名和错误映射地调用 `StartVoiceChat` / `StopVoiceChat`；版本同时锁定在 `backend/requirements.lock`。

## 运行边界

- ARKit/RoomPlan 独占相机，RTC 禁用内部视频采集；`ARFrame.capturedImage` 以外部 NV12 主流发布，正常档 720p/15fps/900kbps，上行质量较差、AR 帧率连续两个 3 秒窗口低于 24fps 或热状态到 `serious/critical` 时降至 540p/10fps/500kbps。
- 扫描启动时可领取短期 Token 并发布视频、订阅顾问音频；点击麦克风后才申请录音权限并发布音频。
- 同一 ARFrame 同时用于质量/变化门控、RTC 视频和代表帧缓存；稳定帧登记元数据后以 60KB 上限分片发送显式检查图片，完成后清理 GroupID。
- 深度上下文在 `AnjuCore.FrameContextStore` 中最多保留 8 个；只有 `inspection_id` 和 `frame_id` 严格匹配时才允许解算世界锚点，锁定项不淘汰，异常时降级为二维提示。
- 代表帧临时缓存最多 8 张/24MB，结束时优先选择被建议引用的清晰帧、感知哈希去重并最多上传 6 张。
- RTC 未配置、进房失败或连续三次显式检查失败时，回退到原 HTTP 临时检查；文字、代表帧上传和正式分析不受影响。
- `AVAudioSession` 使用 `playAndRecord` + `voiceChat`，支持默认扬声器与蓝牙 HFP；音频中断后重新激活。
- 进入后台或发生音频中断时暂停推帧和麦克风，恢复后复用业务会话并重新发布；90 秒无操作只关闭麦克风，视频持续到扫描结束。
- RTC 视频、显式检查图片和原始音频不保存；App 只获得短期 RTC Token 和一次性事件 Token，AppKey/AccessKey/SecretKey 只留在服务端。
- Bridge 必须带有 H5 签发的 `advisor_client_instance_id` 和 `advisor_queue_ticket_id`；原生端不能绕过全局 8 席位与同房间设备租约。

## 开发和验证

```bash
pod install
xcodebuild \
  -workspace "RASSAR App.xcworkspace" \
  -scheme "RetroAccess App" \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/anjuguard-build \
  CODE_SIGNING_ALLOWED=NO \
  build
```

代码编译通过不代表真机门禁完成。发布前仍需使用支持实时视觉和 Function Calling 的获授权 endpoint，在 LiDAR 和非 LiDAR iPhone 上验证：连续 10 分钟、三次打断、镜头转向、扫描暂停/恢复、前后台、来电中断、麦克风拒绝和弱网重连。
