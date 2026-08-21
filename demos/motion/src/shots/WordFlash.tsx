import {useCurrentFrame} from 'remotion';
import {FRAMES_PER_BEAT, MOTION_CONFIG} from '../motion/config';
import type {TimelineShot} from '../motion/types';
import {ShotCanvas} from './shared';

export const WordFlash: React.FC<{readonly shot: TimelineShot}> = ({shot}) => {
  const frame = useCurrentFrame();
  const words = Array.isArray(shot.text) ? shot.text : [shot.text ?? ''];
  const wordsPerBeat = shot.wordsPerBeat ?? 1;
  const framesPerWord = FRAMES_PER_BEAT / wordsPerBeat;
  const index = Math.min(words.length - 1, Math.floor(frame / framesPerWord));
  const local = (frame % framesPerWord) / framesPerWord;
  const punch = 1 + Math.max(0, 1 - local * 4) * 0.08;

  return (
    <ShotCanvas background={index % 2 === 0 ? shot.background : shot.background === 'black' ? 'white' : 'black'}>
      <div style={{
        position: 'absolute',
        inset: MOTION_CONFIG.safeMargin,
        display: 'grid',
        placeItems: 'center',
        fontSize: 270,
        fontWeight: 840,
        letterSpacing: `${MOTION_CONFIG.type.tracking}em`,
        transform: `scale(${punch})`,
      }}>
        {words[index]}
      </div>
    </ShotCanvas>
  );
};
