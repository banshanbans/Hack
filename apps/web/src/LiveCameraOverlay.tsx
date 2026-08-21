import {useEffect, useMemo, useRef, useState} from 'react';
import {CAMERA_COPY} from './content';
import {coverMetrics, mapImagePoint} from './RiskOverlay';
import type {CameraSuggestion, RiskRegion} from './types';

export interface NumberedCameraSuggestion {
  suggestion: CameraSuggestion;
  number: number;
}

interface Props {
  frameId: string;
  imageUrl: string;
  frameWidth: number;
  frameHeight: number;
  suggestions: NumberedCameraSuggestion[];
  mirrored: boolean;
}

function mirroredRegion(region: RiskRegion, mirrored: boolean): RiskRegion {
  if (!mirrored) return region;
  if (region.type === 'bbox') return {...region, x: 1 - region.x - region.width};
  return {...region, points: region.points.map(([x, y]) => [1 - x, y])};
}

function regionPosition(region: RiskRegion): string {
  const center = region.type === 'bbox'
    ? [region.x + region.width / 2, region.y + region.height / 2]
    : region.points.reduce((sum, point) => [sum[0] + point[0] / region.points.length, sum[1] + point[1] / region.points.length], [0, 0]);
  const horizontal = center[0] < 1 / 3 ? CAMERA_COPY.positionLeft : center[0] > 2 / 3 ? CAMERA_COPY.positionRight : CAMERA_COPY.positionCenter;
  const vertical = center[1] < 1 / 3 ? CAMERA_COPY.positionTop : center[1] > 2 / 3 ? CAMERA_COPY.positionBottom : CAMERA_COPY.positionMiddle;
  return `${vertical}${horizontal}`;
}

export default function LiveCameraOverlay({frameId, imageUrl, frameWidth, frameHeight, suggestions, mirrored}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({width: 1, height: 1});
  const metrics = useMemo(() => coverMetrics(size.width, size.height, frameWidth, frameHeight), [frameHeight, frameWidth, size]);

  useEffect(() => {
    if (!hostRef.current) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({width: rect.width, height: rect.height});
    });
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, []);

  return <div ref={hostRef} className="camera-region-overlay" data-frame-id={frameId}>
    <img src={imageUrl} className={mirrored ? 'mirrored' : ''} alt="" aria-hidden="true" />
    <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label={CAMERA_COPY.regionOverlayLabel}>
      <title>{CAMERA_COPY.regionOverlayLabel}</title>
      <desc>{CAMERA_COPY.regionOverlayDescription}</desc>
      {suggestions.slice(0, 5).map(({suggestion, number}) => {
        if (!suggestion.region) return null;
        const region = mirroredRegion(suggestion.region, mirrored);
        const points = region.type === 'bbox'
          ? [[region.x, region.y], [region.x + region.width, region.y + region.height]] as [number, number][]
          : region.points;
        const mapped = points.map(point => mapImagePoint(point, metrics));
        const center = region.type === 'bbox'
          ? mapImagePoint([region.x + region.width / 2, region.y + region.height / 2], metrics)
          : mapped.reduce((sum, point) => [sum[0] + point[0] / mapped.length, sum[1] + point[1] / mapped.length], [0, 0]);
        const accessibleLabel = CAMERA_COPY.regionItemLabel(number, suggestion.title, regionPosition(suggestion.region), suggestion.confidence, suggestion.needs_manual_check);
        return <g key={suggestion.suggestion_id} role="img" aria-label={accessibleLabel} tabIndex={0}>
          <title>{accessibleLabel}</title>
          {region.type === 'bbox'
            ? <rect x={mapped[0][0] * 1000} y={mapped[0][1] * 1000} width={(mapped[1][0] - mapped[0][0]) * 1000} height={(mapped[1][1] - mapped[0][1]) * 1000} rx="18" className="camera-region" vectorEffect="non-scaling-stroke" />
            : <polygon points={mapped.map(point => `${point[0] * 1000},${point[1] * 1000}`).join(' ')} className="camera-region" vectorEffect="non-scaling-stroke" />}
          <circle cx={center[0] * 1000} cy={center[1] * 1000} r="34" className="camera-region-pin" vectorEffect="non-scaling-stroke" />
          <text x={center[0] * 1000} y={center[1] * 1000 + 11} className="camera-region-number">{number}</text>
        </g>;
      })}
    </svg>
  </div>;
}
