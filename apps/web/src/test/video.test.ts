import {describe, expect, it} from 'vitest';
import {hammingDistance, inspectPixels} from '../video';

describe('video candidate inspection', () => {
  it('computes deterministic hashes and scene distance', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('1234', '1234')).toBe(0);
  });

  it('rejectable dark pixels remain measurable without model calls', () => {
    const pixels = new Uint8ClampedArray(16 * 16 * 4);
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
    const result = inspectPixels(pixels, 16, 16);
    expect(result.brightness).toBe(0);
    expect(result.sharpness).toBe(0);
    expect(result.hash).toHaveLength(16);
  });
});
