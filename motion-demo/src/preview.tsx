import {StrictMode, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@remotion/player';
import {FastProductDemo} from './compositions/FastProductDemo';
import {MOTION_CONFIG} from './motion/config';
import {DEMO_DURATION_FRAMES} from './timeline/demo.timeline';
import './preview.css';

const Preview: React.FC = () => {
  const [showBeatGrid, setShowBeatGrid] = useState(false);
  return (
    <main className="preview-shell">
      <header className="preview-header">
        <div>
          <p>REMOTION MOTION SYSTEM</p>
          <h1>长者友好家 · 12.8s Demo</h1>
        </div>
        <label>
          <input type="checkbox" checked={showBeatGrid} onChange={event => setShowBeatGrid(event.target.checked)} />
          显示 Beat Grid
        </label>
      </header>
      <section className="player-frame" aria-label="高速产品宣传片预览">
        <Player
          component={FastProductDemo}
          inputProps={{showBeatGrid}}
          durationInFrames={DEMO_DURATION_FRAMES}
          compositionWidth={MOTION_CONFIG.width}
          compositionHeight={MOTION_CONFIG.height}
          fps={MOTION_CONFIG.fps}
          controls
          autoPlay
          initiallyMuted
          loop
          acknowledgeRemotionLicense
          style={{width: '100%', aspectRatio: '16 / 9'}}
        />
      </section>
      <footer>
        <span>{MOTION_CONFIG.width}×{MOTION_CONFIG.height}</span>
        <span>{MOTION_CONFIG.fps} FPS</span>
        <span>{MOTION_CONFIG.bpm} BPM</span>
        <span>32 BEATS</span>
      </footer>
    </main>
  );
};

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Preview root is missing.');
createRoot(root).render(<StrictMode><Preview /></StrictMode>);
