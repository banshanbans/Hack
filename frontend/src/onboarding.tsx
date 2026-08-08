import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {useLocation} from 'react-router-dom';
import {ONBOARDING_COPY} from './content';

export const ONBOARDING_STORAGE_KEY = 'anju_onboarding_v1';
const ONBOARDING_VERSION = 1;

export type OnboardingStep = 1 | 2 | 3 | 4 | 5;
export type OnboardingPhase = 'home' | 'profile' | 'rooms' | 'capture' | 'analyze' | 'result' | 'risk' | 'solutions' | 'report';

export interface OnboardingState {
  version: number;
  status: 'active' | 'completed';
  step: OnboardingStep;
  phase: OnboardingPhase;
  skipped_steps: OnboardingStep[];
}

const DEFAULT_PHASES: Record<OnboardingStep, OnboardingPhase> = {
  1: 'home',
  2: 'profile',
  3: 'capture',
  4: 'result',
  5: 'solutions',
};

export function defaultOnboardingState(): OnboardingState {
  return {version: ONBOARDING_VERSION, status: 'active', step: 1, phase: 'home', skipped_steps: []};
}

export function readOnboardingState(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): OnboardingState {
  if (!storage) return defaultOnboardingState();
  try {
    const parsed = JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) || 'null') as Partial<OnboardingState> | null;
    if (!parsed || parsed.version !== ONBOARDING_VERSION || (parsed.status !== 'active' && parsed.status !== 'completed')) return defaultOnboardingState();
    const step = Number(parsed.step);
    if (![1, 2, 3, 4, 5].includes(step)) return defaultOnboardingState();
    return {
      version: ONBOARDING_VERSION,
      status: parsed.status,
      step: step as OnboardingStep,
      phase: parsed.phase || DEFAULT_PHASES[step as OnboardingStep],
      skipped_steps: Array.isArray(parsed.skipped_steps)
        ? parsed.skipped_steps.filter((value): value is OnboardingStep => [1, 2, 3, 4, 5].includes(value))
        : [],
    };
  } catch {
    return defaultOnboardingState();
  }
}

function writeOnboardingState(value: OnboardingState, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage) {
  storage?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(value));
}

