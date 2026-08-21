import {Audio, Sequence, staticFile} from 'remotion';
import {beatToFrame} from './config';
import type {SoundCue} from './types';

export const AudioCues: React.FC<{readonly cues: readonly SoundCue[]}> = ({cues}) => (
  <>
    {cues.filter(cue => cue.asset).map(cue => (
      <Sequence key={cue.id} from={beatToFrame(cue.beat)} name={`SFX · ${cue.label}`}>
        <Audio src={staticFile(cue.asset as string)} volume={cue.volume} />
      </Sequence>
    ))}
  </>
);
