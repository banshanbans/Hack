import {describe, expect, it} from 'vitest';
import React from 'react';
import {render} from '@testing-library/react';
import RiskOverlay, {coverMetrics, mapImagePoint, unmapStagePoint} from '../RiskOverlay';
import type {SafetyRisk} from '../types';

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

  it('keeps stable room numbers and never renders another photo risk', () => {
    const base: Omit<SafetyRisk, 'risk_id' | 'media_id' | 'title'> = {
      room_id: 'room-1', risk_code: 'TEST', state: 'unreviewed', feedback: null,
      evidence: '证据', confidence: 0.9, region: {type: 'bbox', x: 0.1, y: 0.1, width: 0.2, height: 0.2},
      severity: 'high', score_deduction: 5,
    };
    const risks: SafetyRisk[] = [
      {...base, risk_id: 'risk-a', media_id: 'media-a', title: '照片 A 风险'},
      {...base, risk_id: 'risk-b', media_id: 'media-b', title: '照片 B 风险'},
    ];
    const {container} = render(React.createElement(RiskOverlay, {imageUrl: '', fallbackUrl: '/fallback.jpg', risks, mediaId: 'media-b', activeId: '', numberById: {'risk-a': 1, 'risk-b': 4}, zoom: 1, drawing: false, onSelect: () => undefined, onRegionChange: () => undefined}));
    expect([...container.querySelectorAll('svg text')].map(node => node.textContent)).toEqual(['4']);
    expect(container.querySelectorAll('svg g')).toHaveLength(1);
  });
});
