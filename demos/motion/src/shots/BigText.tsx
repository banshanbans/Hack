import {MOTION_CONFIG} from '../motion/config';
import type {TimelineShot} from '../motion/types';
import {ShotCanvas} from './shared';

export const BigText: React.FC<{readonly shot: TimelineShot}> = ({shot}) => (
  <ShotCanvas background={shot.background}>
    <div style={{
      position: 'absolute',
      inset: MOTION_CONFIG.safeMargin,
      display: 'flex',
      alignItems: 'center',
      justifyContent: shot.layout === 'left' ? 'flex-start' : shot.layout === 'right' ? 'flex-end' : 'center',
      textAlign: shot.layout === 'left' ? 'left' : shot.layout === 'right' ? 'right' : 'center',
      fontSize: 250,
      fontWeight: 820,
      lineHeight: 0.88,
      letterSpacing: `${MOTION_CONFIG.type.tracking}em`,
      whiteSpace: 'pre-line',
    }}>
      {typeof shot.text === 'string' ? shot.text : shot.text?.join('\n')}
    </div>
  </ShotCanvas>
);
