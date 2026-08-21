---
name: anju-home-safety-assessment
description: 将卫生间、卧室、客厅、厨房、玄关走廊或阳台的家庭空间照片编排为证据化长者居家安全评估，并返回图片质量、可见风险区域、独立覆盖度、确定性参考分、A/B/C 整改方案和规则化预算。用户要求检查父母家环境、定位跌倒或通行风险、比较适老改造方案、生成家庭整改清单，或规划视觉加语音的居家安全 Agent Workflow 时使用。本 Skill 不处理本地视频文件、自动抽帧、医疗诊断、建筑验收或确定性施工报价。
---

# 长者友好家家庭安全评估

把用户提供的家庭空间照片编排为可追溯、可解释、可行动的评估。始终遵守：模型负责发现、定位和解释候选；规则负责等级、评分、价格和安全边界；Agent 负责编排；前端负责确定性渲染。

## 先声明能力状态

开始任务前输出本次能力清单，并为每项标记以下状态之一：

- `implemented`：当前脚本和 v2 API 可执行。
- `feature_gated`：已有代码，但依赖功能开关、真实供应商配置或真机验证。
- `planned_only`：仅有理想化契约，不得声称已调用或已得到真实结果。

当前照片正式评估为 `implemented`。实时视觉语音顾问通常为 `feature_gated`。整改前后自动复查、抖音承接和城市化价格通常为 `planned_only`。以运行环境实际返回的健康能力为准，不根据文档自行升级状态。

## 选择工作流

1. 用户提供照片并要求正式检查：执行“照片正式评估”。
2. 用户使用相机边看边问：先读取 [references/workflow-contract.md](references/workflow-contract.md) 的实时分支；只有能力为 `feature_gated` 且运行环境已启用时调用，否则退回保存单张代表画面后执行照片评估。
3. 用户要求比较整改前后：读取复查分支；能力为 `planned_only` 时只输出所需输入、预期流程和人工核对清单，不生成虚假复查结论。
4. 用户只要求设计 Agent、Prompt 或评测：读取 [references/prompt-specs.md](references/prompt-specs.md) 与 [references/safety-and-evaluation.md](references/safety-and-evaluation.md)，输出方案而不调用生产服务。

## 照片正式评估

1. 确认照片使用授权，并收集行动能力、近半年跌倒情况、居住状态、计划检查的房间及 1–6 张房间照片。
2. 若档案缺失，先追问；不得绕过正式分析前的档案门禁。
3. 读取 [references/workflow-contract.md](references/workflow-contract.md)，生成 manifest。只使用 `photo`；视频画面必须由用户自行截图后作为普通照片处理。
4. 执行：

   ```bash
   python3 scripts/anju_skill.py assess \
     --manifest /absolute/path/assessment.json \
     --output /absolute/path/report.json \
     --session /absolute/path/session.private.json
   ```

5. 校验每个正式风险都包含 0–1 归一化 `bbox` 或 `polygon`，并保留 `rule_set_version` 与 `price_rule_version`。缺少证据时停止，不用自然语言补造坐标。
6. 先说明覆盖度，再说明评分。覆盖不足时只称“当前已检查区域安全参考分”，不得称“全屋安全分”。
7. 按证据位置解释高、中、低风险；只描述画面中可见事实，不推断墙体、承重、防水、暗管或精确尺寸。
8. 展示服务端返回的 A/B/C 方案。B 档可以标记“推荐”，但不得自动替用户选择。
9. 仅在用户明确选择后创建 choices JSON 并执行：

   ```bash
   python3 scripts/anju_skill.py select \
     --session /absolute/path/session.private.json \
     --choices /absolute/path/choices.json \
     --output /absolute/path/updated-report.json
   ```

10. 总价只引用更新后报告的 `budget`；未知价格保留为未知项，不自行估算。

## 满足判断

在结束前逐项检查：

- 用户目标是否明确；档案和房间是否完整；
- 是否至少有一张质量合格且关键区域可见的照片；
- 每个正式风险是否有有效证据区域；
- 是否区分评分与覆盖度、正式风险与临时建议；
- 方案和预算是否来自规则结果；
- 用户是否知道下一步是补拍、确认风险、选择方案或咨询专业人员。

任一项不满足时，只追问一个最能推进任务的问题，或给出一个明确补拍动作。不要用泛化长文掩盖缺失输入。

## 输出格式

按以下顺序回答：

1. **本次结论**：一句话说明已检查范围和最优先行动。
2. **能力状态**：列出 `implemented`、`feature_gated`、`planned_only`。
3. **证据化风险**：风险、画面位置、原因、置信与确认状态。
4. **覆盖度与参考分**：分开呈现，并说明缺失视角。
5. **A/B/C 方案**：安全作用、限制、是否施工、规则参考价。
6. **下一步**：补拍、确认、选择方案、加入清单或寻求现场专业意见。
7. **边界声明**：结果仅针对画面可见环境风险。

## 失败与隐私

- Provider 超时、限流、拒绝或结构错误时保留输入并建议重试，不自动启用 Demo。
- 实时能力不可用时退回照片主流程，不把临时相机建议写成正式风险。
- `session.private.json` 含访问 token，必须以私密文件处理；不得展示、上传、打包或提交。
- 用户要求删除评估时运行 `python3 scripts/anju_skill.py delete --session ...`。
- 涉及风险升级、价格、隐私、Mock 或评测结论时，必须读取 [references/safety-and-evaluation.md](references/safety-and-evaluation.md)。
