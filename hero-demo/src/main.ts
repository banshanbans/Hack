import './style.css';
import {HERO_CONFIG} from './hero.config';
import {HeroExperience} from './HeroExperience';
import {clamp} from './timeline';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Hero demo root is missing.');
const app: HTMLElement = root;

const query = new URLSearchParams(window.location.search);
const requestedTime = Number(query.get('time'));
const hasFixedTime = query.has('time') && Number.isFinite(requestedTime);
const fixedTime = hasFixedTime ? clamp(requestedTime, 0, HERO_CONFIG.duration) : null;
const showControls = query.get('controls') === '1' || query.get('debug') === '1';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

app.innerHTML = `
  <section class="hero-shell" aria-label="老者 LAOZHE 产品展示动画">
    <div class="hero-stage" data-asset-state="fallback">
      <canvas class="hero-canvas" aria-hidden="true"></canvas>
      <div class="hero-atmosphere" aria-hidden="true"></div>
      <div class="hero-flare" aria-hidden="true"></div>
      <div class="hero-grain" aria-hidden="true"></div>
      <div class="hero-vignette" aria-hidden="true"></div>

      <header class="brand-lockup">
        <p class="brand-eyebrow">${HERO_CONFIG.copy.eyebrow}</p>
        <div class="brand-rule" aria-hidden="true"></div>
        <h1><span>${HERO_CONFIG.copy.brand}</span><small>${HERO_CONFIG.copy.latinBrand}</small></h1>
        <p class="brand-tagline">${HERO_CONFIG.copy.tagline}</p>
        <p class="brand-detail">${HERO_CONFIG.copy.detail}</p>
      </header>

      <div class="drop-hint" aria-hidden="true">
        <span>+</span>
        <strong>拖入产品录屏</strong>
        <small>MP4 · WebM · MOV</small>
      </div>
      <p class="asset-status" role="status" aria-live="polite"></p>

      <div class="hero-controls" aria-label="Hero 时间轴控制">
        <button class="control-button play-button" type="button">暂停</button>
        <button class="control-button restart-button" type="button">重播</button>
        <button class="control-button file-button" type="button">载入录屏</button>
        <input class="file-input" type="file" accept="video/mp4,video/webm,video/quicktime,video/*" />
        <label class="time-control">
          <span class="sr-only">动画时间</span>
          <input class="time-input" type="range" min="0" max="${HERO_CONFIG.duration}" step="0.01" value="0" />
        </label>
        <output class="time-readout">0.0 / ${HERO_CONFIG.duration}s</output>
        <output class="fps-readout">— fps</output>
      </div>

      <div class="fade-layer" aria-hidden="true"></div>
      <p class="sr-only">一台 iPhone 从黑暗中缓慢旋转到正面，屏幕依次展示居住空间扫描、风险标注、分析结果和改造建议，最后形成完整产品主视觉。</p>
    </div>
  </section>
`;

function required<T extends Element>(selector: string): T {
  const element = app.querySelector<T>(selector);
  if (!element) throw new Error(`Missing hero element: ${selector}`);
  return element;
}

const experience = new HeroExperience({
  stage: required('.hero-stage'),
  canvas: required('.hero-canvas'),
  brand: required('.brand-lockup'),
  fade: required('.fade-layer'),
  flare: required('.hero-flare'),
  dropHint: required('.drop-hint'),
  assetStatus: required('.asset-status'),
  controls: required('.hero-controls'),
  playButton: required('.play-button'),
  restartButton: required('.restart-button'),
  fileButton: required('.file-button'),
  fileInput: required('.file-input'),
  timeInput: required('.time-input'),
  timeReadout: required('.time-readout'),
  fpsReadout: required('.fps-readout'),
}, {fixedTime, showControls, reducedMotion});

window.addEventListener('pagehide', () => experience.dispose(), {once: true});
