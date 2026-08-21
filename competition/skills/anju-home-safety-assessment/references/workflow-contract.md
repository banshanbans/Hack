# Agent Workflow 与数据契约

## 目录

1. 能力状态
2. 完整状态机
3. 当前可执行照片分支
4. 实时视觉语音分支
5. 整改后复查分支
6. 满足判断与失败处理
7. 核心输入输出

## 1. 能力状态

每次执行必须先建立能力矩阵：

| 能力 | 默认状态 | 说明 |
|---|---|---|
| 照片质量检查与正式评估 | `implemented` | 由现有脚本调用 v2 Assessment API |
| 规则评分、覆盖度、A/B/C、预算 | `implemented` | 只使用服务端结构化结果 |
| H5/iOS 实时相机临时建议 | `feature_gated` | 建议不计分，需运行环境能力开启 |
| 实时视觉 + 语音顾问 | `feature_gated` | 已有代码，仍需真实供应商和多设备验证 |
| LiDAR 扫描期世界锚点 | `feature_gated` | 仅可靠深度设备；无深度必须二维降级 |
| 整改前后自动复查 | `planned_only` | 当前只能提供人工辅助对照清单 |
| 城市化价格与抖音承接 | `planned_only` | 不得声称已有线上接口或运营数据 |

运行环境的健康检查或明确配置可以降低能力等级，不能仅凭文档提高能力等级。

## 2. 完整状态机

```text
START
  → UNDERSTAND_INTENT
  → CHECK_CONSENT_AND_PROFILE
  → NEGOTIATE_CAPABILITIES
  → SELECT_INPUT_PATH
      ├─ PHOTO_FORMAL
      ├─ LIVE_GUIDANCE_FEATURE_GATED
      └─ REASSESSMENT_PLANNED_ONLY
  → MEDIA_QUALITY
      ├─ unusable → ASK_ONE_CAPTURE_ACTION → MEDIA_QUALITY
      └─ usable → SCENE_UNDERSTANDING
  → RISK_DETECTION
  → REGION_GROUNDING
  → RISK_NORMALIZATION
  → SCHEMA_AND_ALLOWLIST_VALIDATION
      ├─ invalid → SAFE_FAILURE
      └─ valid → DETERMINISTIC_RULES
  → SCORE_AND_COVERAGE
  → RECOMMENDATION_AND_PRICE_RULES
  → RESULT_GENERATION
  → SATISFACTION_CHECK
      ├─ missing context → ASK_ONE_QUESTION
      ├─ low coverage → ASK_ONE_CAPTURE_ACTION
      ├─ solution requested → WAIT_FOR_EXPLICIT_SELECTION
      └─ satisfied → REPORT_AND_NEXT_ACTION
END
```

任何模型输出都必须经过 Schema 和业务白名单后才能进入规则层。跨帧或跨视角的同一物理风险必须在评分前合并为一个 canonical risk。

## 3. 当前可执行照片分支

### 输入准备

- 支持房间：`bathroom`、`bedroom`、`living_room`、`kitchen`、`corridor`、`balcony`。
- 每个房间 1–6 张 JPEG、PNG 或 WebP。
- 必填档案：`mobility`、`fall_history`、`living_status`。
- `planned_rooms` 表示计划检查范围，不得把未拍房间标记为已检查。

### 工具顺序

```text
GET /health
POST /api/v2/assessments
PUT  /api/v2/assessments/{id}/profile
PUT  /api/v2/assessments/{id}/planned-rooms
POST /api/v2/assessments/{id}/rooms
POST /api/v2/assessments/{id}/rooms/{room_id}/media
POST /api/v2/assessments/{id}/rooms/{room_id}:analyze
GET  /api/v2/assessments/{id}/rooms/{room_id}/status
GET  /api/v2/assessments/{id}/report
```

脚本封装了上述流程、媒体尺寸读取、私密会话、轮询和报告证据校验。正式 Provider 不可用时停止；只有显式测试参数才允许 Demo。

