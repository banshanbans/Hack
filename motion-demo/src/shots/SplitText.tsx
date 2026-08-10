import {MOTION_CONFIG} from '../motion/config';
import type {TimelineShot} from '../motion/types';
import {ShotCanvas} from './shared';

export const SplitText: React.FC<{readonly shot: TimelineShot}> = ({shot}) => {
  const [top = '', bottom = ''] = Array.isArray(shot.text) ? shot.text : [shot.text ?? '', ''];
  return (
    <ShotCanvas background={shot.background}>
      <div style={{position: 'absolute', inset: 0, display: 'grid', gridTemplateRows: '1fr 1fr'}}>
        {[top, bottom].map((line, index) => (
          <div key={line} style={{
            display: 'flex',
            alignItems: index === 0 ? 'flex-end' : 'flex-start',
            justifyContent: index === 0 ? 'flex-start' : 'flex-end',
            padding: index === 0 ? `0 ${MOTION_CONFIG.safeMargin}px 28px` : `28px ${MOTION_CONFIG.safeMargin}px 0`,
            borderBottom: index === 0 ? '3px solid currentColor' : undefined,
            fontSize: 172,
            fontWeight: 810,
            lineHeight: 0.92,
            letterSpacing: '-0.055em',
          }}>
            {line}
          </div>
        ))}
      </div>
    </ShotCanvas>
  );
};
