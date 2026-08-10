import type {CSSProperties, PropsWithChildren} from 'react';
import {AbsoluteFill} from 'remotion';
import {MOTION_CONFIG} from '../motion/config';
import type {ShotBackground} from '../motion/types';

export const backgroundColor = (background: ShotBackground = 'black'): string => {
  if (background === 'white') return MOTION_CONFIG.colors.white;
  if (background === 'warm-white') return MOTION_CONFIG.colors.warmWhite;
  return MOTION_CONFIG.colors.black;
};

export const foregroundColor = (background: ShotBackground = 'black'): string =>
  background === 'black' ? MOTION_CONFIG.colors.white : MOTION_CONFIG.colors.black;

export const ShotCanvas: React.FC<PropsWithChildren<{readonly background?: ShotBackground; readonly style?: CSSProperties}>> = ({background, style, children}) => (
  <AbsoluteFill style={{
    backgroundColor: backgroundColor(background),
    color: foregroundColor(background),
    overflow: 'hidden',
    fontFamily: MOTION_CONFIG.type.display,
    ...style,
  }}>
    {children}
  </AbsoluteFill>
);

export const FilmGrain: React.FC = () => (
  <AbsoluteFill style={{
    pointerEvents: 'none',
    opacity: 0.035,
    mixBlendMode: 'soft-light',
    backgroundImage: 'repeating-radial-gradient(circle at 20% 30%, rgba(255,255,255,.45) 0 1px, transparent 1px 4px)',
    backgroundSize: '7px 7px',
  }} />
);
