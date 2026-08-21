import {beatToSeconds, beatsToSeconds} from './config';
import type {SoundCue, TimelineShot, TimelineShotInput} from './types';

export const defineShot = (input: TimelineShotInput): TimelineShot => ({
  ...input,
  time: beatToSeconds(input.beat),
  duration: beatsToSeconds(input.durationBeats),
});

export const defineSoundCue = (input: Omit<SoundCue, 'time'>): SoundCue => ({
  ...input,
  time: beatToSeconds(input.beat),
});

export const validateTimeline = (shots: readonly TimelineShot[]): void => {
  if (shots.length === 0) throw new Error('Timeline must contain at least one shot.');
  shots.forEach((shot, index) => {
    if (shot.beat < 0 || shot.durationBeats <= 0) {
      throw new Error(`Invalid timing for shot ${shot.id}.`);
    }
    const next = shots[index + 1];
    if (next && next.beat < shot.beat) {
      throw new Error(`Timeline is not ordered at shot ${next.id}.`);
    }
  });
};
