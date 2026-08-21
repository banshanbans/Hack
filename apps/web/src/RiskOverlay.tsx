import {useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';
import type {BBoxRegion, RiskRegion, SafetyRisk} from './types';

interface Props {
  imageUrl: string;
  fallbackUrl: string;
  risks: SafetyRisk[];
  mediaId?: string;
  activeId: string;
  numberById?: Record<string, number>;
  zoom: number;
  drawing: boolean;
  onSelect: (riskId: string) => void;
  onRegionChange: (region: RiskRegion) => void;
}

interface Metrics {width: number; height: number; imageWidth: number; imageHeight: number; offsetX: number; offsetY: number; renderedWidth: number; renderedHeight: number}

export function coverMetrics(containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number): Metrics {
  const safeImageWidth = imageWidth || containerWidth || 1;
  const safeImageHeight = imageHeight || containerHeight || 1;
  const scale = Math.max(containerWidth / safeImageWidth, containerHeight / safeImageHeight);
  const renderedWidth = safeImageWidth * scale;
  const renderedHeight = safeImageHeight * scale;
  return {
    width: containerWidth,
    height: containerHeight,
    imageWidth: safeImageWidth,
    imageHeight: safeImageHeight,
    offsetX: (containerWidth - renderedWidth) / 2,
    offsetY: (containerHeight - renderedHeight) / 2,
    renderedWidth,
    renderedHeight,
  };
}

export function mapImagePoint(point: [number, number], metrics: Metrics): [number, number] {
  return [(metrics.offsetX + point[0] * metrics.renderedWidth) / metrics.width, (metrics.offsetY + point[1] * metrics.renderedHeight) / metrics.height];
}

export function unmapStagePoint(point: [number, number], metrics: Metrics): [number, number] {
  return [
    Math.max(0, Math.min(1, (point[0] * metrics.width - metrics.offsetX) / metrics.renderedWidth)),
    Math.max(0, Math.min(1, (point[1] * metrics.height - metrics.offsetY) / metrics.renderedHeight)),
  ];
}

export default function RiskOverlay({imageUrl, fallbackUrl, risks, mediaId, activeId, numberById = {}, zoom, drawing, onSelect, onRegionChange}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState({width: 1, height: 1});
  const [natural, setNatural] = useState({width: 1, height: 1});
  const [drag, setDrag] = useState<{start: [number, number]; region: BBoxRegion} | null>(null);
  const [drawStart, setDrawStart] = useState<[number, number] | null>(null);
  const [preview, setPreview] = useState<BBoxRegion | null>(null);
  const metrics = useMemo(() => coverMetrics(size.width, size.height, natural.width, natural.height), [natural, size]);
  const active = risks.find(item => item.risk_id === activeId);

  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({width: rect.width, height: rect.height});
    });
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);

  const stagePoint = (event: ReactPointerEvent): [number, number] => {
    const bounds = stageRef.current!.getBoundingClientRect();
    return [(event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height];
  };

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = unmapStagePoint(stagePoint(event), metrics);
    setDrawStart(start);
    setPreview({type: 'bbox', x: start[0], y: start[1], width: 0, height: 0});
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = unmapStagePoint(stagePoint(event), metrics);
    if (drawStart) {
      setPreview({type: 'bbox', x: Math.min(drawStart[0], current[0]), y: Math.min(drawStart[1], current[1]), width: Math.abs(current[0] - drawStart[0]), height: Math.abs(current[1] - drawStart[1])});
    } else if (drag) {
      const dx = current[0] - drag.start[0];
      const dy = current[1] - drag.start[1];
      setPreview({...drag.region, x: Math.max(0, Math.min(1 - drag.region.width, drag.region.x + dx)), y: Math.max(0, Math.min(1 - drag.region.height, drag.region.y + dy))});
    }
  };

  const pointerUp = () => {
    if (preview && preview.width >= 0.03 && preview.height >= 0.03) onRegionChange(preview);
    setDrawStart(null);
    setDrag(null);
    setPreview(null);
  };

  const displayed = risks.filter(item => item.region && (!mediaId || item.media_id === mediaId));
  const regionFor = (risk: SafetyRisk) => risk.risk_id === activeId && preview ? preview : risk.region;

  return <div
    className={`risk-stage ${drawing ? 'is-drawing' : ''}`}
    ref={stageRef}
    onPointerDown={pointerDown}
    onPointerMove={pointerMove}
    onPointerUp={pointerUp}
  >
    <img
      ref={imageRef}
      src={imageUrl || fallbackUrl}
      alt="房间照片，已标出环境风险位置"
      style={{transform: `scale(${zoom})`}}
      onLoad={event => setNatural({width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight})}
    />
    <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="风险位置标注" style={{transform: `scale(${zoom})`}}>
      {displayed.map((risk, index) => {
        const region = regionFor(risk);
        if (!region) return null;
        const points = region.type === 'bbox'
          ? [[region.x, region.y], [region.x + region.width, region.y + region.height]] as [number, number][]
          : region.points;
        const mapped = points.map(point => mapImagePoint(point, metrics));
        const center = region.type === 'bbox'
          ? mapImagePoint([region.x + region.width / 2, region.y + region.height / 2], metrics)
          : mapped.reduce((sum, point) => [sum[0] + point[0] / mapped.length, sum[1] + point[1] / mapped.length], [0, 0]);
        const isActive = risk.risk_id === activeId;
        return <g
          key={risk.risk_id}
          className={`${isActive ? 'active' : ''} severity-${risk.severity}`}
          onPointerDown={event => {
            event.stopPropagation();
            onSelect(risk.risk_id);
            if (isActive && risk.region?.type === 'bbox' && !drawing) {
              const start = unmapStagePoint(stagePoint(event), metrics);
              setDrag({start, region: risk.region});
              (event.currentTarget.ownerSVGElement?.parentElement as HTMLElement)?.setPointerCapture(event.pointerId);
            }
          }}
        >
          {region.type === 'bbox'
            ? <rect x={mapped[0][0] * 1000} y={mapped[0][1] * 1000} width={(mapped[1][0] - mapped[0][0]) * 1000} height={(mapped[1][1] - mapped[0][1]) * 1000} rx="18" className="risk-region" vectorEffect="non-scaling-stroke" />
            : <polygon points={mapped.map(point => `${point[0] * 1000},${point[1] * 1000}`).join(' ')} className="risk-region" vectorEffect="non-scaling-stroke" />}
          <circle cx={center[0] * 1000} cy={center[1] * 1000} r="34" className="risk-pin" />
          <text x={center[0] * 1000} y={center[1] * 1000 + 11} className="risk-pin-text">{numberById[risk.risk_id] || index + 1}</text>
        </g>;
      })}
    </svg>
    {drawing && <div className="draw-instruction">在照片上拖动圈选位置</div>}
    {!imageUrl && <span className="demo-image-label">示意图</span>}
  </div>;
}
