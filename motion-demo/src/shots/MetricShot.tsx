import {interpolate, useCurrentFrame} from 'remotion';
import {MOTION_CONFIG} from '../motion/config';
import type {TimelineShot} from '../motion/types';
import {ShotCanvas} from './shared';

export const MetricShot: React.FC<{readonly shot: TimelineShot}> = ({shot}) => {
  const frame = useCurrentFrame();
  const ruleWidth = interpolate(frame, [0, 12], [0, 720], {extrapolateRight: 'clamp'});
  return (
    <ShotCanvas background={shot.background}>
      <div style={{position: 'absolute', inset: MOTION_CONFIG.safeMargin, display: 'flex', flexDirection: 'column', justifyContent: 'center'}}>
        <div style={{fontSize: 340, fontWeight: 860, lineHeight: 0.78, letterSpacing: '-0.075em'}}>{shot.value}</div>
        <div style={{width: ruleWidth, height: 8, marginTop: 68, background: 'currentColor'}} />
        <div style={{marginTop: 42, fontSize: 74, fontWeight: 720, letterSpacing: '-0.04em'}}>{shot.text}</div>
        <div style={{marginTop: 18, font: `520 29px/1.4 ${MOTION_CONFIG.type.text}`, opacity: 0.56}}>{shot.detail}</div>
      </div>
    </ShotCanvas>
  );
};
