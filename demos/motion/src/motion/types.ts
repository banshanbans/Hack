export type ShotType =
  | 'bigText'
  | 'wordFlash'
  | 'splitText'
  | 'productShot'
  | 'videoShot'
  | 'uiShot'
  | 'metricShot'
  | 'logoShot';

export type AnimationPreset =
  | 'scale'
  | 'scale-out'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'match-left'
  | 'match-up'
  | 'cut';

export type ShotBackground = 'black' | 'white' | 'warm-white';

export interface TimelineShotInput {
  readonly id: string;
  readonly beat: number;
  readonly durationBeats: number;
  readonly type: ShotType;
  readonly text?: string | readonly string[];
  readonly asset?: string | null;
  readonly animation: AnimationPreset;
  readonly background?: ShotBackground;
  readonly eyebrow?: string;
  readonly detail?: string;
  readonly value?: string;
  readonly layout?: 'center' | 'left' | 'right' | 'phone' | 'cover';
  readonly wordsPerBeat?: number;
}

export interface TimelineShot extends TimelineShotInput {
  readonly time: number;
  readonly duration: number;
}

export interface SoundCue {
  readonly id: string;
  readonly beat: number;
  readonly time: number;
  readonly asset: string | null;
  readonly volume: number;
  readonly label: string;
}
