# 《长者友好家》Fast Product Motion Demo

独立的 Remotion + React + TypeScript 动效工程。它使用高速 kinetic typography、黑白反转、UI 快闪和产品 Hero Shot 验证一套可扩展到 60 秒成片的视觉语言，不复制任何参考片的具体文案或品牌元素。

当前 Demo：

- 1920×1080；
- 30fps；
- 150 BPM，每拍 12 帧；
- 32 拍，约 12.8 秒；
- H.264 / yuv420p 输出。

## 本地预览

```bash
cd AnjuGuard/demos/motion
npm install
npm run preview
```

Player 预览页默认打开 `http://localhost:3010`，支持播放、拖动进度和全屏。勾选“显示 Beat Grid”可显示当前 beat/frame 和节拍脉冲。

如需 Remotion Studio 的完整时间轴编辑界面，运行 `npm run studio`。在 macOS 系统文件监听器已被其他开发服务耗尽时，优先使用不依赖 Studio watcher 的 Player 预览页。Composition 名为 `FastProductDemo`。

## 检查与渲染

```bash
npm run typecheck
npm test
npm run bundle
npm run render:frame
npm run render
```

输出：

- 视频：`out/fast-product-demo.mp4`；
- 单帧：`out/fast-product-demo-frame.png`；
- 网页 bundle：`dist/`。

`out/`、`dist/` 和 `node_modules/` 默认忽略，不会污染主前端或生产构建。

## 只改时间轴重新生成

所有镜头位于 [`src/timeline/demo.timeline.ts`](./src/timeline/demo.timeline.ts)。每个 `defineShot()` 项包含：

- `beat`：起始拍；
- `durationBeats`：持续拍数；
- `type`：镜头类型；
- `text`：主文案；
- `asset`：相对 `public/` 的素材路径；
- `animation`：进出场预设；
- 可选的 `background`、`detail`、`value`、`layout` 等显示参数。

`defineShot()` 会自动为每个镜头生成秒制 `time` 和 `duration` 字段，因此修改 BPM 或 beat 后无需手工同步毫秒值。Composition 总时长由最后一个镜头自动计算。

音效点位在同文件的 `SOUND_CUES`。把授权音效放入 `public/assets/sfx/`，并将对应 cue 的 `asset` 从 `null` 改为文件路径即可。

## Motion system

`src/motion/config.ts` 集中管理分辨率、fps、BPM、安全边距、字体、颜色、位移距离、scale 和 motion blur 强度。

可复用组件：

- `BigText`：单句巨幅文字；
- `WordFlash`：单词逐拍/半拍闪现；
- `SplitText`：上下分割文字；
- `ProductShot`：产品 Hero Shot；
- `VideoShot`：全屏 `cover` 视频；
- `UIShot`：竖屏 UI 和价值文案；
- `MetricShot`：巨幅数据镜头；
- `LogoShot`：最终品牌收尾；
- `BeatSequence`：把 beat 数据映射到 Remotion Sequence；
- `Transition`：统一 scale / position / opacity / blur 进出场。

`match-left` 和 `match-up` 会让前后镜头沿相同方向运动，用于建立 match transition；`cut` 不添加补间，适合黑白单词快闪。

## 素材目录

```text
public/assets/
  video/    # MP4 / WebM 产品录屏
  audio/    # 主音乐
  ui/       # UI 截图和屏幕素材
  product/  # 设备或产品 Hero 图
  sfx/      # impact / whoosh / click 等音效
```

当前未放入第三方音乐和音效，避免将未确认授权的音频带入仓库。当前 MP4 是无配乐的视觉节奏版。

## 扩展到 60 秒

先保留现有 32 拍作为风格模块，再在 timeline 中增加“问题—捕捉—分析—方案—报告—品牌”五个节奏段。150 BPM 下 60 秒对应 150 拍，不需要改 Composition 或镜头组件。

本工程是比赛展示资产，不连接业务 API，也不代表新增了模型识别能力。
