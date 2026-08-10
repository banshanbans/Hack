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

export const ONBOARDING_STORAGE_KEY = 'anju_onboarding_v2';
export const LEGACY_ONBOARDING_STORAGE_KEY = 'anju_onboarding_v1';
const ONBOARDING_VERSION = 2;

export type OnboardingStep = 1 | 2 | 3 | 4 | 5;
export type OnboardingPhase = 'home' | 'profile' | 'rooms' | 'capture' | 'analyze' | 'result' | 'risk' | 'solutions' | 'report';
export type OnboardingPhaseStatus = 'acknowledged' | 'skipped' | 'completed';

export interface OnboardingState {
  version: number;
  status: 'active' | 'completed';
  phase: OnboardingPhase;
  phase_status: Partial<Record<OnboardingPhase, OnboardingPhaseStatus>>;
}

const PHASES: OnboardingPhase[] = ['home', 'profile', 'rooms', 'capture', 'analyze', 'result', 'risk', 'solutions', 'report'];
const STEP_BY_PHASE: Record<OnboardingPhase, OnboardingStep> = {
  home: 1,
  profile: 2,
  rooms: 2,
  capture: 3,
  analyze: 3,
  result: 4,
  risk: 4,
  solutions: 5,
  report: 5,
};
const PHASES_BY_LEGACY_STEP: Record<OnboardingStep, OnboardingPhase[]> = {
  1: ['home'],
  2: ['profile', 'rooms'],
  3: ['capture', 'analyze'],
  4: ['result', 'risk'],
  5: ['solutions', 'report'],
};

export function defaultOnboardingState(): OnboardingState {
  return {version: ONBOARDING_VERSION, status: 'active', phase: 'home', phase_status: {}};
}

export function readOnboardingState(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): OnboardingState {
  if (!storage) return defaultOnboardingState();
  try {
    const parsed = JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) || 'null') as Partial<OnboardingState> | null;
    if (parsed?.version === ONBOARDING_VERSION && (parsed.status === 'active' || parsed.status === 'completed') && isPhase(parsed.phase)) {
      const phaseStatus = Object.fromEntries(Object.entries(parsed.phase_status || {}).filter(
        (entry): entry is [OnboardingPhase, OnboardingPhaseStatus] => isPhase(entry[0]) && isPhaseStatus(entry[1]),
      ));
      return {version: ONBOARDING_VERSION, status: parsed.status, phase: parsed.phase, phase_status: phaseStatus};
    }
    const legacy = JSON.parse(storage.getItem(LEGACY_ONBOARDING_STORAGE_KEY) || 'null') as {
      version?: number;
      status?: 'active' | 'completed';
      step?: number;
      phase?: OnboardingPhase;
      skipped_steps?: number[];
    } | null;
    if (!legacy || legacy.version !== 1 || (legacy.status !== 'active' && legacy.status !== 'completed')) return defaultOnboardingState();
    const legacyStep = [1, 2, 3, 4, 5].includes(Number(legacy.step)) ? Number(legacy.step) as OnboardingStep : 1;
    const phase = isPhase(legacy.phase) ? legacy.phase : PHASES_BY_LEGACY_STEP[legacyStep][0];
    const phaseStatus: Partial<Record<OnboardingPhase, OnboardingPhaseStatus>> = {};
    for (const item of legacy.skipped_steps || []) {
      if (![1, 2, 3, 4, 5].includes(item)) continue;
      for (const skippedPhase of PHASES_BY_LEGACY_STEP[item as OnboardingStep]) phaseStatus[skippedPhase] = 'skipped';
    }
    const phaseIndex = PHASES.indexOf(phase);
    for (const completedPhase of PHASES.slice(0, Math.max(0, phaseIndex))) {
      if (!phaseStatus[completedPhase]) phaseStatus[completedPhase] = 'completed';
    }
    if (legacy.status === 'completed') phaseStatus.report = 'completed';
    const migrated: OnboardingState = {version: ONBOARDING_VERSION, status: legacy.status, phase, phase_status: phaseStatus};
    writeOnboardingState(migrated, storage);
    storage.removeItem(LEGACY_ONBOARDING_STORAGE_KEY);
    return migrated;
  } catch {
    return defaultOnboardingState();
  }
}

function isPhase(value: unknown): value is OnboardingPhase {
  return typeof value === 'string' && PHASES.includes(value as OnboardingPhase);
}

function isPhaseStatus(value: unknown): value is OnboardingPhaseStatus {
  return value === 'acknowledged' || value === 'skipped' || value === 'completed';
}

function writeOnboardingState(value: OnboardingState, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage) {
  storage?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(value));
}

