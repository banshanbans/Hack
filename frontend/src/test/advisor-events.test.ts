import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {api} from '../api';
import {subscribeAdvisorEvents} from '../advisorEvents';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  message(value: unknown) {
    this.onmessage?.({data: JSON.stringify(value)} as MessageEvent);
  }
}

describe('advisor event reconnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reissues a one-time token, reconnects with backoff and resets after ready', async () => {
    const issue = vi.spyOn(api, 'issueAdvisorEventToken')
      .mockResolvedValueOnce({websocket_path: '/events', token: 'fresh-1', expires_at: '2026-08-09T00:02:00Z'})
      .mockResolvedValueOnce({websocket_path: '/events', token: 'fresh-2', expires_at: '2026-08-09T00:04:00Z'});
    const onMessage = vi.fn();
    const unsubscribe = subscribeAdvisorEvents({
      roomId: 'room-1', sessionId: 'advisor-1',
      initial: {websocket_path: '/events', token: 'initial', expires_at: '2026-08-09T00:00:00Z'},
      onMessage,
    });
    await Promise.resolve();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain('token=initial');
    FakeWebSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(999);
    expect(issue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances[1].url).toContain('token=fresh-1');

    FakeWebSocket.instances[1].message({type: 'ready'});
    expect(onMessage).toHaveBeenCalledTimes(1);
    FakeWebSocket.instances[1].close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[2].url).toContain('token=fresh-2');

    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('closes while hidden and only refreshes after the page becomes visible', async () => {
    const issue = vi.spyOn(api, 'issueAdvisorEventToken').mockResolvedValue({
      websocket_path: '/events', token: 'visible-token', expires_at: '2026-08-09T00:02:00Z',
    });
    const unsubscribe = subscribeAdvisorEvents({
      roomId: 'room-1', sessionId: 'advisor-1',
      initial: {websocket_path: '/events', token: 'initial', expires_at: '2026-08-09T00:00:00Z'},
      onMessage: vi.fn(),
    });
    await Promise.resolve();
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(issue).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances[1].url).toContain('token=visible-token');
    unsubscribe();
  });
});
