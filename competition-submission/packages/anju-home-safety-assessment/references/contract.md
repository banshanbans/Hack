# 输入与输出契约

## Manifest

Manifest 必须是 UTF-8 JSON：

```json
{
  "input_mode": "photo",
  "profile": {
    "mobility": "cane",
    "fall_history": "once",
    "living_status": "with_family"
  },
  "planned_rooms": ["bathroom", "bedroom"],
  "rooms": [
    {
      "room_type": "bathroom",
      "media": [
        {"path": "images/bathroom-1.jpg"},
        {"path": "images/bathroom-2.jpg"}
      ]
    }
  ]
}
```

相对图片路径以 manifest 所在目录为基准。脚本会从 JPEG、PNG 或 WebP 文件读取尺寸；也可在媒体项显式提供正数 `width` 和 `height`。

### 枚举

- `input_mode`: `photo` 或 `video_frame`
- `room_type`: `bathroom`, `bedroom`, `living_room`, `kitchen`, `corridor`, `balcony`
- `mobility`: `normal`, `limited`, `cane`, `walker`, `wheelchair`
- `fall_history`: `none`, `once`, `multiple`
- `living_status`: `alone`, `with_family`
- 每个房间 1–6 张图片

### 视频帧元数据

`input_mode` 为 `video_frame` 时，每张图片还应包含：

```json
{
  "path": "frames/frame-03.jpg",
  "source_kind": "video_frame",
  "source_id": "local-video-20260726-a",
  "frame_index": 3,
  "captured_at_ms": 6000,
  "orientation": "up",
  "perceptual_hash": "optional-local-hash"
}
```

`source_id` 只是不含个人信息的本地关联 ID。同一视频的代表帧使用相同 ID，以便评分前合并同一物理风险。

## Choices

必须在用户明确选择后才创建：

```json
{
  "choices": [
    {
      "risk_id": "risk-id-from-report",
      "solution_package_id": "solution-id-from-recommendations"
    }
  ]
}
```

`risk_id` 不得重复。方案 ID 必须直接来自该风险的 `recommendations[].solutions[]`。

## 报告核心字段

- `rooms[].risks[]`: 经白名单和证据校验的正式风险
- `rooms[].coverage`: 房间覆盖度，与安全分独立
- `assessed_area_score`: 已检查区域参考分
- `household_score`: 只在覆盖达标时存在
- `recommendations[].solutions`: A/B/C 候选方案和结构化参考价
- `budget`: 用户已选方案按预算分组去重后的代码汇总
- `rule_set_version`, `price_rule_version`: 复现评估所需的规则版本

