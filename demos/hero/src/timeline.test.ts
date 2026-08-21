import {describe, expect, it} from 'vitest';
import {applyEase, sampleScalar, sampleVector} from './timeline';

describe('hero timeline', () => {
  it('holds values before and after the configured range', () => {
    const frames = [{time: 2, value: 4}, {time: 6, value: 12}] as const;
    expect(sampleScalar(0, frames)).toBe(4);
    expect(sampleScalar(9, frames)).toBe(12);
  });

  it('uses deterministic cinematic interpolation', () => {
    const frames = [{time: 0, value: 0}, {time: 10, value: 100, ease: 'cinematic' as const}];
    expect(sampleScalar(5, frames)).toBeCloseTo(50, 6);
    expect(sampleScalar(2, frames)).toBeLessThan(10);
    expect(sampleScalar(8, frames)).toBeGreaterThan(90);
  });

  it('interpolates camera and device vectors component by component', () => {
    const frames = [
      {time: 0, value: [0, 0, 10] as const},
      {time: 10, value: [10, -4, 20] as const, ease: 'linear' as const},
    ];
    expect(sampleVector(5, frames)).toEqual([5, -2, 15]);
  });

  it('keeps every easing curve inside its endpoints', () => {
    for (const easing of ['linear', 'sine', 'cinematic', 'quint'] as const) {
      expect(applyEase(-1, easing)).toBe(0);
      expect(applyEase(2, easing)).toBe(1);
    }
  });
});
