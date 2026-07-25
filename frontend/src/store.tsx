import {createContext, useCallback, useContext, useMemo, useReducer, useState, type ReactNode} from 'react';
import type {Assessment, RoomResult, SessionState} from './types';

const STORAGE_KEY = 'anju_h5_session_v2';

export function readSession(storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): SessionState | null {
  if (!storage) return null;
  try {
    return JSON.parse(storage.getItem(STORAGE_KEY) || 'null') as SessionState | null;
  } catch {
    return null;
  }
}

export function writeSession(session: SessionState | null, storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  if (!storage) return;
  if (session) storage.setItem(STORAGE_KEY, JSON.stringify(session));
  else storage.removeItem(STORAGE_KEY);
}

interface AppState {
  session: SessionState | null;
  assessment: Assessment | null;
  roomResult: RoomResult | null;
  health: string;
}

type Action =
  | {type: 'session'; value: SessionState | null}
  | {type: 'assessment'; value: Assessment | null}
  | {type: 'roomResult'; value: RoomResult | null}
  | {type: 'health'; value: string};

function reducer(state: AppState, action: Action): AppState {
  return {...state, [action.type]: action.value};
}

interface AppContextValue extends AppState {
  setSession: (value: SessionState | null) => void;
  setAssessment: (value: Assessment | null) => void;
  setRoomResult: (value: RoomResult | null) => void;
  setHealth: (value: string) => void;
  toast: string | null;
  showToast: (value: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({children}: {children: ReactNode}) {
  const [state, dispatch] = useReducer(reducer, {session: readSession(), assessment: null, roomResult: null, health: 'loading'});
  const [toast, setToast] = useState<string | null>(null);
  const setSession = useCallback((value: SessionState | null) => {
    writeSession(value);
    dispatch({type: 'session', value});
  }, []);
  const setAssessment = useCallback((value: Assessment | null) => dispatch({type: 'assessment', value}), []);
  const setRoomResult = useCallback((value: RoomResult | null) => dispatch({type: 'roomResult', value}), []);
  const setHealth = useCallback((value: string) => dispatch({type: 'health', value}), []);
  const showToast = useCallback((value: string) => {
    setToast(value);
    window.setTimeout(() => setToast(current => current === value ? null : current), 2800);
  }, []);
  const value = useMemo<AppContextValue>(() => ({
    ...state,
    setSession,
    setAssessment,
    setRoomResult,
    setHealth,
    toast,
    showToast,
  }), [setAssessment, setHealth, setRoomResult, setSession, showToast, state, toast]);
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
