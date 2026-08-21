import {useCurrentFrame} from 'remotion';
import {FRAMES_PER_BEAT, MOTION_CONFIG} from './config';

export const BeatGrid: React.FC = () => {
  const frame = useCurrentFrame();
  const beat = frame / FRAMES_PER_BEAT;
  const pulse = 1 - (frame % FRAMES_PER_BEAT) / FRAMES_PER_BEAT;
  return (
    <div style={{position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 100}}>
      <div style={{
        position: 'absolute',
        top: 36,
        left: 48,
        color: '#fff',
        mixBlendMode: 'difference',
        font: `600 22px/1 ${MOTION_CONFIG.type.text}`,
        letterSpacing: '0.08em',
      }}>
        BEAT {beat.toFixed(2)} · FRAME {frame}
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, height: 8, background: '#fff', opacity: pulse * 0.7}} />
    </div>
  );
};
