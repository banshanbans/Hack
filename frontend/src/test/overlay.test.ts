import {describe, expect, it} from 'vitest';
import {coverMetrics, mapImagePoint, unmapStagePoint} from '../RiskOverlay';

describe('risk coordinate mapping', () => {
  it('maps a square image through landscape object-fit cover', () => {
    const metrics = coverMetrics(390, 260, 1000, 1000);
    expect(metrics.offsetY).toBeCloseTo(-65);
    expect(mapImagePoint([0.5, 0.5], metrics)).toEqual([0.5, 0.5]);
  });

  it('round-trips normalized coordinates and clamps crop margins', () => {
    const metrics = coverMetrics(320, 400, 1600, 900);
    const source: [number, number] = [0.42, 0.65];
    const mapped = mapImagePoint(source, metrics);
    const restored = unmapStagePoint(mapped, metrics);
    expect(restored[0]).toBeCloseTo(source[0]);
    expect(restored[1]).toBeCloseTo(source[1]);
    expect(unmapStagePoint([-1, -1], metrics)).toEqual([0, 0]);
  });
});
