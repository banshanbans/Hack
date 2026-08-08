import * as THREE from 'three';
import {HERO_CONFIG} from './hero.config';
import {clamp} from './timeline';

export type ScreenSourceState = 'fallback' | 'loading' | 'video' | 'error';

interface ScreenSourceOptions {
  onTexture: (texture: THREE.Texture) => void;
  onState: (state: ScreenSourceState, message: string) => void;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function fillRounded(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string | CanvasGradient,
): void {
  roundRect(context, x, y, width, height, radius);
  context.fillStyle = fill;
  context.fill();
}

function drawCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (!image?.complete || !image.naturalWidth) {
    const gradient = context.createLinearGradient(x, y, x + width, y + height);
    gradient.addColorStop(0, '#6b5f55');
    gradient.addColorStop(0.5, '#c3b6aa');
    gradient.addColorStop(1, '#4a4642');
    context.fillStyle = gradient;
    context.fillRect(x, y, width, height);
    return;
  }
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = width / height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = image.naturalWidth;
  let sourceHeight = image.naturalHeight;
  if (imageRatio > targetRatio) {
    sourceWidth = image.naturalHeight * targetRatio;
    sourceX = (image.naturalWidth - sourceWidth) / 2;
  } else {
    sourceHeight = image.naturalWidth / targetRatio;
    sourceY = (image.naturalHeight - sourceHeight) / 2;
  }
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function drawStatusBar(context: CanvasRenderingContext2D): void {
  context.fillStyle = 'rgba(255,255,255,.95)';
  context.font = '700 22px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  context.fillText('9:41', 48, 54);
  context.textAlign = 'right';
  context.font = '700 18px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillText('●  ▮▮  ▰', 670, 53);
  context.textAlign = 'left';
}

function drawHeader(context: CanvasRenderingContext2D, title: string, subtitle: string): void {
  fillRounded(context, 42, 87, 40, 40, 20, '#1d1d1f');
  context.fillStyle = '#fff';
  context.font = '800 17px -apple-system, "PingFang SC", sans-serif';
  context.textAlign = 'center';
  context.fillText('安', 62, 114);
  context.textAlign = 'left';
  context.fillStyle = '#191817';
  context.font = '760 28px -apple-system, "PingFang SC", sans-serif';
  context.fillText(title, 98, 111);
  context.fillStyle = '#8a8179';
  context.font = '500 17px -apple-system, "PingFang SC", sans-serif';
  context.fillText(subtitle, 45, 153);
}

function drawImagePanel(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | undefined,
  y: number,
  height: number,
): void {
  context.save();
  roundRect(context, 32, y, 656, height, 34);
  context.clip();
  drawCover(context, image, 32, y, 656, height);
  const shade = context.createLinearGradient(0, y, 0, y + height);
  shade.addColorStop(0, 'rgba(0,0,0,.05)');
  shade.addColorStop(0.58, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,.52)');
  context.fillStyle = shade;
  context.fillRect(32, y, 656, height);
  context.restore();
}

function drawRiskBox(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  number: string,
  label: string,
  pulse = 1,
): void {
  context.save();
  context.strokeStyle = `rgba(255, 205, 86, ${0.78 + pulse * 0.22})`;
  context.lineWidth = 5;
  context.setLineDash([16, 10]);
  roundRect(context, x, y, width, height, 18);
  context.stroke();
  context.setLineDash([]);
  fillRounded(context, x - 13, y - 18, 50, 50, 25, '#ffd36a');
  context.fillStyle = '#322400';
  context.font = '800 22px -apple-system, sans-serif';
  context.textAlign = 'center';
  context.fillText(number, x + 12, y + 15);
  context.textAlign = 'left';
  fillRounded(context, x + 48, y - 13, context.measureText(label).width + 32, 40, 20, 'rgba(20,18,16,.78)');
  context.fillStyle = '#fff';
  context.font = '650 18px -apple-system, "PingFang SC", sans-serif';
  context.fillText(label, x + 64, y + 13);
  context.restore();
}

export class ScreenSource {
  readonly fallbackTexture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly images: HTMLImageElement[];
  private readonly onTexture: ScreenSourceOptions['onTexture'];
  private readonly onState: ScreenSourceOptions['onState'];
  private video: HTMLVideoElement | null = null;
  private videoTexture: THREE.VideoTexture | null = null;
  private objectUrl = '';
  private lastFallbackFrame = -1;
  private disposed = false;

