import type {CSSProperties, PropsWithChildren} from 'react';
import {Easing, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {FRAMES_PER_BEAT, MOTION_CONFIG} from './config';
import type {AnimationPreset} from './types';

interface TransitionProps extends PropsWithChildren {
  readonly preset: AnimationPreset;
  readonly durationInFrames: number;
  readonly style?: CSSProperties;
}

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

export const Transition: React.FC<TransitionProps> = ({preset, durationInFrames, style, children}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enterFrames = Math.max(2, Math.round(MOTION_CONFIG.transition.enterBeats * FRAMES_PER_BEAT));
  const exitFrames = Math.max(2, Math.round(MOTION_CONFIG.transition.exitBeats * FRAMES_PER_BEAT));
  const enter = interpolate(frame, [0, enterFrames], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  const exit = interpolate(frame, [durationInFrames - exitFrames, durationInFrames - 1], [0, 1], {
    ...clamp,
    easing: Easing.in(Easing.cubic),
  });
  const visible = Math.min(enter, 1 - exit);
  const velocity = Math.max(1 - enter, exit);

  let x = 0;
  let y = 0;
  let scale = 1;

  if (preset === 'scale') scale = MOTION_CONFIG.transition.scaleIn + enter * (1 - MOTION_CONFIG.transition.scaleIn) + exit * 0.18;
  if (preset === 'scale-out') scale = 1.12 - enter * 0.12 + exit * 0.24;
  if (preset === 'slide-left' || preset === 'match-left') {
    x = (1 - enter) * MOTION_CONFIG.transition.travelX - exit * MOTION_CONFIG.transition.travelX;
  }
  if (preset === 'slide-right') {
    x = -(1 - enter) * MOTION_CONFIG.transition.travelX + exit * MOTION_CONFIG.transition.travelX;
  }
  if (preset === 'slide-up' || preset === 'match-up') {
    y = (1 - enter) * MOTION_CONFIG.transition.travelY - exit * MOTION_CONFIG.transition.travelY;
  }
  if (preset === 'slide-down') {
    y = -(1 - enter) * MOTION_CONFIG.transition.travelY + exit * MOTION_CONFIG.transition.travelY;
  }
  if (preset === 'cut') {
    scale = 1;
  }

  const blur = preset === 'cut' ? 0 : velocity * MOTION_CONFIG.transition.maxBlur * Math.min(1, fps / 30);

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      opacity: preset === 'cut' ? 1 : visible,
      transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
      filter: blur > 0.25 ? `blur(${blur}px)` : undefined,
      transformOrigin: 'center',
      willChange: 'transform, opacity, filter',
      ...style,
    }}>
      {children}
    </div>
  );
};
