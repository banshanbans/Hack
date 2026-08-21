import {Sequence} from 'remotion';
import {ShotRenderer} from '../shots/ShotRenderer';
import {beatToFrame, beatsToFrames} from './config';
import type {TimelineShot} from './types';

export const BeatSequence: React.FC<{readonly shots: readonly TimelineShot[]}> = ({shots}) => (
  <>
    {shots.map(shot => (
      <Sequence
        key={shot.id}
        name={`${shot.beat}b · ${shot.id}`}
        from={beatToFrame(shot.beat)}
        durationInFrames={beatsToFrames(shot.durationBeats)}
        premountFor={12}
      >
        <ShotRenderer shot={shot} />
      </Sequence>
    ))}
  </>
);