interface OnboardingContextValue {
  state: OnboardingState;
  active: boolean;
  moveTo: (step: OnboardingStep, phase?: OnboardingPhase) => void;
  setPhase: (phase: OnboardingPhase) => void;
  skipCurrent: () => void;
  complete: () => void;
  restart: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({children}: {children: ReactNode}) {
  const [state, setState] = useState(readOnboardingState);
  const update = useCallback((factory: (current: OnboardingState) => OnboardingState) => {
    setState(current => {
      const next = factory(current);
      writeOnboardingState(next);
      return next;
    });
  }, []);
  const moveTo = useCallback((step: OnboardingStep, phase = DEFAULT_PHASES[step]) => {
    update(current => current.status === 'active' ? {...current, step, phase} : current);
  }, [update]);
  const setPhase = useCallback((phase: OnboardingPhase) => {
    update(current => current.status === 'active' ? {...current, phase} : current);
  }, [update]);
  const skipCurrent = useCallback(() => {
    update(current => {
      if (current.status !== 'active') return current;
      const skipped = current.skipped_steps.includes(current.step) ? current.skipped_steps : [...current.skipped_steps, current.step];
      if (current.step === 5) return {...current, status: 'completed', skipped_steps: skipped};
      const step = (current.step + 1) as OnboardingStep;
      return {...current, step, phase: DEFAULT_PHASES[step], skipped_steps: skipped};
    });
  }, [update]);
  const complete = useCallback(() => update(current => ({...current, status: 'completed', step: 5, phase: 'report'})), [update]);
  const restart = useCallback(() => {
    const next = defaultOnboardingState();
    writeOnboardingState(next);
    setState(next);
  }, []);
  const value = useMemo<OnboardingContextValue>(() => ({
    state,
    active: state.status === 'active',
    moveTo,
    setPhase,
    skipCurrent,
    complete,
    restart,
  }), [complete, moveTo, restart, setPhase, skipCurrent, state]);
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingContextValue {
  const value = useContext(OnboardingContext);
  if (!value) throw new Error('OnboardingProvider is required');
  return value;
}

interface TargetDefinition {name: string; optional?: boolean}
interface OverlayDefinition {
  step: OnboardingStep;
  title: string;
  body: string;
  targets: TargetDefinition[];
  complete?: boolean;
}

function definitionFor(state: OnboardingState, pathname: string): OverlayDefinition | null {
  if (state.status !== 'active') return null;
  if (state.step === 1 && pathname === '/home') return {...ONBOARDING_COPY.steps.start, step: 1, targets: [{name: 'home-start'}]};
  if (state.step === 2 && pathname === '/profile') return {...ONBOARDING_COPY.steps.profile, step: 2, targets: [{name: 'profile-form'}, {name: 'profile-save'}]};
  if (state.step === 2 && pathname === '/rooms') return {...ONBOARDING_COPY.steps.rooms, step: 2, targets: [{name: 'room-selection'}]};
  if (state.step === 3 && state.phase === 'capture' && pathname.startsWith('/upload/')) return {...ONBOARDING_COPY.steps.capture, step: 3, targets: [{name: 'capture-source'}, {name: 'central-camera', optional: true}]};
  if (state.step === 3 && state.phase === 'analyze' && pathname.startsWith('/upload/')) return {...ONBOARDING_COPY.steps.analyze, step: 3, targets: [{name: 'capture-analyze'}]};
  if (state.step === 4 && pathname.startsWith('/result/')) return {...ONBOARDING_COPY.steps.result, step: 4, targets: [{name: 'result-overview'}, {name: 'result-risks', optional: true}, {name: 'result-report', optional: true}]};
  if (state.step === 4 && pathname.startsWith('/risk/')) return {...ONBOARDING_COPY.steps.risk, step: 4, targets: [{name: 'risk-solution'}]};
  if (state.step === 5 && pathname.startsWith('/solutions/')) return {...ONBOARDING_COPY.steps.solutions, step: 5, targets: [{name: 'solution-options'}, {name: 'solutions-report', optional: true}]};
  if (state.step === 5 && pathname === '/report') return {...ONBOARDING_COPY.steps.report, step: 5, targets: [{name: 'report-summary'}, {name: 'report-actions', optional: true}], complete: true};
  return null;
}

interface TargetRect {x: number; y: number; width: number; height: number; radius: number}

function roundedRectPath({x, y, width, height, radius}: TargetRect): string {
  const right = x + width;
  const bottom = y + height;
  const r = Math.min(radius, width / 2, height / 2);
  return `M ${x + r} ${y} H ${right - r} A ${r} ${r} 0 0 1 ${right} ${y + r} V ${bottom - r} A ${r} ${r} 0 0 1 ${right - r} ${bottom} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${bottom - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

export function OnboardingOverlay() {
  const location = useLocation();
  const {state, skipCurrent, complete} = useOnboarding();
  const definition = useMemo(() => definitionFor(state, location.pathname), [location.pathname, state.phase, state.status, state.step]);
  const [rects, setRects] = useState<TargetRect[]>([]);
  const [ready, setReady] = useState(false);
  const [obscured, setObscured] = useState(false);
  const [cardTop, setCardTop] = useState<number | null>(null);
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const update = () => setObscured(Boolean(document.querySelector('.modal-backdrop, .camera-advisor-sheet-backdrop')));
    const observer = new MutationObserver(update);
    observer.observe(document.body, {childList: true, subtree: true});
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!definition) { setRects([]); setReady(false); return; }
    let disposed = false;
    let fallbackTimer = 0;
    const observed = new Set<Element>();
    const resizeObserver = new ResizeObserver(() => measure());
    const measure = () => {
      if (disposed) return;
      const next: TargetRect[] = [];
      let requiredMissing = false;
      for (const target of definition.targets) {
        const elements = [...document.querySelectorAll<HTMLElement>(`[data-onboarding-target="${target.name}"]`)];
        if (!elements.length) {
          if (!target.optional) requiredMissing = true;
          continue;
        }
        let hasVisibleElement = false;
        for (const element of elements) {
          if (!observed.has(element)) { observed.add(element); resizeObserver.observe(element); }
          const bounds = element.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) continue;
          hasVisibleElement = true;
          const padding = 8;
          const x = Math.max(4, bounds.left - padding);
          const y = Math.max(4, bounds.top - padding);
          next.push({
            x,
            y,
            width: Math.max(1, Math.min(window.innerWidth - x - 4, bounds.width + padding * 2)),
            height: Math.max(1, Math.min(window.innerHeight - y - 4, bounds.height + padding * 2)),
            radius: 18,
          });
        }
        if (!hasVisibleElement && !target.optional) requiredMissing = true;
      }
      setRects(current => current.length === next.length && current.every((rect, index) => (
        Math.abs(rect.x - next[index].x) < .5
        && Math.abs(rect.y - next[index].y) < .5
        && Math.abs(rect.width - next[index].width) < .5
        && Math.abs(rect.height - next[index].height) < .5
      )) ? current : next);
      if (!requiredMissing) setReady(true);
    };
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(document.body, {childList: true, subtree: true, attributes: true});
    const viewport = window.visualViewport;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    const frame = window.requestAnimationFrame(measure);
    fallbackTimer = window.setTimeout(() => setReady(true), 1_200);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(fallbackTimer);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
    };
  }, [definition?.step, state.phase, location.pathname]);

  useEffect(() => {
    if (!definition || !ready) return;
    cardRef.current?.focus({preventScroll: true});
    const focusable = () => {
      const targetNodes = definition.targets.flatMap(target => [...document.querySelectorAll<HTMLElement>(`[data-onboarding-target="${target.name}"]`)]);
      const candidates = targetNodes.flatMap(node => {
        const nested = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')];
        return node.matches('button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])') ? [node, ...nested] : nested;
      });
      return [...new Set([...candidates, ...[...(cardRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || [])]])];
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); skipCurrent(); }
      if (event.key === 'Tab') {
        const candidates = focusable();
        if (!candidates.length) return;
        event.preventDefault();
        const index = candidates.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? candidates[(index <= 0 ? candidates.length : index) - 1]
          : candidates[(index + 1) % candidates.length];
        next?.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      const allowed = cardRef.current?.contains(target) || definition.targets.some(item => [...document.querySelectorAll(`[data-onboarding-target="${item.name}"]`)].some(node => node.contains(target)));
      if (!allowed) cardRef.current?.focus({preventScroll: true});
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [definition, ready, skipCurrent]);

  useEffect(() => {
    if (!definition || !ready || obscured) return;
    const place = () => {
      const card = cardRef.current;
      if (!card) return;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const margin = 12;
      const intervals = rects
        .map(rect => [Math.max(margin, rect.y), Math.min(viewportHeight - margin, rect.y + rect.height)] as [number, number])
        .filter(([start, end]) => end > start)
        .sort((left, right) => left[0] - right[0]);
      const merged: Array<[number, number]> = [];
      for (const interval of intervals) {
        const previous = merged.at(-1);
        if (previous && interval[0] <= previous[1] + 8) previous[1] = Math.max(previous[1], interval[1]);
        else merged.push([...interval]);
      }
      const gaps: Array<[number, number]> = [];
      let cursor = margin;
      for (const [start, end] of merged) {
        if (start > cursor) gaps.push([cursor, start]);
        cursor = Math.max(cursor, end);
      }
      if (cursor < viewportHeight - margin) gaps.push([cursor, viewportHeight - margin]);
      const cardHeight = card.offsetHeight;
      const best = gaps.sort((left, right) => (right[1] - right[0]) - (left[1] - left[0]))[0] || [margin, viewportHeight - margin];
      const available = best[1] - best[0];
      const top = available >= cardHeight + 16
        ? best[0] + (available - cardHeight) / 2
        : Math.max(margin, Math.min(best[0] + 8, viewportHeight - cardHeight - margin));
      setCardTop(Math.round(top));
    };
    const frame = window.requestAnimationFrame(place);
    const observer = new ResizeObserver(place);
    if (cardRef.current) observer.observe(cardRef.current);
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [definition, obscured, ready, rects]);

  if (!definition || !ready || obscured) return null;
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const maskId = `onboarding-mask-${definition.step}-${state.phase}`;
  const blockerPath = [`M 0 0 H ${width} V ${height} H 0 Z`, ...rects.map(roundedRectPath)].join(' ');
  return <div className="onboarding-layer" aria-live="polite">
    <svg className="onboarding-mask" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs><mask id={maskId}><rect width={width} height={height} fill="white" />{rects.map((rect, index) => <rect key={index} x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={rect.radius} fill="black" />)}</mask></defs>
      <rect width={width} height={height} className="onboarding-dim" mask={`url(#${maskId})`} />
      <path d={blockerPath} fillRule="evenodd" className="onboarding-blocker" />
      {rects.map((rect, index) => <rect key={index} x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={rect.radius} className="onboarding-outline" />)}
    </svg>
    <section ref={cardRef} className="onboarding-card" style={cardTop === null ? undefined : {top: cardTop, bottom: 'auto'}} role="dialog" aria-modal="false" aria-labelledby="onboarding-title" aria-describedby="onboarding-description" tabIndex={-1}>
      <div className="onboarding-progress"><span>新手引导</span><strong>第 {definition.step} / 5 步</strong></div>
      <h2 id="onboarding-title">{definition.title}</h2>
      <p id="onboarding-description">{definition.body}</p>
      {!rects.length && <p className="onboarding-fallback" role="status">当前页面还没有可指引的操作，可以稍后再试或跳过本步。</p>}
      <div className="onboarding-actions">
        <button type="button" className="button quiet" onClick={skipCurrent}>{definition.complete ? '稍后再看' : '跳过这一步'}</button>
        {definition.complete && <button type="button" className="button primary" onClick={complete}>完成引导</button>}
      </div>
    </section>
  </div>;
}
