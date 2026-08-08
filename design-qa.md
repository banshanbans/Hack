# 长者友好家视觉系统 Design QA（2026-08-09）

## Evidence

- Source visual truth: `output/design-qa-care/reference-home-390x904.jpg`（390 × 904，团队确认通过的新版首页）。
- Browser-rendered implementation: `output/design-qa-care/home-390x844.png`（390 × 844 CSS px，device scale factor 1）。
- Normalized comparison: `output/design-qa-care/reference-vs-implementation-core.png`。参考图和实现图均以原生 390px 宽度裁取顶部 760px 核心内容后并排比较，没有缩放或密度插值。
- Full-view comparison: `output/design-qa-care/reference-vs-implementation.png`。该图保留参考图 904px 与验收视口 844px 的真实高度差，只用于检查内容顺序和视口底部处理，不用于判断底部导航的纵坐标。
- Supporting 390 × 844 route captures: `profile`、`rooms`、`upload`、`result`、`risk`、`solutions`、`report`、`my`、`camera`、`advisor` 和 `onboarding`，均位于 `output/design-qa-care/`。
- Browser: Codex in-app browser；状态为隔离的本地 Demo assessment，使用仓库内浴室测试图，未请求相机或麦克风权限。
- 本轮档案卡片源视觉真值：`/Users/carrey/Desktop/Screenshot 2026-08-09 at 01.38.53.png`（956 × 792 px，用户提供的问题截图）。
- 本轮实现证据：`output/design-qa-onboarding-nav/profile-cards-focused-390x323.png`（390 × 323 px，CSS 宽度 390px，density 1）。参考图按宽度归一化为 `reference-profile-390x323.png`，两张图在同一次比较输入中核对。
- 本轮响应式证据：`profile-cards-320x700.png`、`profile-cards-390x844.png`、`profile-cards-480x900.png`以及 `onboarding-home-390x844.png`；对应 CSS 视口 320 × 700、390 × 844、480 × 900，density 1。

## Findings

- P0：无。
- P1：无。
- P2：无（第二轮修复后）。
- P3：实时相机画面继续使用深色取景器，风险等级继续使用红/黄/蓝语义色；这是相机状态与安全等级的功能表达，不跟随首页统一成装饰性绿色。
- P3：参考首页为 390 × 904，而完整旅程验收采用更常见的 390 × 844。核心内容以同宽同密度区域比较；底部导航分别按各自视口固定，不将 60px 视口差异误报为视觉漂移。
- P3：尚未用真机系统级字体放大复测；本轮已用 320px 视口和完整长标题检查换行/溢出，不构成当前 H5 验收阻塞。

## Required fidelity surfaces

- Fonts and typography: 全站继续使用仓库已打包的 Noto Sans SC / Plus Jakarta Sans；已移除旧页面残留的宋体式标题，标题、指标、按钮和顾问卡统一为首页的无衬线层级。390px 下未发现截断、异常换行或按钮文案挤压。
- Spacing and layout rhythm: 21px 页面边距、11—21px 圆角、白色卡片、克制阴影、青柠主按钮和底部固定导航已覆盖档案、房间、上传、结果、方案、报告、相机、顾问与“我的”。固定结果按钮和表单页 sticky footer 均保留导航安全区。
- Colors and visual tokens: 米白 `#f7f5ef` 画布、深橄榄绿 `#4d6b00`、青柠 `#bce447`、白色纸张卡片和低对比灰色描边来自统一 `careTheme.css` token；禁用、错误、警告和信息状态仍使用可区分的语义色。
- Image quality and asset fidelity: 首页使用专用高分辨率 `home-hero-care.jpg`，构图、暖色客厅、右侧手机裁切和文字可读性与批准参考一致。房间结果继续使用受保护的真实上传图与结构化风险框，没有使用占位图形、CSS 绘画或手写 SVG 替代参考资产。
- Copy and content: 首页品牌、主行动、1/6 进度、资源卡及底部导航与参考一致；扫描结束、照片页正式分析、顾问免责声明和报告预算文案继续遵守现有产品边界。
- Icons and accessibility: 使用既有 Material Symbols 和受控相机 SVG；主触控区不小于 44px，focus、disabled、selected、loading、error、reduced-motion 和 high-contrast 状态保留。新手引导为 `aria-modal=false`，不会再吞掉底层表单点击。