### Manifest 示例

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
        {"path": "images/bathroom-overview.jpg"},
        {"path": "images/bathroom-shower.jpg"}
      ]
    }
  ]
}
```

若图片来自视频，用户必须自行截图。仍使用 `input_mode: photo`，不得创建新的 `video_frame` 输入。复用脚本中可能仍出现 `video_frame` 枚举和来源元数据，它们只用于读取历史兼容契约，不属于本 Skill 的用户入口或正式能力。

## 4. 实时视觉语音分支

该分支的目标是让用户指向当前画面并自然询问：“这个地方有什么问题？”“这里怎么改？”“先做哪一项？”

### 允许行为

1. 用户主动授权相机和麦克风。
2. 本地执行亮度、清晰度、运动和场景变化门控。
3. 同一会话最多一个进行中的模型请求，并受调用次数和席位限制。
4. 模型只能返回不计分的临时建议、证据区域和一个补拍动作。
5. 用户保存的代表画面作为普通照片进入正式评估，正式分析重新识别。

### 禁止行为

- 不给临时建议附加正式等级、分数、价格、工期或测量值。
- 不把整段实时流或本地视频当作正式分析输入。
- 无可靠深度时不创建世界锚点。
- 未通过真实供应商与真机门禁时，不把 `feature_gated` 表述为稳定上线能力。

### 降级

RTC、语音、视觉工具或深度任一不可用时，保留用户当前任务，提示保存一张清晰代表画面并进入照片正式评估。降级不得改变规则职责或启用 Demo。

## 5. 整改后复查分支

状态为 `planned_only`。理想输入包括：原风险 ID、原证据区域、已选方案、整改前图片、同房间整改后图片、拍摄方向提示和规则版本。

理想输出只允许：

- `resolved`：同一区域有充分可见证据表明原风险已消除；
- `unresolved`：原风险仍可见；
- `changed_needs_review`：环境变化明显但证据不足；
- `new_candidate`：发现新的可见候选，仍需正式规则确认。

当前执行时不得自动返回上述状态。应输出人工对照清单：复现原视角、检查原位置、重新进行正式分析、由用户确认变化。整改完成但未复查不能直接恢复全部分数。

## 6. 满足判断与失败处理

| 判断 | 满足条件 | 不满足时动作 |
|---|---|---|
| 需求理解 | 房间、目标和期望输出明确 | 只追问一个高信息量问题 |
| 媒体有效 | 清晰、关键区域可见、格式与尺寸合法 | 给一个具体补拍动作 |
| 证据完整 | 每个正式风险有有效 bbox/polygon | 拒绝生成正式风险摘要 |
| 规则可复现 | 有规则与价格版本 | 返回数据完整性错误 |
| 覆盖表述正确 | 评分与覆盖度分开 | 改称已检查区域参考分 |
| 方案选择明确 | 用户明确选择具体风险的具体方案 | 不创建选择记录，不合计预算 |
| 用户可行动 | 知道下一步处理什么 | 给出一个优先行动或专业确认建议 |

## 7. 核心输入输出

### 风险证据

```json
{
  "risk_code": "allowed_rule_code",
  "title": "可见风险标题",
  "confidence": 0.82,
  "region": {
    "type": "bbox",
    "x": 0.12,
    "y": 0.44,
    "width": 0.31,
    "height": 0.22
  },
  "evidence_text": "仅描述画面中可见事实"
}
```

所有坐标使用 0–1 归一化值。polygon 至少三点。最终等级不得来自该对象中的自由文本。

### 报告必须保留

- `rooms[].risks[]`
- `rooms[].coverage`
- `assessed_area_score`
- 覆盖达标时才存在的 `household_score`
- `recommendations[].solutions`
- 用户选择后的 `budget`
- `rule_set_version`
- `price_rule_version`

报告结尾必须说明：结果只针对所提供画面中可见的居家环境风险，不替代医疗、建筑、消防或施工专业意见。
