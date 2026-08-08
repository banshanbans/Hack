# Apple Editorial 全站迁移 Design QA

## Visual truth and capture setup

- Source visual truth: the reference image supplied with the design task; the original local file is intentionally not recorded or committed.
- Source pixels: 1179 × 2556. The comparison uses the inner mobile concept crop `(610, 710)–(1135, 1762)` and resizes it to an 844px-high reference; the surrounding social-app UI is excluded.
- Primary implementation screenshot: `output/design-qa/home-production-390x844.png`, 390 × 844 pixels at a 390 × 844 CSS viewport and device scale factor 1.
- Combined full-view comparison: `output/design-qa/reference-vs-implementation-final.png`.
- Supporting route captures: `output/design-qa/rooms-mobile-390x844.png`, `upload-390x844.png`, `camera-viewport-390x844.png`, `result-viewport-390x844.png`, `risk-390x844.png`, `solutions-390x844.png`, and `my-390x844.png`.
- Responsive capture: `output/design-qa/home-320x640.png`; 480 × 900 was inspected in the same browser session.
- Browser: Codex in-app browser. Primary state: saved assessment at step 5/6 with the non-demo server health state.

## Findings

- P0: none.
- P1: none.
- P2: none after iteration 2.
- P3: the implementation intentionally retains the controlled living-room photograph beneath the warm peach haze, while the source concept uses an abstract gradient. This preserves product context and the previously approved homepage direction.
- P3: the implementation keeps three labeled product tabs instead of four icon-only concept tabs. This preserves the actual information architecture and gives older users clearer navigation.
- P3: semantic risk colors and the dark live-camera viewport remain stronger than the neutral editorial palette because they convey safety status and camera state.

## Required fidelity surfaces

- Fonts and typography: display headings use the Chinese Songti fallback stack with tight editorial leading; forms, buttons, metrics and navigation use the existing system sans stack. The homepage comparison and supporting route captures show consistent hierarchy without truncation at 320–480px.
- Spacing and layout rhythm: shared pages now use 22–28px cards, 17–23px controls, 22px page gutters, restrained shadows and consistent section gaps. Fixed result actions, sticky form actions and the floating tab bar retain dedicated bottom clearance.
- Colors and visual tokens: warm-white canvas, peach atmosphere, near-black primary actions, white paper cards, muted gray copy and restrained orange progress accents now span the full journey. High/medium/low risk colors remain semantic rather than decorative.
- Image quality and asset fidelity: the controlled `hero-living-room.jpg`, uploaded room media, risk overlays and renovation previews are preserved. No reference screenshot, watermark, Apple asset, generated substitute, handmade SVG or CSS-drawn illustration was added.
- Copy and content: existing product claims and accessible names remain. The cancelled local-video upload path is no longer exposed; homepage and camera recovery copy now point only to realtime camera or photo upload.
- Icons and states: existing Material Symbols and controlled camera SVG remain aligned. Hover, pressed, disabled, loading, focus, reduced-motion, high-contrast and no-`backdrop-filter` fallbacks remain present.

## Responsive and interaction evidence

- 320 × 640 and 480 × 900 both report `documentElement.scrollWidth === innerWidth`; no horizontal overflow was found.
- At 390 × 844, the tab bar measures 362 × 74px at `(14, 760)` and remains fully visible. Result fixed actions sit above it.
- Exercised path: homepage → create assessment → profile selections → rooms → bathroom upload → upload controlled demo photo → analysis → result → risk → A/B/C solutions.
- Also inspected the realtime-camera inactive state and My page. Camera permission was not requested during visual QA.
- Primary navigation, `aria-current`, radio controls, room selection, upload chooser, analysis transition and result navigation behaved correctly.
- Browser console warnings and errors: none.

## Comparison history

### Iteration 1

- P1: inner pages still used the legacy yellow/olive Material-like surfaces, compact radii and mixed elevation, which materially diverged from the selected editorial source.
- P2: buttons, forms, room cards, result cards, solution cards, report sections and My accordions did not share one token system.
- P2: the legacy local-video upload branch could reappear for an old `video_frame` assessment, conflicting with the current supported product scope.
- Fixes: introduced the global warm-white/peach/ink token mapping, unified headings/cards/buttons/header/progress/footer/navigation, migrated every existing route class, and removed the local-video chooser/preview branch while retaining backend DTO compatibility.
- Evidence after fixes: supporting route captures listed above.

### Iteration 2

- Compared the normalized source crop and the production-state homepage together in `reference-vs-implementation-final.png`.
- Rechecked typography, spacing, palette, asset fidelity, content, 320/390/480 responsiveness, fixed controls and console output.
- No actionable P0/P1/P2 mismatch remains.

## Automated verification

- `npm run typecheck`: passed.
- `npm test -- --run`: passed (8 files, 44 tests).
- `npm run build`: passed.
- `python3 scripts/check_product_copy.py`: passed (10 safety rules).
- `git diff --check`: passed.

final result: passed

---

# 扫描页内嵌 AI 适老顾问 Design QA（2026-08-08）

## 视觉真值与截图

- 参考图：本次任务中附带的 `WechatIMG1366.jpg`，采用其“风险摘要＋气泡对话＋底部麦克风”信息层级。原始本地路径在最终 QA 时已不存在，因此没有伪造新的并排合成图。
- 实现截图：`output/design-qa/scan-advisor-inactive-390x844.png` 与 `output/design-qa/scan-advisor-drawer-390x844.png`。
- 视口：390 × 844 CSS px，Codex 内置浏览器。
- 状态：卫生间扫描页，顶部顾问指引与内嵌对话抽屉；使用显式 Demo Provider，因此截图中可见演示模式标记，正式环境不显示。

## 对比结论

- P0：无。
- P1：无。
- P2：无。
- P3：实现将参考图的独立对话页改为扫描画面上的顶部指引和底部抽屉；这是本轮明确指定的新旅程，不属于视觉缺陷。
- P3：实现保留“已发现 N 条待确认提示”及选择态，用于避免“这个地方”指向不明。
- P3：参考图使用绿色用户气泡；实现遵循现有产品暖白纸张、桃色强调和近黑用户气泡，未引入第二套品牌色。
- P3：临时提示明确去除高/中/低、扣分和预算；这是业务真实性要求，不复制参考图中未经测量的 lux、cm、固定价格或工期。

## 交互与可用性

- 已验证快捷问题“还需要拍哪里？”会生成用户气泡与扫描阶段安全边界内的顾问回复。
- 已验证顶部指引、对话抽屉、快捷问题、文字输入和结束扫描按钮保持在同一相机页面；页面不显示全局底部导航或六步流程。
- 已验证没有可用代表画面时“结束扫描并分析”禁用；自动分析、档案恢复与失败重试由自动化测试覆盖。
- 已验证 RTC 未配置时点击麦克风不会请求权限，会显示“语音不可用，可继续文字咨询”并保留输入框。
- 已验证 390 × 844 下 `documentElement.scrollWidth === innerWidth`，抽屉打开后输入栏、麦克风和安全区留白正常。
- 控制台 warning/error：无。

## 自动化校验

- `npm run typecheck`：通过。
- `npm test -- --run`：通过（10 个文件，49 个测试）。
- `npm run build`：通过；RTC SDK 已拆为按需加载的独立 chunk。
- `python3 -m unittest discover -s backend/tests -v`：通过（62 个测试）。
- `swift test`：通过（20 个测试）。
- iOS 无签名 `xcodebuild`：通过。
- `python3 scripts/check_product_copy.py`：通过。

final result: passed
