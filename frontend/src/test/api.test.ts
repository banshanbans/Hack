import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {api, friendlyError} from '../api';
import {SESSION_INVALIDATED_EVENT} from '../store';

describe('API session recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'stale', access_token: 'old-token'}));
  });

  afterEach(() => vi.restoreAllMocks());

  it('clears and announces an expired assessment session', async () => {
    const invalidated = vi.fn();
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidated, {once: true});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: 'assessment_access_denied',
      message: '没有找到这次检查或访问已失效',
    }), {status: 404, headers: {'Content-Type': 'application/json'}}));

    await expect(api.getAssessment()).rejects.toMatchObject({code: 'assessment_access_denied', status: 404});
    expect(localStorage.getItem('anju_h5_session_v2')).toBeNull();
    expect(invalidated).toHaveBeenCalledOnce();
  });

  it('uses a retryable message when the shared Turbo lane is full', () => {
    expect(friendlyError({code: 'provider_capacity_busy', message: 'internal'})).toBe('当前实时检查较多，正在等待下一次画面');
  });
});