  constructor(options: ScreenSourceOptions) {
    this.onTexture = options.onTexture;
    this.onState = options.onState;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 720;
    this.canvas.height = 1560;
    const context = this.canvas.getContext('2d', {alpha: false});
    if (!context) throw new Error('Canvas 2D is unavailable.');
    this.context = context;
    this.images = HERO_CONFIG.screen.fallbackImages.map(source => {
      const image = new Image();
      image.decoding = 'async';
      image.src = source;
      image.addEventListener('load', () => { this.lastFallbackFrame = -1; }, {once: true});
      return image;
    });
    this.drawFallback(0, true);
    this.fallbackTexture = new THREE.CanvasTexture(this.canvas);
    this.fallbackTexture.colorSpace = THREE.SRGBColorSpace;
    this.fallbackTexture.minFilter = THREE.LinearFilter;
    this.fallbackTexture.magFilter = THREE.LinearFilter;
    this.onState('fallback', '正在播放产品流程动效；可拖入真实录屏替换');
  }

  private clearVideo(): void {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    if (this.videoTexture) this.videoTexture.dispose();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.video = null;
    this.videoTexture = null;
    this.objectUrl = '';
  }

  private configureVideoTexture(video: HTMLVideoElement): void {
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const sourceAspect = video.videoWidth / video.videoHeight;
    const targetAspect = HERO_CONFIG.device.screenWidth / HERO_CONFIG.device.screenHeight;
    texture.center.set(0.5, 0.5);
    if (HERO_CONFIG.screen.fit === 'cover' && sourceAspect > targetAspect) {
      texture.repeat.x = targetAspect / sourceAspect;
      texture.offset.x = (1 - texture.repeat.x) / 2;
    } else if (HERO_CONFIG.screen.fit === 'cover' && sourceAspect < targetAspect) {
      texture.repeat.y = sourceAspect / targetAspect;
      texture.offset.y = (1 - texture.repeat.y) / 2;
    }
    this.videoTexture = texture;
    this.onTexture(texture);
    this.onState('video', '正在播放已载入的产品录屏');
  }

