import {OffthreadVideo, staticFile} from 'remotion';
import type {TimelineShot} from '../motion/types';
import {ShotCanvas} from './shared';

export const VideoShot: React.FC<{readonly shot: TimelineShot}> = ({shot}) => (
  <ShotCanvas background={shot.background}>
    {shot.asset ? (
      <OffthreadVideo
        src={staticFile(shot.asset)}
        muted
        style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
      />
    ) : (
      <div style={{position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 62}}>
        VIDEO
      </div>
    )}
  </ShotCanvas>
);
