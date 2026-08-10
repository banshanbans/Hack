import {beatsToFrames} from '../motion/config';
import type {TimelineShot} from '../motion/types';
import {Transition} from '../motion/Transition';
import {BigText} from './BigText';
import {LogoShot} from './LogoShot';
import {MetricShot} from './MetricShot';
import {ProductShot} from './ProductShot';
import {SplitText} from './SplitText';
import {UIShot} from './UIShot';
import {VideoShot} from './VideoShot';
import {WordFlash} from './WordFlash';

const renderShot = (shot: TimelineShot): React.ReactNode => {
  switch (shot.type) {
    case 'bigText': return <BigText shot={shot} />;
    case 'wordFlash': return <WordFlash shot={shot} />;
    case 'splitText': return <SplitText shot={shot} />;
    case 'productShot': return <ProductShot shot={shot} />;
    case 'videoShot': return <VideoShot shot={shot} />;
    case 'uiShot': return <UIShot shot={shot} />;
    case 'metricShot': return <MetricShot shot={shot} />;
    case 'logoShot': return <LogoShot shot={shot} />;
  }
};

export const ShotRenderer: React.FC<{readonly shot: TimelineShot}> = ({shot}) => {
  const durationInFrames = beatsToFrames(shot.durationBeats);
  return (
    <Transition preset={shot.animation} durationInFrames={durationInFrames}>
      {renderShot(shot)}
    </Transition>
  );
};
