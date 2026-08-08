export type Vec3Tuple = readonly [number, number, number];
export type EaseName = 'linear' | 'sine' | 'cinematic' | 'quint';

export interface ScalarKeyframe {
  readonly time: number;
  readonly value: number;
  readonly ease?: EaseName;
}

export interface VectorKeyframe {
  readonly time: number;
  readonly value: Vec3Tuple;
  readonly ease?: EaseName;
}

export const HERO_CONFIG = {
  duration: 28,
  loop: true,
  canvas: {
    aspectRatio: 16 / 9,
    maxDpr: 1.75,
    fov: 34,
  },
  device: {
    modelUrl: '/models/iphone17promax.glb',
    modelHeight: 13.72,
    modelRotation: [0, 0, 0] as Vec3Tuple,
    modelOffset: [0, 0, 0] as Vec3Tuple,
    modelScreenMeshName: 'HkNSnYzBPABcqwM.001',
    modelScreenMaterialName: 'BsXHDwLKqtDOfrW',
    modelScreenUvRotation: 0,
    modelScreenUvFlipX: false,
    modelScreenUvFlipY: true,
    screenWidth: 6.12,
    screenHeight: 13.08,
    screenCornerRadius: 0.64,
    position: [
      {time: 0, value: [0.15, -0.12, 0] as Vec3Tuple},
      {time: 18, value: [0.15, -0.06, 0] as Vec3Tuple, ease: 'cinematic'},
      {time: 22, value: [0.15, -0.06, 0] as Vec3Tuple, ease: 'cinematic'},
      {time: 26.6, value: [4.15, -0.18, 0] as Vec3Tuple, ease: 'cinematic'},
      {time: 28, value: [4.15, -0.18, 0] as Vec3Tuple},
    ] satisfies readonly VectorKeyframe[],
    rotation: [
      {time: 0, value: [-0.035, -1.49, -0.025] as Vec3Tuple},
      {time: 3.8, value: [-0.035, -1.46, -0.025] as Vec3Tuple, ease: 'sine'},
      {time: 8.8, value: [-0.02, -0.54, -0.015] as Vec3Tuple, ease: 'cinematic'},
      {time: 12, value: [0, -0.045, 0] as Vec3Tuple, ease: 'cinematic'},
      {time: 22, value: [0, 0.012, 0] as Vec3Tuple, ease: 'sine'},
      {time: 26.6, value: [-0.015, -0.24, -0.018] as Vec3Tuple, ease: 'cinematic'},
      {time: 28, value: [-0.015, -0.24, -0.018] as Vec3Tuple},
    ] satisfies readonly VectorKeyframe[],
  },
  camera: {
    position: [
      {time: 0, value: [0.7, 0.18, 25.5] as Vec3Tuple},
      {time: 9, value: [0.2, 0.12, 24] as Vec3Tuple, ease: 'cinematic'},
      {time: 12, value: [0, 0.12, 22.4] as Vec3Tuple, ease: 'cinematic'},
      {time: 18, value: [0, 0.42, 13.2] as Vec3Tuple, ease: 'quint'},
      {time: 21.5, value: [0.15, 0.2, 13.5] as Vec3Tuple, ease: 'sine'},
      {time: 26.6, value: [0, 0.05, 25.8] as Vec3Tuple, ease: 'cinematic'},
      {time: 28, value: [0, 0.05, 25.8] as Vec3Tuple},
    ] satisfies readonly VectorKeyframe[],
    target: [
      {time: 0, value: [0, 0.2, 0] as Vec3Tuple},
      {time: 12, value: [0, 0.25, 0] as Vec3Tuple, ease: 'cinematic'},
      {time: 18, value: [0, 1.3, 0] as Vec3Tuple, ease: 'cinematic'},
      {time: 21.5, value: [0, 0.7, 0] as Vec3Tuple, ease: 'sine'},
      {time: 26.6, value: [1.45, 0.05, 0] as Vec3Tuple, ease: 'cinematic'},
      {time: 28, value: [1.45, 0.05, 0] as Vec3Tuple},
    ] satisfies readonly VectorKeyframe[],
  },
  screen: {
    videoUrl: '',
    videoStart: 9.35,
    fit: 'cover' as const,
    brightness: [
      {time: 0, value: 0},
      {time: 8.8, value: 0},
      {time: 10.8, value: 1, ease: 'quint'},
      {time: 27.15, value: 1},
      {time: 28, value: 0.18, ease: 'sine'},
    ] satisfies readonly ScalarKeyframe[],
    fallbackImages: [
      '/media/analysis-bathroom.jpg',
      '/media/risk-bathroom.jpg',
      '/media/solution-shower.jpg',
    ],
  },
  lights: {
    rim: [
      {time: 0, value: 0},
      {time: 1.1, value: 54, ease: 'quint'},
      {time: 7.5, value: 42, ease: 'sine'},
      {time: 12, value: 31, ease: 'sine'},
      {time: 28, value: 34},
    ] satisfies readonly ScalarKeyframe[],
    key: [
      {time: 0, value: 0.15},
      {time: 4, value: 2.2, ease: 'cinematic'},
      {time: 11.5, value: 5.8, ease: 'cinematic'},
      {time: 28, value: 4.6},
    ] satisfies readonly ScalarKeyframe[],
    screenGlow: [
      {time: 0, value: 0},
      {time: 9, value: 0},
      {time: 11.2, value: 8.5, ease: 'quint'},
      {time: 22, value: 6.2, ease: 'sine'},
      {time: 28, value: 4.6},
    ] satisfies readonly ScalarKeyframe[],
  },
  copy: {
    eyebrow: '居家空间 AI 安全守护',
    brand: '长者友好家',
    latinBrand: 'AGE-FRIENDLY HOME',
    tagline: '细微改造，步步心安',
    detail: '看见风险，也看见更安心的生活。',
  },
  overlays: {
    brandOpacity: [
      {time: 0, value: 0},
      {time: 23.7, value: 0},
      {time: 25.4, value: 1, ease: 'cinematic'},
      {time: 27.15, value: 1},
      {time: 28, value: 0, ease: 'sine'},
    ] satisfies readonly ScalarKeyframe[],
    fadeOpacity: [
      {time: 0, value: 1},
      {time: 1.1, value: 0, ease: 'sine'},
      {time: 27.1, value: 0},
      {time: 28, value: 1, ease: 'sine'},
    ] satisfies readonly ScalarKeyframe[],
  },
} as const;
