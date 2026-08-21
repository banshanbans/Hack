import {createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode} from 'react';
import type {Assessment, AssessmentHistoryEntry, ElderProfile, RoomResult, ServerCapabilities, SessionState} from './types';

const STORAGE_KEY = 'anju_h5_session_v2';
const HISTORY_STORAGE_KEY = 'anju_h5_assessment_history_v1';
const DEFAULT_PROFILE_STORAGE_KEY = 'anju_h5_default_profile_v1';
export const SESSION_INVALIDATED_EVENT = 'anju-session-invalidated';

function validSession(value: unknown): value is SessionState {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SessionState>;
  return typeof item.assessment_id === 'string' && Boolean(item.assessment_id)
    && typeof item.access_token === 'string' && Boolean(item.access_token);
}

function validProfile(value: unknown): value is ElderProfile {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ElderProfile>;
  return ['normal', 'limited', 'cane', 'walker', 'wheelchair'].includes(String(item.mobility))
    && ['none', 'once', 'multiple'].includes(String(item.fall_history))
    && ['alone', 'with_family'].includes(String(item.living_status));
}

export function readSession(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): SessionState | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    return validSession(value) ? value : null;
  } catch {
    return null;
  }
}

export function readAssessmentHistory(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): AssessmentHistoryEntry[] {
  if (!storage) return [];
  let history: AssessmentHistoryEntry[] = [];
  try {
    const parsed = JSON.parse(storage.getItem(HISTORY_STORAGE_KEY) || '[]');
    if (Array.isArray(parsed)) history = parsed.filter(validSession).map(item => {
      const value = item as Partial<AssessmentHistoryEntry> & SessionState;
      const fallback = new Date(0).toISOString();
      return {...value, created_at: value.created_at || fallback, last_opened_at: value.last_opened_at || value.created_at || fallback};
    });
  } catch { /* A malformed local index must not block the current assessment. */ }
  const current = readSession(storage);
  if (current && !history.some(item => item.assessment_id === current.assessment_id)) {
    const now = new Date().toISOString();
    history.unshift({...current, created_at: now, last_opened_at: now});
    storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  }
  return history.sort((left, right) => right.last_opened_at.localeCompare(left.last_opened_at));
}

export function writeAssessmentHistory(history: AssessmentHistoryEntry[], storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  if (!storage) return;
  storage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  window.dispatchEvent(new Event('anju-assessment-history-changed'));
}

export function rememberAssessment(session: SessionState, createdAt?: string, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  if (!storage) return;
  const history = readAssessmentHistory(storage);
  const previous = history.find(item => item.assessment_id === session.assessment_id);
  const now = new Date().toISOString();
  const entry: AssessmentHistoryEntry = {
    ...previous,
    ...session,
    created_at: createdAt || previous?.created_at || now,
    last_opened_at: now,
  };
  writeAssessmentHistory([entry, ...history.filter(item => item.assessment_id !== entry.assessment_id)], storage);
}

export function removeAssessmentHistory(assessmentId: string, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): AssessmentHistoryEntry[] {
  const history = readAssessmentHistory(storage).filter(item => item.assessment_id !== assessmentId);
  writeAssessmentHistory(history, storage);
  return history;
}

export function readDefaultProfile(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): ElderProfile | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(DEFAULT_PROFILE_STORAGE_KEY) || 'null');
    return validProfile(value) ? value : null;
  } catch { return null; }
}

export function writeDefaultProfile(profile: ElderProfile | null, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  if (!storage) return;
  if (profile) storage.setItem(DEFAULT_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  else storage.removeItem(DEFAULT_PROFILE_STORAGE_KEY);
}

export function writeSession(session: SessionState | null, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  if (!storage) return;
  if (session) {
    storage.setItem(STORAGE_KEY, JSON.stringify(session));
    rememberAssessment(session, undefined, storage);
  }
  else storage.removeItem(STORAGE_KEY);
}

interface AppState {
  session: SessionState | null;
  assessment: Assessment | null;
  roomResult: RoomResult | null;
  health: string;
  capabilities: ServerCapabilities | null;
}

type Action =
  | {type: 'session'; value: SessionState | null}
  | {type: 'assessment'; value: Assessment | null}
  | {type: 'roomResult'; value: RoomResult | null}
  | {type: 'health'; value: string}
  | {type: 'capabilities'; value: ServerCapabilities | null};

function reducer(state: AppState, action: Action): AppState {
  return {...state, [action.type]: action.value};
}

interface AppContextValue extends AppState {
  setSession: (value: SessionState | null) => void;
  setAssessment: (value: Assessment | null) => void;
  setRoomResult: (value: RoomResult | null) => void;
  setHealth: (value: string) => void;
  setCapabilities: (value: ServerCapabilities | null) => void;
  toast: string | null;
  showToast: (value: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({children}: {children: ReactNode}) {
  const [state, dispatch] = useReducer(reducer, {session: readSession(), assessment: null, roomResult: null, health: 'loading', capabilities: null});
  const [toast, setToast] = useState<string | null>(null);
  const setSession = useCallback((value: SessionState | null) => {
    writeSession(value);
    dispatch({type: 'session', value});
  }, []);
  const setAssessment = useCallback((value: Assessment | null) => dispatch({type: 'assessment', value}), []);
  const setRoomResult = useCallback((value: RoomResult | null) => dispatch({type: 'roomResult', value}), []);
  const setHealth = useCallback((value: string) => dispatch({type: 'health', value}), []);
  const setCapabilities = useCallback((value: ServerCapabilities | null) => dispatch({type: 'capabilities', value}), []);
  const showToast = useCallback((value: string) => {
    setToast(value);
    window.setTimeout(() => setToast(current => current === value ? null : current), 2800);
  }, []);
  useEffect(() => {
    const invalidate = () => {
      dispatch({type: 'session', value: null});
      dispatch({type: 'assessment', value: null});
      dispatch({type: 'roomResult', value: null});
    };
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidate);
    return () => window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidate);
  }, []);
  const value = useMemo<AppContextValue>(() => ({
    ...state,
    setSession,
    setAssessment,
    setRoomResult,
    setHealth,
    setCapabilities,
    toast,
    showToast,
  }), [setAssessment, setCapabilities, setHealth, setRoomResult, setSession, showToast, state, toast]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppProvider is required');
  return value;
}

export function formatMoney(fen: number | null | undefined, currency = 'CNY'): string {
  if (fen == null) return '需现场询价';
  return new Intl.NumberFormat('zh-CN', {style: 'currency', currency, maximumFractionDigits: 0}).format(fen / 100);
}

export function formatRange(min: number | null | undefined, max: number | null | undefined, currency = 'CNY'): string {
  if (min == null || max == null) return '需现场询价';
  return `${formatMoney(min, currency)}—${formatMoney(max, currency)}`;
}
