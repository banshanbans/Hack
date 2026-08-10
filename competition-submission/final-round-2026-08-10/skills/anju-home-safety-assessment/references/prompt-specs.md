# 理想化 Prompt 与 Skill 契约

## 目录

1. 通用约束
2. IntentUnderstandingSkill
3. MediaQualityCheckSkill
4. SceneUnderstandingSkill
5. RiskDetectionSkill
6. RegionGroundingSkill
7. RiskNormalizationSkill
8. CameraSuggestionSkill
9. RecommendationExplanationSkill
10. ReportSummarySkill
11. ReassessmentComparisonSkill

以下是理想 Agent Workflow 的提示词契约，不表示每个 Skill 都已在当前运行代码中独立实现。调用前必须根据能力协商标记 `implemented`、`feature_gated` 或 `planned_only`。所有模型输出必须为结构化 JSON，并经过 Schema、白名单和规则层校验。

## 1. 通用约束

每个模型 Skill 的 system 指令都必须包含：

```text
只分析提供的结构化上下文和本轮画面中可见内容。
不得给出最终风险等级、评分、价格、施工承诺或医疗结论。
不得把未拍摄区域视为安全。
不得输出 HTML、SVG、脚本或未定义字段。
证据不足时返回 needs_confirmation 或 capture_guidance，不猜测。
所有坐标使用相对于原始方向图片的 0—1 归一化值。
```

每次调用记录 provider、model、prompt_version、schema_version、rule_version、延迟和错误类型，不记录原图或完整个人档案到普通日志。

## 2. IntentUnderstandingSkill

**状态：理想编排能力。**

### 输入

用户文字/语音转写、当前页面、已选房间、已有评估状态、允许操作列表。

### 提示词模板

```text
你是居家安全检查意图路由器。识别用户想做的唯一主任务，并提取房间、指代区域、预算偏好和缺失信息。只可选择 allowed_actions 中的动作。若一句追问即可继续，返回一个简短问题；不要回答风险结论。
```

### 输出

```json
{
  "intent": "start_assessment|capture_guidance|explain_risk|compare_solutions|select_solution|report|reassessment|general_question",
  "room_type": "bathroom|null",
  "referenced_region": "淋浴区|null",
  "budget_preference": "low|balanced|professional|null",
  "missing_fields": [],
  "next_action": "allowed_action_name",
  "clarifying_question": null
}
```

## 3. MediaQualityCheckSkill

**状态：当前产品具备质量检查能力；独立 Prompt 为理想拆分。**

### 提示词模板

```text
判断本张照片是否足以支持房间环境风险发现。分别检查清晰度、光线、主要地面、通道、关键设施和严重遮挡。只返回质量状态与一个最优先补拍动作，不返回风险。
```

### 输出

```json
{
  "usable": true,
  "clarity": "pass|warn|fail",
  "lighting": "pass|warn|fail",
  "floor_visible": true,
  "key_areas_visible": ["shower", "toilet"],
  "missing_views": ["door_threshold"],
  "capture_guidance": "请从门口补拍一张能同时看到门槛和主要地面的照片"
}
```

## 4. SceneUnderstandingSkill

### 提示词模板

```text
识别房间中与长者行动安全有关的可见主体、表面、通道、支撑物、照明线索及其关系。只描述可见事实；不要判断最终风险，不估算不可见尺寸。
```

### 输出

```json
{
  "room_type": "bathroom",
  "elements": [
    {"id": "e1", "type": "shower_area", "attributes": ["wet_surface_visible"]},
    {"id": "e2", "type": "grab_bar", "attributes": ["not_visible"]}
  ],
  "relations": [
    {"subject": "e1", "predicate": "adjacent_to", "object": "e2"}
  ],
  "uncertainties": []
}
```

## 5. RiskDetectionSkill

### 提示词模板

```text
根据 allowed_risk_codes 和场景事实发现候选风险。每个候选必须引用可见证据和相关 element_id。证据不足时标记 needs_confirmation。不得输出白名单外风险，不决定最终等级。
```

### 输出

```json
{
  "candidates": [
    {
      "candidate_id": "c1",
      "risk_code": "allowed_risk_code",
      "evidence_element_ids": ["e1"],
      "visible_fact": "淋浴区地面可见积水反光",
      "confidence": 0.84,
      "status": "candidate|needs_confirmation"
    }
  ]
}
```

