# H5 / iOS 统一居家相机路线

> 2026-08-07 生效。本文替代历史活动现场原生相机方案。

## 1. 产品边界

- H5 是唯一主旅程；iOS 是线上 H5 的原生采集容器。
- 原生仅提供单张拍照和实时扫描，不提供原生评分、方案、预算或报告。
- 不提供账号、注册、跨设备或 App/Safari assessment 同步。
- H5 本地视频文件自动抽帧仍然取消。

## 2. 旅程

```text
App 启动
  -> WKWebView 线上 H5
  -> 中央相机
  -> H5 创建/恢复 photo assessment
  -> 选择六类房间
  -> 创建/复用 room
  -> iOS: start_live_scan / Safari: H5 camera
  -> 代表帧写入该 room
  -> /upload/{room_id}
  -> 用户删除/补拍
  -> 档案门禁
  -> 用户手动开始正式分析
```

未填档案时允许扫描。点击正式分析时，H5 导向档案页并以受控 `return_to` 回到房间；后端同时返回 `409 profile_incomplete` 防止绕过。

## 3. Native Bridge v1

只接受受信 HTTPS 主框架的 `window.webkit.messageHandlers.anjuNative`。

命令：

- `capture_photo`
- `start_live_scan`
- `cancel_native_capture`

请求必须包含 `bridge_version=1`、`request_id`、`assessment_id`、`access_token`、`room_id`、`room_type` 和 `remaining_slots`。token 仅在当次原生操作内存中保留。

完成事件：

```json
{
  "request_id": "uuid",
  "status": "completed | partial | cancelled | failed",
  "room_id": "uuid",
  "capture_mode": "spatial_ar | camera_2d | photo",
  "uploaded_media_ids": ["uuid"],
  "failed_count": 0,
  "error_code": null
}
```

H5 收到事件后重新拉取 assessment，不接收 Base64 图片。

## 4. 原生帧筛选与资源约束

- 每 2 秒执行本地候选检查；亮度 28—232，清晰度至少 5。
- `spatial_ar` 相对上一接受帧平移至少 0.15m 或旋转至少 0.14rad。
- `camera_2d` 感知哈希距离至少 6。
- 模型单请求，间隔至少 5 秒，每次扫描最多 30 次。
- 代表帧数不超过 `6 - 房间已有媒体数`，保存不依赖是否发现风险。
- JPEG 旋正为 `up`，最长边 1280，质量 0.72。
- 扫描临时文件有界，深度上下文最多 4 个；取消、上传结束或下次启动时清理。
- 结束时顺序上传，单帧失败不回滚已成功媒体。

## 5. 空间与二维降级

- RoomPlan/LiDAR 可用：临时建议 bbox 先映射回 captured image/depth，有可靠深度时才创建世界锚点。
- 不可用：原生 ARKit 相机使用二维 bbox，明确提示“当前设备暂不支持空间定位功能”。
- 锚点仅在扫描期间存在。退出后只保留代表帧与正式分析生成的二维风险区域。

## 6. API

```text
POST /api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/frames:inspect
```

服务端验证 token 与 room 归属，根据 room 获取房型，返回不计分的 `CameraSuggestion`。旧 assessment 级 H5 相机接口暂作缓存兼容。

代表帧使用现有媒体接口：

```text
source_kind = ios_camera_frame
source_id = 扫描 UUID
frame_index
captured_at_ms
orientation = up
```

`ios_ar_frame` 只保持历史可读。开关为 `ANJU_ENABLE_IOS_HOME_CAMERA`，健康检查能力名为 `ios_home_camera`，H5/iOS 共用 `anju_home_camera_discovery_v1` 与 `ANJU_ARK_HOME_CAMERA_MODEL`。

## 7. 移除项

- 不再存在 fair API、Provider 方法、Zone DTO、规则/方案/价格文件、原生 Zone UI 和原生报告入口。
- 新建数据库不创建 fair 表，现有生产数据库不执行破坏性 DROP。
- 旧 App 无兼容周期，fair API 返回 404。

## 8. 发布门禁

1. 后端与 H5 先发布，`ios_home_camera` 保持关闭。
2. 发布新 iOS，在一台 LiDAR 和一台非 LiDAR iPhone 完成 P01—P09 冒烟。
3. 开启 `ANJU_ENABLE_IOS_HOME_CAMERA=1`，再完成权限拒绝、前后台、弱网、超时、上传中断、媒体已满和连续三次完整旅程。
4. 未完成真机与授权评测集验证前，不声称空间定位或模型效果已验证。
