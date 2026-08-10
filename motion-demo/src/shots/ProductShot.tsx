import {MOTION_CONFIG} from '../motion/config';
import type {TimelineShot} from '../motion/types';
import {ShotCanvas} from './shared';
import {StillImage} from './StillImage';

export const ProductShot: React.FC<{readonly shot: TimelineShot}> = ({shot}) => (
  <ShotCanvas background="black">
    {shot.asset ? (
      <StillImage
        asset={shot.asset}
        style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
      />
    ) : null}
    <div style={{
      position: 'absolute',
      left: MOTION_CONFIG.safeMargin,
      bottom: 82,
      color: 'rgba(245,245,247,.58)',
      font: `560 23px/1 ${MOTION_CONFIG.type.text}`,
      letterSpacing: '0.22em',
    }}>
      {shot.eyebrow}
    </div>
  </ShotCanvas>
);
