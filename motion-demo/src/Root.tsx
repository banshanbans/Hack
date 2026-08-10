import {Composition} from 'remotion';
import {FastProductDemo} from './compositions/FastProductDemo';
import {MOTION_CONFIG} from './motion/config';
import {DEMO_DURATION_FRAMES} from './timeline/demo.timeline';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="FastProductDemo"
    component={FastProductDemo}
    width={MOTION_CONFIG.width}
    height={MOTION_CONFIG.height}
    fps={MOTION_CONFIG.fps}
    durationInFrames={DEMO_DURATION_FRAMES}
    defaultProps={{showBeatGrid: false}}
  />
);
