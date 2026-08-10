import {describe, expect, it} from 'vitest';
import {FRAMES_PER_BEAT, MOTION_CONFIG, beatToFrame} from '../motion/config';
import {DEMO_DURATION_FRAMES, DEMO_END_BEAT, DEMO_TIMELINE, SOUND_CUES} from './demo.timeline';

describe('beat-driven demo timeline', () => {
  it('maps 150 BPM at 30fps to an integer frame grid', () => {
    expect(FRAMES_PER_BEAT).toBe(12);
    expect(beatToFrame(4)).toBe(48);
  });

  it('stays between 10 and 15 seconds', () => {
    const seconds = DEMO_DURATION_FRAMES / MOTION_CONFIG.fps;
    expect(seconds).toBeGreaterThanOrEqual(10);
    expect(seconds).toBeLessThanOrEqual(15);
  });

  it('contains required reusable shot families', () => {
    const types = new Set(DEMO_TIMELINE.map(shot => shot.type));
    for (const type of ['bigText', 'wordFlash', 'splitText', 'productShot', 'uiShot', 'metricShot', 'logoShot']) {
      expect(types.has(type as never)).toBe(true);
    }
  });

  it('stores derived seconds and beat-synced sound cues', () => {
    expect(DEMO_END_BEAT).toBe(32);
    expect(DEMO_TIMELINE[1].time).toBeCloseTo(0.8);
    expect(DEMO_TIMELINE[1].duration).toBeCloseTo(0.8);
    expect(SOUND_CUES.every(cue => cue.time >= 0 && cue.beat >= 0)).toBe(true);
  });
});