interface OnboardingContextValue {
  state: OnboardingState;
  active: boolean;
  enterPhase: (phase: OnboardingPhase) => void;
  completePhase: (phase: OnboardingPhase, nextPhase?: OnboardingPhase) => void;
  acknowledgePhase: (phase: OnboardingPhase) => void;
  skipPhase: (phase: OnboardingPhase) => void;
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
  const enterPhase = useCallback((phase: OnboardingPhase) => {
    update(current => current.status === 'active' ? {...current, phase} : current);
  }, [update]);
  const completePhase = useCallback((phase: OnboardingPhase, nextPhase = phase) => {
    update(current => current.status === 'active' ? {
      ...current,
      phase: nextPhase,
      phase_status: {...current.phase_status, [phase]: 'completed'},
    } : current);
  }, [update]);
  const acknowledgePhase = useCallback((phase: OnboardingPhase) => {
    update(current => current.status === 'active' ? {
      ...current,
      phase,
      phase_status: {...current.phase_status, [phase]: 'acknowledged'},
    } : current);
  }, [update]);
  const skipPhase = useCallback((phase: OnboardingPhase) => {
    update(current => current.status === 'active' ? {
      ...current,
      status: phase === 'report' ? 'completed' : current.status,
      phase,
      phase_status: {...current.phase_status, [phase]: 'skipped'},
    } : current);
  }, [update]);
  const complete = useCallback(() => update(current => ({
    ...current,
    status: 'completed',
    phase: 'report',
    phase_status: {...current.phase_status, report: 'completed'},
  })), [update]);
  const restart = useCallback(() => {
    const next = defaultOnboardingState();
    writeOnboardingState(next);
    setState(next);
  }, []);
  const value = useMemo<OnboardingContextValue>(() => ({
    state,
    active: state.status === 'active',
    enterPhase,
    completePhase,
    acknowledgePhase,
    skipPhase,
    complete,
    restart,
  }), [acknowledgePhase, complete, completePhase, enterPhase, restart, skipPhase, state]);
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
  phase: OnboardingPhase;
  title: string;
  body: string;
  targets: TargetDefinition[];
  complete?: boolean;
}

function definitionFor(state: OnboardingState, pathname: string): OverlayDefinition | null {
  if (state.status !== 'active') return null;
  let phase: OnboardingPhase | null = null;
  if (pathname === '/home') phase = 'home';
  else if (pathname === '/profile') phase = 'profile';
  else if (pathname === '/rooms') phase = 'rooms';
  else if (pathname.startsWith('/upload/')) phase = state.phase === 'analyze' ? 'analyze' : 'capture';
  else if (pathname.startsWith('/result/')) phase = 'result';
  else if (pathname.startsWith('/risk/')) phase = 'risk';
  else if (pathname.startsWith('/solutions/')) phase = 'solutions';
  else if (pathname === '/report') phase = 'report';
  if (!phase || state.phase_status[phase]) return null;
  const step = STEP_BY_PHASE[phase];
  if (phase === 'home') return {...ONBOARDING_COPY.steps.start, phase, step, targets: [{name: 'home-ar-entry'}, {name: 'home-photo-entry'}]};
  if (phase === 'profile') return {...ONBOARDING_COPY.steps.profile, phase, step, targets: [{name: 'profile-form'}, {name: 'profile-save'}]};
  if (phase === 'rooms') return {...ONBOARDING_COPY.steps.rooms, phase, step, targets: [{name: 'room-selection'}]};
  if (phase === 'capture') return {...ONBOARDING_COPY.steps.capture, phase, step, targets: [{name: 'capture-source'}]};
  if (phase === 'analyze') return {...ONBOARDING_COPY.steps.analyze, phase, step, targets: [{name: 'capture-analyze'}]};
  if (phase === 'result') return {...ONBOARDING_COPY.steps.result, phase, step, targets: [{name: 'result-overview'}, {name: 'result-risks', optional: true}, {name: 'result-report', optional: true}]};
  if (phase === 'risk') return {...ONBOARDING_COPY.steps.risk, phase, step, targets: [{name: 'risk-solution'}]};
  if (phase === 'solutions') return {...ONBOARDING_COPY.steps.solutions, phase, step, targets: [{name: 'solution-options'}, {name: 'solutions-report', optional: true}]};
  if (phase === 'report') return {...ONBOARDING_COPY.steps.report, phase, step, targets: [{name: 'report-summary'}, {name: 'report-actions', optional: true}], complete: true};
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
  const {state, acknowledgePhase, skipPhase, complete} = useOnboarding();
  const rawDefinition = useMemo(() => definitionFor(state, location.pathname), [location.pathname, state.phase, state.phase_status, state.status]);
  const definition = rawDefinition;
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
      if (event.key === 'Escape') { event.preventDefault(); skipPhase(definition.phase); }
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
  }, [definition, ready, skipPhase]);

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
  const maskId = `onboarding-mask-${definition.step}-${definition.phase}`;
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
        <button type="button" className="button quiet" onClick={() => skipPhase(definition.phase)}>跳过本步</button>
        {definition.complete
          ? <button type="button" className="button primary" onClick={complete}>完成引导</button>
          : <button type="button" className="button primary" onClick={() => acknowledgePhase(definition.phase)}>知道了，继续操作</button>}
      </div>
    </section>
  </div>;
}