  private async useVideoSource(source: string, label: string, objectUrl = ''): Promise<void> {
    this.clearVideo();
    this.objectUrl = objectUrl;
    this.onTexture(this.fallbackTexture);
    this.onState('loading', `正在载入${label}`);
    const video = document.createElement('video');
    this.video = video;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = false;
    video.crossOrigin = 'anonymous';
    video.src = source;
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error(`浏览器无法播放${label}，建议使用 H.264 MP4 或 WebM。`));
      };
      const cleanup = () => {
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
      };
      video.addEventListener('loadeddata', ready);
      video.addEventListener('error', failed);
      video.load();
    });
    if (this.disposed || this.video !== video) return;
    this.configureVideoTexture(video);
  }

  async setFile(file: File): Promise<void> {
    if (!file.type.startsWith('video/')) {
      this.onState('error', '请拖入 MP4、WebM 或浏览器可播放的 MOV 文件');
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      await this.useVideoSource(objectUrl, file.name, objectUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : '录屏载入失败';
      this.clearVideo();
      this.onTexture(this.fallbackTexture);
      this.onState('error', message);
    }
  }

  async setUrl(url: string): Promise<void> {
    if (!url) return;
    try {
      await this.useVideoSource(url, '默认录屏');
    } catch (error) {
      this.clearVideo();
      this.onTexture(this.fallbackTexture);
      this.onState('error', error instanceof Error ? error.message : '默认录屏载入失败');
    }
  }

  update(screenTime: number, playing: boolean, forceSync = false): void {
    const safeTime = Math.max(0, screenTime);
    this.drawFallback(safeTime);
    if (!this.video || !this.videoTexture) return;
    const duration = Number.isFinite(this.video.duration) && this.video.duration > 0 ? this.video.duration : 1;
    const desired = safeTime % duration;
    if (screenTime < 0 || forceSync || Math.abs(this.video.currentTime - desired) > 0.55) {
      this.video.currentTime = desired;
    }
    if (playing && screenTime >= 0) {
      void this.video.play().catch(() => this.onState('error', '浏览器阻止了自动播放；点击页面或按空格继续'));
    } else {
      this.video.pause();
    }
  }

  private drawFallback(time: number, force = false): void {
    const frame = Math.floor(time * 30);
    if (!force && frame === this.lastFallbackFrame) return;
    this.lastFallbackFrame = frame;
    const flowTime = Math.min(time, 15.999);
    const phase = Math.min(3, Math.floor(flowTime / 4));
    const progress = (flowTime % 4) / 4;
    const context = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;

    context.clearRect(0, 0, width, height);
    context.fillStyle = '#f5f1ec';
    context.fillRect(0, 0, width, height);
    drawStatusBar(context);

    if (phase === 0) {
      drawHeader(context, '长者友好家', '卫生间 · 实时检查');
      drawImagePanel(context, this.images[0], 184, 1120);
      const scanY = 250 + progress * 850;
      const scanGradient = context.createLinearGradient(70, scanY, 650, scanY);
      scanGradient.addColorStop(0, 'rgba(255,211,106,0)');
      scanGradient.addColorStop(0.18, '#ffd36a');
      scanGradient.addColorStop(0.82, '#ffd36a');
      scanGradient.addColorStop(1, 'rgba(255,211,106,0)');
      context.fillStyle = scanGradient;
      context.shadowColor = 'rgba(255,211,106,.8)';
      context.shadowBlur = 22;
      context.fillRect(55, scanY, 610, 4);
      context.shadowBlur = 0;
      fillRounded(context, 72, 1190, 576, 76, 38, 'rgba(18,17,16,.74)');
      context.fillStyle = '#fff';
      context.font = '650 22px -apple-system, "PingFang SC", sans-serif';
      context.textAlign = 'center';
      context.fillText('正在检查地面、通道与支撑位置…', 360, 1239);
      context.textAlign = 'left';
    } else if (phase === 1) {
      drawHeader(context, '发现 2 处需要留意', '每一处提示都有画面证据');
      drawImagePanel(context, this.images[1] ?? this.images[0], 184, 910);
      const pulse = (Math.sin(progress * Math.PI * 4) + 1) / 2;
      drawRiskBox(context, 104, 710, 300, 230, '1', '地面湿滑', pulse);
      drawRiskBox(context, 414, 335, 184, 330, '2', '缺少扶手', 1 - pulse);
      fillRounded(context, 32, 1122, 656, 358, 36, '#ffffff');
      context.fillStyle = '#23211f';
      context.font = '760 28px -apple-system, "PingFang SC", sans-serif';
      context.fillText('AI 临时建议', 70, 1180);
      for (const [index, label, detail] of [
        ['1', '淋浴区地面湿滑', '建议优先做好防滑'],
        ['2', '起身位置缺少支撑', '建议确认墙面与安装条件'],
      ] as const) {
        const y = 1248 + Number(index) * 84 - 84;
        fillRounded(context, 70, y, 44, 44, 22, index === '1' ? '#ffd36a' : '#e8e4df');
        context.fillStyle = '#27221a';
        context.font = '800 19px -apple-system, sans-serif';
        context.textAlign = 'center';
        context.fillText(index, 92, y + 29);
        context.textAlign = 'left';
        context.fillStyle = '#24211f';
        context.font = '700 22px -apple-system, "PingFang SC", sans-serif';
        context.fillText(label, 132, y + 20);
        context.fillStyle = '#8a8179';
        context.font = '500 17px -apple-system, "PingFang SC", sans-serif';
        context.fillText(detail, 132, y + 46);
      }
    } else if (phase === 2) {
      drawHeader(context, '卫生间安全分析', '参考分与覆盖度分开呈现');
      drawImagePanel(context, this.images[1] ?? this.images[0], 184, 520);
      drawRiskBox(context, 112, 424, 270, 178, '1', '地面湿滑');
      fillRounded(context, 32, 736, 656, 708, 38, '#fff');
      context.fillStyle = '#8d857e';
      context.font = '650 19px -apple-system, "PingFang SC", sans-serif';
      context.fillText('已检查区域参考分', 72, 800);
      context.fillStyle = '#191817';
      context.font = '760 112px -apple-system, sans-serif';
      context.fillText(String(Math.round(68 + progress * 4)), 68, 920);
      context.fillStyle = '#8d857e';
      context.font = '600 24px -apple-system, sans-serif';
      context.fillText('/ 100', 232, 908);
      fillRounded(context, 68, 964, 584, 14, 7, '#ede9e4');
      fillRounded(context, 68, 964, 584 * (0.68 + progress * 0.04), 14, 7, '#242220');
      context.fillStyle = '#282522';
      context.font = '750 25px -apple-system, "PingFang SC", sans-serif';
      context.fillText('2 个问题有明确画面证据', 70, 1050);
      const rows = [
        ['优先处理', '淋浴区地面湿滑', '#bf3b32'],
        ['近期改善', '起身位置缺少支撑', '#b77a18'],
      ] as const;
      rows.forEach(([badge, label, color], index) => {
        const y = 1102 + index * 116;
        fillRounded(context, 70, y, 122, 42, 21, color);
        context.fillStyle = '#fff';
        context.font = '700 17px -apple-system, "PingFang SC", sans-serif';
        context.textAlign = 'center';
        context.fillText(badge, 131, y + 27);
        context.textAlign = 'left';
        context.fillStyle = '#272421';
        context.font = '680 22px -apple-system, "PingFang SC", sans-serif';
        context.fillText(label, 214, y + 28);
        context.strokeStyle = '#eee9e4';
        context.beginPath();
        context.moveTo(70, y + 82);
        context.lineTo(650, y + 82);
        context.stroke();
      });
    } else {
      drawHeader(context, '推荐改造方案', '从今天能做的小改变开始');
      drawImagePanel(context, this.images[2] ?? this.images[0], 184, 650);
      fillRounded(context, 32, 868, 656, 578, 38, '#fff');
      fillRounded(context, 64, 910, 96, 40, 20, '#1e1d1b');
      context.fillStyle = '#fff';
      context.font = '700 17px -apple-system, "PingFang SC", sans-serif';
      context.textAlign = 'center';
      context.fillText('推荐 B', 112, 936);
      context.textAlign = 'left';
      context.fillStyle = '#24211f';
      context.font = '760 34px -apple-system, "PingFang SC", sans-serif';
      context.fillText('防滑与支撑组合改造', 64, 1010);
      context.fillStyle = '#827a73';
      context.font = '500 20px -apple-system, "PingFang SC", sans-serif';
      context.fillText('优先改善高频使用区域，兼顾性价比', 64, 1054);
      const details = [
        ['01', '铺设淋浴区防滑垫', '当天可完成'],
        ['02', '增设起身扶手', '需现场确认墙体'],
      ] as const;
      details.forEach(([number, title, note], index) => {
        const y = 1110 + index * 98;
        context.fillStyle = '#aaa29a';
        context.font = '650 18px -apple-system, sans-serif';
        context.fillText(number, 66, y);
        context.fillStyle = '#282522';
        context.font = '680 22px -apple-system, "PingFang SC", sans-serif';
        context.fillText(title, 116, y);
        context.fillStyle = '#958d85';
        context.font = '500 16px -apple-system, "PingFang SC", sans-serif';
        context.fillText(note, 116, y + 31);
      });
      const buttonAlpha = 0.93 + clamp(Math.sin(progress * Math.PI)) * 0.07;
      fillRounded(context, 64, 1333, 592, 76, 26, `rgba(29,29,31,${buttonAlpha})`);
      context.fillStyle = '#fff';
      context.font = '720 22px -apple-system, "PingFang SC", sans-serif';
      context.textAlign = 'center';
      context.fillText('查看完整改造清单', 360, 1382);
      context.textAlign = 'left';
    }

    const bottomFade = context.createLinearGradient(0, height - 70, 0, height);
    bottomFade.addColorStop(0, 'rgba(245,241,236,0)');
    bottomFade.addColorStop(1, '#f5f1ec');
    context.fillStyle = bottomFade;
    context.fillRect(0, height - 70, width, 70);
    if (this.fallbackTexture) this.fallbackTexture.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.clearVideo();
    this.fallbackTexture.dispose();
  }
}
