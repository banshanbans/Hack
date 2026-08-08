# 长者友好家 Hero Demo

独立的 16:9 Three.js 产品展示前端，用于比赛 Demo 视频和现场循环播放。它不连接主 H5、后端 API 或真实分析任务；默认屏幕内容是明确的产品流程动效兜底。

## 启动与构建

```bash
cd RASSAR/hero-demo
npm install
npm run dev
```

打开 `http://localhost:4174/`。生产构建：

```bash
npm run typecheck
npm test
npm run build
npm run preview
```

## 替换真实产品录屏

最快方式是在页面打开后，把 MP4 或 WebM 直接拖到画面上。文件只通过浏览器的 Object URL 播放，不会上传；刷新后恢复默认兜底动效。

固定使用一个录屏时：

1. 将 H.264 MP4 或 WebM 放到 `public/media/product-demo.mp4`；
2. 在 `src/hero.config.ts` 把 `screen.videoUrl` 改为 `'/media/product-demo.mp4'`；
3. 录屏推荐使用接近 iPhone 的竖屏比例，画面会以 `cover` 方式居中裁切。

不建议使用仅含 HEVC 视频轨的 MOV，因为部分 Chrome 环境无法解码。切换录屏和离开页面时会暂停视频、释放 VideoTexture 并撤销临时 Object URL。

## 调整动画

所有成片参数集中在 `src/hero.config.ts`：

- `duration`：总时长，默认 28 秒；
- `camera.position` / `camera.target`：镜头轨迹；
- `device.position` / `device.rotation`：设备位移与旋转，旋转单位为弧度；
- `screen.brightness`：屏幕点亮时间；
- `lights`：轮廓光、主光和屏幕补光；
- `overlays.brandOpacity` / `fadeOpacity`：品牌与黑场时间；
- `copy`：品牌和结尾文案；
- `canvas.maxDpr`：Retina 性能上限。

关键帧的 `ease` 可使用 `linear`、`sine`、`cinematic` 或 `quint`。默认采用较慢的 cinematic/quint 缓入缓出，没有额外引入 GSAP。

## 演示控制

- `R`：从黑场重播；
- `Space`：播放或暂停；
- `V`：选择本地录屏；
- 拖放视频：立即替换屏幕内容；
- `?controls=1`：显示播放、时间轴和视频选择控件；
- `?time=16`：冻结到指定秒，适合逐镜头截图；
- `?debug=1`：显示控制条和 FPS。

默认页面没有操作控件，适合直接录制。系统开启“减少动态效果”时，页面停在最终 Hero Shot。

完整的 28 秒分镜、可选旁白和声音提示见 [`STORYBOARD.md`](./STORYBOARD.md)。

## iPhone GLB

当前默认使用 `public/models/iphone17promax.glb`，授权状态已由项目维护者确认。模型约 5.1 MB，纹理已经内嵌，不需要额外复制下载包中的 `textures/` 目录。程序化设备仍作为网络或解析失败时的兜底。

屏幕不是覆盖在模型前方的通用平面：`device.ts` 会根据配置找到模型原生屏幕网格，保留原机身、玻璃和 Dynamic Island，并把产品录屏材质绑定到该网格。当前模型的适配参数也集中在 `src/hero.config.ts`：

- `modelScreenMeshName` / `modelScreenMaterialName`：原生屏幕网格的稳定绑定；
- `modelScreenUvRotation` / `modelScreenUvFlipX` / `modelScreenUvFlipY`：录屏方向校正；
- `modelRotation` / `modelOffset` / `modelHeight`：模型归一化与构图校准。

替换另一份 GLB 时，在 `src/hero.config.ts` 修改 `device.modelUrl` 和上述屏幕绑定。模型契约：

- Y 轴向上；
- Z 轴正方向为屏幕正面；
- 原点位于设备中心；
- 加载后会按 `device.modelHeight` 自动缩放；
- 模型需提供可单独绑定材质且带有效 UV 的屏幕网格。

未配置、屏幕网格无法匹配或载入失败时自动使用程序化设备。程序化模型由 PBR 金属机身、玻璃、侧键、Dynamic Island、背部镜头和细节几何组成。

## 1920×1080 录制建议

使用无浏览器边框的 1920×1080 窗口，等待字体和图片加载后从 0 秒开始录制。默认 28 秒自动循环，27—28 秒淡回黑场。可先用 `?time=2.5`、`7`、`11`、`16`、`20.5` 和 `25.8` 检查关键构图。
