import {beatToFrame} from '../motion/config';
import {defineShot, defineSoundCue, validateTimeline} from '../motion/timeline';

export const DEMO_TIMELINE = [
  defineShot({
    id: 'opening-see', beat: 0, durationBeats: 2, type: 'bigText', text: '看见。', asset: null,
    animation: 'scale', background: 'black', layout: 'center',
  }),
  defineShot({
    id: 'opening-closer', beat: 2, durationBeats: 2, type: 'bigText', text: '再靠近一点。', asset: null,
    animation: 'match-left', background: 'white', layout: 'left',
  }),
  defineShot({
    id: 'inspection-words', beat: 4, durationBeats: 2, type: 'wordFlash',
    text: ['地面', '通道', '扶手', '照明'], asset: null, animation: 'cut', background: 'black', wordsPerBeat: 2,
  }),
  defineShot({
    id: 'product-arrival', beat: 6, durationBeats: 4, type: 'productShot', text: '',
    asset: 'assets/product/hero-iphone.png', animation: 'scale-out', background: 'black', eyebrow: '',
  }),
  defineShot({
    id: 'evidence-split', beat: 10, durationBeats: 2, type: 'splitText',
    text: ['一个画面', '一处依据'], asset: null, animation: 'match-up', background: 'white',
  }),
  defineShot({
    id: 'risk-ui', beat: 12, durationBeats: 4, type: 'uiShot', text: '风险，\n被标注。',
    asset: 'assets/ui/result-ui.png', animation: 'match-left', background: 'black', eyebrow: '画面证据',
    detail: '让需要留意的位置，不再藏在细节里。', layout: 'phone',
  }),
  defineShot({
    id: 'discovery-hit', beat: 16, durationBeats: 2, type: 'bigText', text: '发现。', asset: null,
    animation: 'scale', background: 'white', layout: 'center',
  }),
  defineShot({
    id: 'risk-metric', beat: 18, durationBeats: 4, type: 'metricShot', text: '需要留意', value: '2 处', asset: null,
    animation: 'slide-up', background: 'black', detail: '每一处提示，都保留对应的画面依据。',
  }),
  defineShot({
    id: 'solution-ui', beat: 22, durationBeats: 4, type: 'uiShot', text: '改造，\n现在开始。',
    asset: 'assets/ui/solutions-ui.png', animation: 'match-left', background: 'white', eyebrow: '推荐改造方案',
    detail: '从防滑到支撑，把分析变成可执行的下一步。', layout: 'phone',
  }),
  defineShot({
    id: 'brand-reveal', beat: 26, durationBeats: 6, type: 'logoShot', text: '长者友好家', asset: null,
    animation: 'scale-out', background: 'black', detail: '细微改造，步步心安',
  }),
] as const;

export const SOUND_CUES = [
  defineSoundCue({id: 'opening-impact', beat: 0, asset: null, volume: 0.72, label: '开场低频冲击'}),
  defineSoundCue({id: 'invert-snap', beat: 2, asset: null, volume: 0.54, label: '黑白翻转'}),
  defineSoundCue({id: 'word-ticks', beat: 4, asset: null, volume: 0.38, label: '单词逐拍 click'}),
  defineSoundCue({id: 'product-whoosh', beat: 6, asset: null, volume: 0.62, label: '产品入画 whoosh'}),
  defineSoundCue({id: 'risk-hit', beat: 16, asset: null, volume: 0.68, label: '风险定格 impact'}),
  defineSoundCue({id: 'logo-resolve', beat: 26, asset: null, volume: 0.58, label: 'Logo 收束音'}),
] as const;

validateTimeline(DEMO_TIMELINE);

export const DEMO_END_BEAT = Math.max(...DEMO_TIMELINE.map(shot => shot.beat + shot.durationBeats));
export const DEMO_DURATION_FRAMES = beatToFrame(DEMO_END_BEAT);
