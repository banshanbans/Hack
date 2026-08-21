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

  it('drops only an expired historical credential without invalidating the active assessment', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'active', access_token: 'active-token'}));
    localStorage.setItem('anju_h5_assessment_history_v1', JSON.stringify([
      {assessment_id: 'active', access_token: 'active-token', created_at: '2026-08-10T00:00:00Z', last_opened_at: '2026-08-10T00:00:00Z'},
      {assessment_id: 'stale', access_token: 'old-token', created_at: '2026-08-09T00:00:00Z', last_opened_at: '2026-08-09T00:00:00Z'},
    ]));
    const invalidated = vi.fn();
    window.addEventListener(SESSION_INVALIDATED_EVENT, invalidated, {once: true});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({code: 'assessment_access_denied', message: '失效'}), {status: 404, headers: {'Content-Type': 'application/json'}}));

    await expect(api.getAssessmentFor({assessment_id: 'stale', access_token: 'old-token'})).rejects.toMatchObject({code: 'assessment_access_denied'});
    expect(JSON.parse(localStorage.getItem('anju_h5_session_v2') || '{}')).toMatchObject({assessment_id: 'active'});
    expect(JSON.parse(localStorage.getItem('anju_h5_assessment_history_v1') || '[]')).toHaveLength(1);
    expect(invalidated).not.toHaveBeenCalled();
    window.removeEventListener(SESSION_INVALIDATED_EVENT, invalidated);
  });

  it('uses authenticated room-level renovation preview contracts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({preview_id: 'preview-1'}));
    await api.createRenovationPreview('room-1', 'media-1');
    const [path, options] = fetchMock.mock.calls[0];
    expect(String(path)).toContain('/rooms/room-1/renovation-previews');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({source_media_id: 'media-1'});
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer old-token');
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}});
}
