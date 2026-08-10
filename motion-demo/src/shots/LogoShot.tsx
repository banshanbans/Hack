import {interpolate, useCurrentFrame} from 'remotion';
import {MOTION_CONFIG} from '../motion/config';
import type {TimelineShot} from '../motion/types';
import {ShotCanvas} from './shared';

export const LogoShot: React.FC<{readonly shot: TimelineShot}> = ({shot}) => {
  const frame = useCurrentFrame();
  const rule = interpolate(frame, [3, 18], [0, 210], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <ShotCanvas background="black">
      <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center'}}>
        <div>
          <div style={{fontSize: 122, fontWeight: 780, lineHeight: 1, letterSpacing: '-0.055em'}}>{shot.text}</div>
          <div style={{width: rule, height: 2, margin: '42px auto', background: MOTION_CONFIG.colors.accent}} />
          <div style={{font: `520 34px/1 ${MOTION_CONFIG.type.text}`, letterSpacing: '0.22em', color: 'rgba(245,245,247,.72)'}}>{shot.detail}</div>
        </div>
      </div>
    </ShotCanvas>
  );
};