## Full-view and focused comparison

- 并排核心对照显示：品牌位置、英雄图比例与裁切、两行白色主标题、进度卡高度、1/6 标记、分段进度、主/次按钮尺寸和资源卡起始位置均保持一致。
- 文本、按钮描边和图标在 800 × 760 的并排图中可直接辨认，因此无需额外放大裁图；完整页与 11 个辅助页面截图用于检查纵向节奏、固定导航和长内容状态。
- 首页以视觉参考为真值，其他页面以相同 token、卡片、按钮和排版语法迁移，不虚构参考图未定义的新页面结构。
- 档案卡片聚焦对比中，源截图的 `legend` 背景矩形、顶边框中断和阴影断层清晰可见；修复后标题位于正常文档流，独立选项卡的边框、圆角和阴影连续。该区域细节足够清晰，无需进一步放大。

## Comparison history

### Iteration 1

- P1：内页仍混有旧的桃色强调、宋体式标题和不同圆角/阴影，和已批准首页形成两套视觉系统。
- P0：档案页新手引导的零尺寸 `display: contents` 目标让遮罩吞掉表单点击，用户无法完成第一个必填步骤。
- P1：方案页等长页面的引导卡会盖住目标按钮，缺少“读完提示后继续操作”的明确出口。
- Fixes：新增全站 `careTheme.css` token 覆盖，统一排版与表面；将引导遮罩改为非模态点击行为；新增“知道了，继续操作”，只隐藏当前提示而不跳过流程阶段，并保留显式“跳过本步”。

### Iteration 2

- Browser post-fix evidence: `onboarding-390x844.png`、`profile-390x844.png`、`solutions-390x844.png` 和完整主链路截图。
- 实测完成：档案三项选择并保存、房间选择、文件上传、正式 AI 检查、结果风险、B 档方案选择、报告与顾问页面。
- 控制台 warning/error：无。
- 未发现剩余 P0/P1/P2 视觉或交互问题。

### Iteration 3（新手引导、档案卡片与四栏导航）

- P1：源截图中 `fieldset/legend` 直接承担白色卡片表面，造成标题背景矩形、顶边框被打断和阴影不连续。
- P1：旧导航在首页不提供独立“首页”入口，“检查”也没有校验恢复路径；窄屏下标签与导航空间不稳定。
- P1：旧引导使用数字 step 和临时关闭状态，同一步子阶段会被一起跳过，刷新后可能重复。
- Fixes：保留语义化 `fieldset/legend`，由 `.radio-options-card` 独立承担卡片表面；固定“首页｜检查｜相机｜我的”并校验智能恢复路径；引导改为 v2 phase/result 状态机。
- Post-fix evidence：390px 聚焦对比不再有顶边框或阴影断层；320/390/480px 均无水平溢出，四个导航按钮高 59.5px、单项宽分别为 75/91.5/114px；首页引导同时生成 2 个精确高亮区。
- Console errors：无。未发现剩余 P0/P1/P2。

## Primary interactions tested

- 首页 → 档案 → 房间 → 上传仓库浴室测试图 → 开始 AI 检查 → 结果 → 风险 → A/B/C 方案 → 选择 B 档 → 报告。
- 新手引导的“知道了，继续操作”“跳过本步”“完成引导”，以及档案页在引导显示期间的表单可操作性。
- 首页、检查页与“我的”导航；中央相机说明、房间选择和未授权相机空状态；正式 AI 适老顾问的风险卡、快捷问题和固定输入栏。
- 改造预览未开放错误态、上传完成态、选中方案态和报告汇总态。
- 新手引导重播后首页 AR/照片双入口高亮；档案卡片 320/390/480px；四项导航 active/ARIA 状态；相机沉浸页隐藏底栏并显示“返回首页”。

## Automated verification at this QA pass

- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: passed（15 files，71 tests）。
- `npm run build`: passed。
- Browser console logs: empty.

final result: passed
