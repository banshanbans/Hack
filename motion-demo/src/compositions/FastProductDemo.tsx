import {AbsoluteFill} from 'remotion';
import {AudioCues} from '../motion/AudioCues';
import {BeatGrid} from '../motion/BeatGrid';
import {BeatSequence} from '../motion/BeatSequence';
import {MOTION_CONFIG} from '../motion/config';
import {DEMO_TIMELINE, SOUND_CUES} from '../timeline/demo.timeline';
import {FilmGrain} from '../shots/shared';

export interface FastProductDemoProps extends Record<string, unknown> {
  readonly showBeatGrid: boolean;
}

export const FastProductDemo: React.FC<FastProductDemoProps> = ({showBeatGrid}) => (
  <AbsoluteFill style={{backgroundColor: MOTION_CONFIG.colors.black}}>
    <BeatSequence shots={DEMO_TIMELINE} />
    <AudioCues cues={SOUND_CUES} />
    <FilmGrain />
    {showBeatGrid ? <BeatGrid /> : null}
  </AbsoluteFill>
);
