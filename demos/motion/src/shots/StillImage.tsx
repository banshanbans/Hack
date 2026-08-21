import {useCallback, useEffect, useRef, useState} from 'react';
import type {CSSProperties} from 'react';
import {continueRender, delayRender, staticFile} from 'remotion';

interface StillImageProps {
  readonly asset: string;
  readonly style: CSSProperties;
}

export const StillImage: React.FC<StillImageProps> = ({asset, style}) => {
  const [handle] = useState(() => delayRender(`Loading ${asset}`));
  const finished = useRef(false);
  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    continueRender(handle);
  }, [handle]);

  useEffect(() => finish, [finish]);

  return <img src={staticFile(asset)} style={style} onLoad={finish} onError={finish} alt="" />;
};
