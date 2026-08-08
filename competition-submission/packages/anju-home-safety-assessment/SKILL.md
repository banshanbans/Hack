---
name: anju-home-safety-assessment
description: 将家庭空间照片编排为可追溯的居家安全评估：检查媒体质量，发现并定位候选风险，使用本地规则计算风险等级、已检查区域参考分与独立覆盖度，返回 A/B/C 整改方案和结构化预算。当用户要检查卫生间、卧室、客厅、厨房、走廊或阳台照片，生成长者友好家庭安全报告，或比较整改档位时使用。本 Skill 不处理本地视频文件、自动抽帧或视频帧正式识别。
---

# 长者友好家家庭安全评估

将用户提供的家庭照片交给长者友好家 v2 服务编排。保持“模型发现和定位，规则决定等级、评分和价格”。

## 工作流

1. 确认用户已获得照片中相关人员的授权，不上传密钥、证件、医疗记录或无关个人信息。
2. 按房间整理 JPEG、PNG 或 WebP 照片。若素材来自视频，由用户自行截图并按普通照片提供；不要选择视频文件、自动抽帧或生成 `video_frame` 输入。
3. 阅读 [references/contract.md](references/contract.md)，生成 manifest JSON。不得将未拍摄房间或区域标记为已检查。
4. 运行：

   ```bash
   python3 scripts/anju_skill.py assess \
     --manifest /absolute/path/assessment.json \
     --output /absolute/path/report.json \
     --session /absolute/path/session.private.json
   ```

5. 检查返回结果。每个正式风险必须有归一化 `bbox` 或 `polygon` 证据；缺少证据时停止并报告数据完整性错误。
6. 先说明覆盖度，再说明评分。覆盖度低于服务阈值时，只称“当前已检查区域安全参考分”，不称“全屋分”。
7. 按高、中、低风险和证据位置摘要结果。陈述“画面中可见”，不推断墙体、承重、防水、管线等照片外事实。
8. 展示后端返回的 A/B/C 方案、限制和参考价区间。B 档可标注为推荐，但不自动选择。
9. 只有用户明确选择方案后，才创建 choices JSON 并运行：

   ```bash
   python3 scripts/anju_skill.py select \
     --session /absolute/path/session.private.json \
     --choices /absolute/path/choices.json \
     --output /absolute/path/updated-report.json
   ```

10. 总价只引用更新后报告的 `budget`，并同时呈现 `price_disclaimer`。不自行填补未知价格。

## 输出原则

- 先给结论，再列证据、覆盖度和整改选项。
- 明确区分正式风险与待用户确认的提示。
- 保留 `rule_set_version` 和 `price_rule_version`，便于复现。
- 用户否认风险时，通过反馈 API 重算，不在文本中手动改分。
- 使用 [references/safety-boundaries.md](references/safety-boundaries.md) 中的边界和失败降级。

## 会话与隐私

`session.private.json` 包含评估访问 token，脚本会以 `0600` 权限写入。不要上传、展示、打包或提交该文件。用户要求删除评估时，运行 `python3 scripts/anju_skill.py delete --session ...`；成功后脚本同时删除本地会话文件。
