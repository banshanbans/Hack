# 长者友好家 Design QA

本文记录当前公开展示素材与移动端视觉验收边界。历史逐轮截图和已过期审计产物不再作为仓库长期资产。

## README 展示素材

| 文件 | 视口 | 用途 |
|---|---:|---|
| `docs/assets/readme/home.jpg` | 390 × 844 | 首页与主要行动入口 |
| `docs/assets/readme/risk.jpg` | 390 × 844 | 结构化风险区域和证据卡 |
| `docs/assets/readme/solutions.jpg` | 390 × 844 | 整改方案、价格区间和操作入口 |

三张图片均来自显式 Demo fixture，不是生产用户数据，也不用于证明真实模型效果。截图必须显示“长者友好家”品牌和演示状态；更新其中一张时，应从同一提交重新生成完整三张。

## 视觉基线

- 移动端内容以 390px 宽视口为主要基线，并检查 320px、390px、480px 下无横向溢出。
- 页面使用统一的 Noto Sans SC / Plus Jakarta Sans、米白画布、白色卡片、深色正文和克制的强调色。
- 风险等级不能只依赖颜色；主交互区域不小于 44px，并保留 focus、disabled、loading、error、reduced-motion 和 high-contrast 状态。
- 风险图片必须显示结构化区域或其他可追溯证据，不使用生成式假 UI 代替真实页面。

## 当前验证边界

- README 三张展示图只证明固定 fixture 下的界面呈现。
- Safari、Chrome、WKWebView、LiDAR、非 LiDAR、弱网、VoiceOver 和 Dynamic Type 仍需真机记录。
- 自动化测试通过不等于真实模型效果、RTC 厂商协议或完整设备矩阵已经验收。
