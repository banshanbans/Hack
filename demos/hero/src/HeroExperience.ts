import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {RectAreaLightUniformsLib} from 'three/addons/lights/RectAreaLightUniformsLib.js';
import {createHeroDevice, type HeroDevice} from './device';
import {HERO_CONFIG} from './hero.config';
import {ScreenSource, type ScreenSourceState} from './screenSource';
import {clamp, sampleScalar, sampleVector} from './timeline';

interface HeroElements {
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  brand: HTMLElement;
  fade: HTMLElement;
  flare: HTMLElement;
  dropHint: HTMLElement;
  assetStatus: HTMLElement;
  controls: HTMLElement;
  playButton: HTMLButtonElement;
  restartButton: HTMLButtonElement;
  fileButton: HTMLButtonElement;
  fileInput: HTMLInputElement;
  timeInput: HTMLInputElement;
  timeReadout: HTMLElement;
  fpsReadout: HTMLElement;
}

interface HeroOptions {
  fixedTime: number | null;
  showControls: boolean;
  reducedMotion: boolean;
}

export class HeroExperience {
  private readonly elements: HeroElements;
  private readonly options: HeroOptions;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly device: HeroDevice;
  private readonly screen: ScreenSource;
  private readonly rimLight: THREE.RectAreaLight;
  private readonly secondaryRim: THREE.RectAreaLight;
  private readonly keyLight: THREE.RectAreaLight;
  private readonly topLight: THREE.RectAreaLight;
  private readonly screenGlow: THREE.RectAreaLight;
  private readonly resizeObserver: ResizeObserver;
  private readonly disposables: Array<() => void> = [];
  private environmentTexture: THREE.Texture | null = null;
  private frameRequest = 0;
  private currentTime = 0;
  private previousTimestamp = performance.now();
  private playing = true;
  private syncScreen = true;
  private hiddenWasPlaying = false;
  private dragDepth = 0;
  private lastFpsTimestamp = performance.now();
  private fpsFrameCount = 0;
  private stateTimer = 0;

