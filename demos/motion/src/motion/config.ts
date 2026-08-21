export const MOTION_CONFIG = {
  width: 1920,
  height: 1080,
  fps: 30,
  bpm: 150,
  safeMargin: 112,
  transition: {
    enterBeats: 0.42,
    exitBeats: 0.32,
    scaleIn: 0.72,
    scaleOut: 1.18,
    travelX: 420,
    travelY: 260,
    maxBlur: 12,
  },
  type: {
    display: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif',
    text: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif',
    weight: 760,
    tracking: -0.055,
  },
  colors: {
    black: '#050505',
    white: '#f5f5f7',
    warmWhite: '#f2efe9',
    muted: '#9a9a9f',
    accent: '#d4a46d',
    risk: '#d9534f',
  },
} as const;

export const FRAMES_PER_BEAT = MOTION_CONFIG.fps * 60 / MOTION_CONFIG.bpm;

if (!Number.isInteger(FRAMES_PER_BEAT)) {
  throw new Error('Choose BPM/FPS values that produce an integer number of frames per beat.');
}

export const beatToFrame = (beat: number): number => Math.round(beat * FRAMES_PER_BEAT);
export const beatToSeconds = (beat: number): number => beat * 60 / MOTION_CONFIG.bpm;
export const beatsToFrames = (beats: number): number => Math.max(1, Math.round(beats * FRAMES_PER_BEAT));
export const beatsToSeconds = (beats: number): number => beats * 60 / MOTION_CONFIG.bpm;
