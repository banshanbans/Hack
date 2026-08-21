import {MOTION_CONFIG} from '../motion/config';
import type {TimelineShot} from '../motion/types';
import {ShotCanvas} from './shared';
import {StillImage} from './StillImage';

export const UIShot: React.FC<{readonly shot: TimelineShot}> = ({shot}) => (
  <ShotCanvas background={shot.background ?? 'white'}>
    <div style={{
      position: 'absolute',
      left: MOTION_CONFIG.safeMargin,
      top: 100,
      width: 630,
      zIndex: 2,
      color: shot.background === 'black' ? '#fff' : '#090909',
    }}>
      <div style={{fontSize: 28, fontWeight: 650, letterSpacing: '0.16em', opacity: 0.48}}>{shot.eyebrow}</div>
      <div style={{marginTop: 30, fontSize: 108, fontWeight: 820, lineHeight: 0.95, letterSpacing: '-0.06em', whiteSpace: 'pre-line'}}>{shot.text}</div>
      <div style={{marginTop: 34, maxWidth: 520, font: `520 29px/1.5 ${MOTION_CONFIG.type.text}`, opacity: 0.62}}>{shot.detail}</div>
    </div>
    {shot.asset ? (
      <div style={{
        position: 'absolute',
        right: 176,
        top: 66,
        width: 500,
        height: 948,
        overflow: 'hidden',
        borderRadius: 64,
        background: '#ddd',
        boxShadow: shot.background === 'black' ? '0 44px 120px rgba(0,0,0,.75)' : '0 40px 100px rgba(0,0,0,.18)',
      }}>
        <StillImage asset={shot.asset} style={{width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top center'}} />
      </div>
    ) : null}
  </ShotCanvas>
);