  constructor(elements: HeroElements, options: HeroOptions) {
    this.elements = elements;
    this.options = options;
    this.currentTime = options.fixedTime ?? (options.reducedMotion ? 26.25 : 0);
    this.playing = options.fixedTime === null && !options.reducedMotion;

    RectAreaLightUniformsLib.init();
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = new THREE.FogExp2(0x000000, 0.011);

    this.camera = new THREE.PerspectiveCamera(HERO_CONFIG.canvas.fov, HERO_CONFIG.canvas.aspectRatio, 0.1, 100);
    this.camera.position.set(0, 0, 25);

    this.renderer = new THREE.WebGLRenderer({
      canvas: elements.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.setClearColor(0x000000, 1);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environmentTexture = pmrem.fromScene(new RoomEnvironment(), 0.035).texture;
    this.scene.environment = this.environmentTexture;
    pmrem.dispose();

    let pendingTexture: THREE.Texture | null = null;
    this.screen = new ScreenSource({
      onTexture: texture => {
        if (this.device) this.device.setScreenTexture(texture);
        else pendingTexture = texture;
      },
      onState: (state, message) => this.setAssetState(state, message),
    });
    this.device = createHeroDevice(pendingTexture ?? this.screen.fallbackTexture);
    this.scene.add(this.device.root);

    this.rimLight = new THREE.RectAreaLight(0xdfe9f0, 0, 2.2, 18);
    this.rimLight.position.set(-5.6, 1.1, -4.8);
    this.rimLight.lookAt(0, 0.5, 0);
    this.scene.add(this.rimLight);

    this.secondaryRim = new THREE.RectAreaLight(0xfff3df, 0, 2.6, 13);
    this.secondaryRim.position.set(6.4, -0.6, -2.5);
    this.secondaryRim.lookAt(0, 0, 0);
    this.scene.add(this.secondaryRim);

    this.keyLight = new THREE.RectAreaLight(0xffeee1, 0, 7.5, 11.5);
    this.keyLight.position.set(-7.2, 4.3, 9.4);
    this.keyLight.lookAt(0, 0.5, 0);
    this.scene.add(this.keyLight);

    this.topLight = new THREE.RectAreaLight(0xd9e3eb, 4.5, 6, 2.5);
    this.topLight.position.set(0, 9, 2.5);
    this.topLight.lookAt(0, 0, 0);
    this.scene.add(this.topLight);

    this.screenGlow = new THREE.RectAreaLight(0xffe8cf, 0, 5.8, 10.5);
    this.screenGlow.position.set(0, 0.6, 5.2);
    this.screenGlow.lookAt(0, 0.4, 0);
    this.scene.add(this.screenGlow);

    const ambient = new THREE.HemisphereLight(0xcbd5df, 0x090704, 0.18);
    this.scene.add(ambient);

    this.addBackdropAccents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(elements.stage);
    this.resize();
    this.bindControls();

    elements.controls.hidden = !options.showControls;
    elements.timeInput.max = String(HERO_CONFIG.duration);
    elements.timeInput.value = String(this.currentTime);

    if (HERO_CONFIG.device.modelUrl) {
      void this.device.loadModel(HERO_CONFIG.device.modelUrl).catch(() => {
        this.setAssetState('error', '正式 GLB 载入失败，已使用程序化设备');
      });
    }
    if (HERO_CONFIG.screen.videoUrl) void this.screen.setUrl(HERO_CONFIG.screen.videoUrl);

    this.renderAt(this.currentTime, true);
    this.frameRequest = requestAnimationFrame(timestamp => this.animate(timestamp));
  }

  private addBackdropAccents(): void {
    const haloMaterial = new THREE.MeshBasicMaterial({
      color: 0x161b20,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(new THREE.CircleGeometry(10.5, 96), haloMaterial);
    halo.position.set(1.5, 0.4, -5.8);
    this.scene.add(halo);

    const lowerGlowMaterial = new THREE.MeshBasicMaterial({
      color: 0x211912,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lowerGlow = new THREE.Mesh(new THREE.PlaneGeometry(22, 7), lowerGlowMaterial);
    lowerGlow.position.set(1.5, -7.4, -2.2);
    lowerGlow.rotation.x = -0.18;
    this.scene.add(lowerGlow);
  }

  private setAssetState(state: ScreenSourceState, message: string): void {
    this.elements.assetStatus.textContent = message;
    this.elements.assetStatus.dataset.state = state;
    this.elements.stage.dataset.assetState = state;
    window.clearTimeout(this.stateTimer);
    if (state === 'error' || this.options.showControls) {
      this.elements.assetStatus.classList.add('is-visible');
      if (!this.options.showControls) {
        this.stateTimer = window.setTimeout(() => this.elements.assetStatus.classList.remove('is-visible'), 5200);
      }
    } else {
      this.elements.assetStatus.classList.remove('is-visible');
    }
  }

  private bindControls(): void {
    const {stage, playButton, restartButton, fileButton, fileInput, timeInput} = this.elements;
    const toggle = () => this.togglePlay();
    const restart = () => this.restart();
    const chooseFile = () => fileInput.click();
    const fileChanged = () => {
      const [file] = Array.from(fileInput.files ?? []);
      if (file) void this.screen.setFile(file);
      fileInput.value = '';
    };
    const scrub = () => {
      this.currentTime = clamp(Number(timeInput.value), 0, HERO_CONFIG.duration);
      this.playing = false;
      this.syncScreen = true;
      this.updateControlState();
      this.renderAt(this.currentTime, true);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.code === 'Space') {
        event.preventDefault();
        this.togglePlay();
      } else if (event.key.toLowerCase() === 'r') {
        this.restart();
      } else if (event.key.toLowerCase() === 'v') {
        fileInput.click();
      }
    };
    const pointerDown = () => {
      if (this.playing) this.screen.update(this.currentTime - HERO_CONFIG.screen.videoStart, true);
    };
    const dragEnter = (event: DragEvent) => {
      event.preventDefault();
      this.dragDepth += 1;
      stage.classList.add('is-dragging');
    };
    const dragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const dragLeave = (event: DragEvent) => {
      event.preventDefault();
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) stage.classList.remove('is-dragging');
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      this.dragDepth = 0;
      stage.classList.remove('is-dragging');
      const file = Array.from(event.dataTransfer?.files ?? []).find(item => item.type.startsWith('video/'));
      if (file) void this.screen.setFile(file);
      else this.setAssetState('error', '请拖入浏览器可播放的视频文件');
    };
    const visibility = () => {
      if (document.hidden) {
        this.hiddenWasPlaying = this.playing;
        this.playing = false;
        this.screen.update(this.currentTime - HERO_CONFIG.screen.videoStart, false);
      } else if (this.hiddenWasPlaying && this.options.fixedTime === null && !this.options.reducedMotion) {
        this.hiddenWasPlaying = false;
        this.playing = true;
        this.previousTimestamp = performance.now();
      }
      this.updateControlState();
    };

    playButton.addEventListener('click', toggle);
    restartButton.addEventListener('click', restart);
    fileButton.addEventListener('click', chooseFile);
    fileInput.addEventListener('change', fileChanged);
    timeInput.addEventListener('input', scrub);
    window.addEventListener('keydown', keydown);
    stage.addEventListener('pointerdown', pointerDown);
    stage.addEventListener('dragenter', dragEnter);
    stage.addEventListener('dragover', dragOver);
    stage.addEventListener('dragleave', dragLeave);
    stage.addEventListener('drop', drop);
    document.addEventListener('visibilitychange', visibility);

    this.disposables.push(
      () => playButton.removeEventListener('click', toggle),
      () => restartButton.removeEventListener('click', restart),
      () => fileButton.removeEventListener('click', chooseFile),
      () => fileInput.removeEventListener('change', fileChanged),
      () => timeInput.removeEventListener('input', scrub),
      () => window.removeEventListener('keydown', keydown),
      () => stage.removeEventListener('pointerdown', pointerDown),
      () => stage.removeEventListener('dragenter', dragEnter),
      () => stage.removeEventListener('dragover', dragOver),
      () => stage.removeEventListener('dragleave', dragLeave),
      () => stage.removeEventListener('drop', drop),
      () => document.removeEventListener('visibilitychange', visibility),
    );
    this.updateControlState();
  }

  private togglePlay(): void {
    if (this.options.fixedTime !== null || this.options.reducedMotion) return;
    this.playing = !this.playing;
    this.previousTimestamp = performance.now();
    this.syncScreen = true;
    this.updateControlState();
  }

  private restart(): void {
    if (this.options.fixedTime !== null) return;
    this.currentTime = 0;
    this.playing = !this.options.reducedMotion;
    this.previousTimestamp = performance.now();
    this.syncScreen = true;
    this.updateControlState();
    this.renderAt(this.currentTime, true);
  }

  private updateControlState(): void {
    this.elements.playButton.textContent = this.playing ? '暂停' : '播放';
    this.elements.playButton.setAttribute('aria-pressed', String(!this.playing));
  }

  private resize(): void {
    const width = Math.max(1, this.elements.stage.clientWidth);
    const height = Math.max(1, this.elements.stage.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, HERO_CONFIG.canvas.maxDpr);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate(timestamp: number): void {
    const delta = Math.min((timestamp - this.previousTimestamp) / 1000, 0.1);
    this.previousTimestamp = timestamp;
    if (this.playing) {
      this.currentTime += delta;
      if (this.currentTime >= HERO_CONFIG.duration) {
        this.currentTime = HERO_CONFIG.loop ? this.currentTime % HERO_CONFIG.duration : HERO_CONFIG.duration;
        this.playing = HERO_CONFIG.loop;
        this.syncScreen = true;
      }
    }
    this.renderAt(this.currentTime, this.syncScreen);
    this.syncScreen = false;
    this.updateFps(timestamp);
    this.frameRequest = requestAnimationFrame(next => this.animate(next));
  }

  private updateFps(timestamp: number): void {
    if (!this.options.showControls) return;
    this.fpsFrameCount += 1;
    const elapsed = timestamp - this.lastFpsTimestamp;
    if (elapsed < 500) return;
    const fps = Math.round(this.fpsFrameCount * 1000 / elapsed);
    this.elements.fpsReadout.textContent = `${fps} fps`;
    this.lastFpsTimestamp = timestamp;
    this.fpsFrameCount = 0;
  }

  private renderAt(time: number, forceSync = false): void {
    const devicePosition = sampleVector(time, HERO_CONFIG.device.position);
    const deviceRotation = sampleVector(time, HERO_CONFIG.device.rotation);
    const cameraPosition = sampleVector(time, HERO_CONFIG.camera.position);
    const cameraTarget = sampleVector(time, HERO_CONFIG.camera.target);
    const screenBrightness = sampleScalar(time, HERO_CONFIG.screen.brightness);
    const brandOpacity = sampleScalar(time, HERO_CONFIG.overlays.brandOpacity);
    const fadeOpacity = sampleScalar(time, HERO_CONFIG.overlays.fadeOpacity);

    this.device.root.position.set(...devicePosition);
    this.device.root.rotation.set(...deviceRotation);
    this.camera.position.set(...cameraPosition);
    this.camera.lookAt(...cameraTarget);

    this.rimLight.intensity = sampleScalar(time, HERO_CONFIG.lights.rim);
    this.secondaryRim.intensity = this.rimLight.intensity * 0.46;
    this.keyLight.intensity = sampleScalar(time, HERO_CONFIG.lights.key);
    this.screenGlow.intensity = sampleScalar(time, HERO_CONFIG.lights.screenGlow);
    this.screenGlow.position.x = devicePosition[0];
    this.screenGlow.lookAt(devicePosition[0], devicePosition[1] + 0.35, devicePosition[2]);
    this.topLight.intensity = 1.2 + this.keyLight.intensity * 0.5;

    this.device.screenMaterial.color.setRGB(screenBrightness, screenBrightness, screenBrightness);
    this.device.glassMaterial.opacity = 0.026 + screenBrightness * 0.032;
    this.device.metalMaterial.clearcoatRoughness = 0.13 + (1 - screenBrightness) * 0.07;

    this.elements.brand.style.opacity = brandOpacity.toFixed(4);
    this.elements.brand.style.transform = `translate3d(0, ${(1 - brandOpacity) * 20}px, 0)`;
    this.elements.fade.style.opacity = fadeOpacity.toFixed(4);
    this.elements.flare.style.opacity = (0.06 + screenBrightness * 0.26).toFixed(4);
    this.elements.flare.style.transform = `translate3d(${48 + devicePosition[0] * 2.8}%, 0, 0) scale(${0.86 + screenBrightness * 0.24})`;
    this.elements.timeInput.value = time.toFixed(3);
    this.elements.timeReadout.textContent = `${time.toFixed(1)} / ${HERO_CONFIG.duration}s`;

    this.screen.update(time - HERO_CONFIG.screen.videoStart, this.playing, forceSync);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    cancelAnimationFrame(this.frameRequest);
    window.clearTimeout(this.stateTimer);
    this.resizeObserver.disconnect();
    for (const dispose of this.disposables) dispose();
    this.screen.dispose();
    this.device.dispose();
    this.environmentTexture?.dispose();
    this.renderer.dispose();
  }
}
