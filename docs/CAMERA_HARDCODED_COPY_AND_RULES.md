# 居家实时相机文案与规则边界

H5 和 iOS 共用服务端版本化居家可见问题规则与 `anju_home_camera_discovery_v1`。房型从服务端 room 记录获取，客户端 `room_type` 仅用于 Bridge 一致性校验。

集中文案位置：

- Web：`frontend/src/content.ts`
- iOS：`RASSAR App/AnjuGuard/ProductCopy.swift`
- API 友好错误：`backend/app/asgi.py`

必须保持的用户边界：

- “实时建议仅供扫描时参考，不计入评分”。
- “扫描结束只保存代表画面”。
- “当前设备暂不支持空间定位功能”。
- 不展示最终等级、分数、价格、全屋结论或虚假三维锚点。

规则、评分与价格职责：

- 实时模型只返回临时 `risk_code`、证据、置信度与 bbox/polygon。
- 代表帧上传后，只有用户手动发起的 v2 正式分析才可产生风险。
- 风险等级、确定性评分、A/B/C 和价格始终由现有 v2 规则层计算。

历史活动现场文案、Zone 白名单、规则、方案与价格已从发布范围和代码中移除。
