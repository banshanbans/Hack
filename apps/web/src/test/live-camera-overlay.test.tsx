import {describe, expect, it} from 'vitest';
import {render, screen} from '@testing-library/react';
import LiveCameraOverlay from '../LiveCameraOverlay';
import type {CameraSuggestion, RiskRegion} from '../types';

function suggestion(id: string, region: RiskRegion | null, needsManualCheck = false): CameraSuggestion {
  return {
    suggestion_id: id, risk_code: 'floor_clutter', title: '通道有杂物', short_advice: '移开杂物', evidence: '画面中有纸箱',
    confidence: .91, needs_manual_check: needsManualCheck, possible_repeat: false, region, temporary: true, save_as_evidence_recommended: true,
  };
}

describe('live camera SVG overlay', () => {
  it('renders bbox and polygon with stable history numbers and accessible labels', () => {
    const {container} = render(<LiveCameraOverlay
      frameId="frame-1" imageUrl="blob:frame-1" frameWidth={1280} frameHeight={720} mirrored={false}
      suggestions={[
        {suggestion: suggestion('bbox', {type: 'bbox', x: .1, y: .2, width: .3, height: .2}), number: 3},
        {suggestion: suggestion('polygon', {type: 'polygon', points: [[.5, .5], [.8, .5], [.7, .8]]}, true), number: 4},
      ]}
    />);

    expect(container.querySelector('rect.camera-region')).not.toBeNull();
    expect(container.querySelector('polygon.camera-region')).not.toBeNull();
    expect(container.querySelector('.camera-region-overlay > img')?.getAttribute('src')).toBe('blob:frame-1');
    expect([...container.querySelectorAll('.camera-region-number')].map(node => node.textContent)).toEqual(['3', '4']);
    expect(screen.getByLabelText(/临时建议 3，通道有杂物/)).toBeInTheDocument();
    expect(screen.getByLabelText(/临时建议 4.*需要人工确认/)).toBeInTheDocument();
  });

  it('does not draw a suggestion without a reliable region', () => {
    const {container} = render(<LiveCameraOverlay frameId="frame-2" imageUrl="blob:frame-2" frameWidth={720} frameHeight={1280} mirrored={false} suggestions={[
      {suggestion: suggestion('no-region', null), number: 1},
    ]} />);
    expect(container.querySelector('.camera-region')).toBeNull();
  });

  it('mirrors bbox coordinates without mirroring its readable number', () => {
    const {container} = render(<LiveCameraOverlay frameId="frame-3" imageUrl="blob:frame-3" frameWidth={1000} frameHeight={1000} mirrored suggestions={[
      {suggestion: suggestion('bbox', {type: 'bbox', x: .1, y: .2, width: .2, height: .2}), number: 2},
    ]} />);
    const rect = container.querySelector('rect.camera-region');
    expect(Number(rect?.getAttribute('x'))).toBeCloseTo(700);
    expect(container.querySelector('.camera-region-overlay > img')).toHaveClass('mirrored');
    expect(container.querySelector('.camera-region-number')?.getAttribute('transform')).toBeNull();
  });
});
