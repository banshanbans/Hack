import {api} from './api';
import type {AdvisorEventConfig} from './types';

const RETRY_SECONDS = [1, 2, 4, 8, 15] as const;

export function subscribeAdvisorEvents(options: {
  roomId: string;
  sessionId: string;
  initial: AdvisorEventConfig;
  onMessage: (event: MessageEvent) => void;
}): () => void {
  let stopped = false;
  let connecting = false;
  let usedInitial = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const schedule = () => {
    if (stopped || document.visibilityState !== 'visible' || retryTimer !== null) return;
    const seconds = RETRY_SECONDS[Math.min(attempt, RETRY_SECONDS.length - 1)];
    void api.analytics('advisor_events_reconnecting', options.roomId, {attempt: attempt + 1}).catch(() => undefined);
    attempt += 1;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void connect(true);
    }, seconds * 1_000);
  };

  const connect = async (refresh: boolean) => {
    if (stopped || connecting || socket || document.visibilityState !== 'visible') return;
    connecting = true;
    try {
      const events = refresh || usedInitial
        ? await api.issueAdvisorEventToken(options.roomId, options.sessionId)
        : options.initial;
      usedInitial = true;
      if (stopped || document.visibilityState !== 'visible') return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const current = new WebSocket(`${protocol}//${window.location.host}${events.websocket_path}?token=${encodeURIComponent(events.token)}`);
      socket = current;
      current.onmessage = event => {
        try {
          if (JSON.parse(String(event.data))?.type === 'ready') attempt = 0;
        } catch { /* Invalid events are ignored by the consumer. */ }
        options.onMessage(event);
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (socket === current) socket = null;
        schedule();
      };
    } catch {
      schedule();
    } finally {
      connecting = false;
    }
  };

  const visibility = () => {
    if (document.visibilityState !== 'visible') {
      clearRetry();
      const current = socket;
      socket = null;
      current?.close();
    } else if (!socket) {
      void connect(true);
    }
  };
  document.addEventListener('visibilitychange', visibility);
  void connect(false);
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', visibility);
    clearRetry();
    const current = socket;
    socket = null;
    current?.close();
  };
}
