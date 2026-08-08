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

- `input_mode`: 当前只允许 `photo`
- `room_type`: `bathroom`, `bedroom`, `living_room`, `kitchen`, `corridor`, `balcony`
- `mobility`: `normal`, `limited`, `cane`, `walker`, `wheelchair`
- `fall_history`: `none`, `once`, `multiple`
- `living_status`: `alone`, `with_family`
- 每个房间 1–6 张图片

### 历史 `video_frame` 兼容说明

服务端和编排脚本可能暂时保留 `video_frame` 字段与以下旧元数据，以便读取历史记录：

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

该结构不属于当前 Skill 的可用输入，调用方不得新建 `video_frame` manifest，也不得把本 Skill 描述为支持本地视频选择、自动抽帧或视频帧识别。若素材来自视频，用户应自行截图，并以 `input_mode: photo` 和普通照片媒体项提交。旧结构仅说明兼容数据为何仍可能出现在代码或历史记录中。

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