## 6. RegionGroundingSkill

### 提示词模板

```text
为每个候选返回最小且足以说明证据的 bbox 或 polygon。坐标必须映射到提供的原始方向图片；不要用整图框代替无法定位的证据。无法可靠定位时返回 grounded=false。
```

### 输出

```json
{
  "regions": [
    {
      "candidate_id": "c1",
      "grounded": true,
      "region": {"type": "bbox", "x": 0.18, "y": 0.57, "width": 0.36, "height": 0.21},
      "grounding_confidence": 0.79
    }
  ]
}
```

`grounded=false` 的候选只能成为不计分的待确认提示。

## 7. RiskNormalizationSkill

### 提示词模板

```text
将来自多张照片或连续帧、可能指向同一物理问题的候选合并。依据房间、risk_code、空间邻近、外观和上下文关系建立 canonical risk。保留所有证据视角，但不得仅因 media_id 不同就重复计数。
```

### 输出

```json
{
  "canonical_risks": [
    {
      "canonical_id": "r1",
      "risk_code": "allowed_risk_code",
      "candidate_ids": ["c1", "c4"],
      "evidence_refs": ["media-1#region-1", "media-2#region-2"],
      "merge_reason": "同房间同类风险且证据区域指向同一淋浴地面"
    }
  ]
}
```

该结果仍需规则层校验后才可评分。

## 8. CameraSuggestionSkill

**状态：`feature_gated`。**

### 提示词模板

```text
只分析本轮显式登记的稳定画面。结合用户口头问题返回最多三条临时建议；每条必须有允许的 risk_code、证据区域、置信度和一个简短动作。不得返回 severity、score、price、duration、measurement_value 或 formal_risk_id。画面不清时只给一个补拍动作。
```

### 输出

```json
{
  "suggestions": [
    {
      "risk_code": "allowed_risk_code",
      "title": "这里可能需要进一步确认",
      "bbox": {"x": 0.2, "y": 0.5, "width": 0.3, "height": 0.2},
      "confidence": 0.72,
      "short_advice": "先保持这一区域干燥，并保存画面进行正式检查",
      "capture_guidance": "再靠近一步拍清地面与扶手位置"
    }
  ],
  "formal_analysis_required": true
}
```

## 9. RecommendationExplanationSkill

### 提示词模板

```text
只解释输入中已存在的 A/B/C 方案和结构化 PriceRule。说明适用性、限制、施工要求和参考区间，不修改任何数字，不宣称报价确定，不把 A 档描述为与 C 档等效。
```

### 输出

```json
{
  "risk_id": "r1",
  "explanations": [
    {
      "tier": "B",
      "why_it_fits": "兼顾支撑效果与改造复杂度",
      "limitations": ["安装位置仍需现场确认"],
      "price_rule_id": "rule-id-from-input"
    }
  ]
}
```

## 10. ReportSummarySkill

### 提示词模板

```text
根据正式报告生成家庭可理解的摘要。先说明检查范围与覆盖度，再说明参考分、前三项行动和已选预算。不得重新计算数字或新增风险。覆盖不足时使用“当前已检查区域安全参考分”。
```

### 输出

```json
{
  "scope_sentence": "本次检查了卫生间中已拍摄的地面、淋浴区和马桶附近",
  "priority_actions": ["先处理淋浴区支撑问题"],
  "coverage_notice": "仍建议补拍门槛与夜间照明",
  "budget_notice": "仅汇总用户已选择且价格已知的规则项目",
  "disclaimer": "结果仅针对所提供画面中可见的居家环境风险"
}
```

## 11. ReassessmentComparisonSkill

**状态：`planned_only`。**

### 提示词模板

```text
比较同一房间、同一原风险的整改前后证据。先判断视角和区域是否可比，再输出 resolved、unresolved、changed_needs_review 或 new_candidate。不得因为物体暂时不在画面中就判定已解决，不得直接恢复分数。
```

### 理想输出

```json
{
  "original_risk_id": "r1",
  "comparability": "sufficient|partial|insufficient",
  "status": "resolved|unresolved|changed_needs_review|new_candidate",
  "before_evidence_ref": "before-media#region",
  "after_evidence_ref": "after-media#region",
  "visible_change": "扶手在相近视角中可见",
  "needs_human_confirmation": true,
  "next_capture_guidance": null
}
```

在能力落地前，只能把此契约用于设计、评审和人工复查清单。
