import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  advisorClientInstanceId,
  clearAdvisorRTCTicket,
  readAdvisorRTCTicket,
  saveAdvisorRTCTicket,
} from '../advisorQueue';

describe('advisor RTC queue storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useRealTimers();
  });

  it('keeps one client instance across refreshes in the same tab', () => {
    const first = advisorClientInstanceId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(advisorClientInstanceId()).toBe(first);
  });

  it('restores a granted ticket and drops it after the grant expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T10:00:00Z'));
    saveAdvisorRTCTicket('room-1', 'session-1', advisorClientInstanceId(), 'audio_video', {
      ticket_id: 'ticket-1',
      status: 'granted',
      position: 0,
      expires_at: '2026-08-08T10:00:20Z',
      poll_after_ms: 2_000,
      mode: 'audio_video',
    });

    expect(readAdvisorRTCTicket('room-1', 'audio_video')?.ticket_id).toBe('ticket-1');
    vi.setSystemTime(new Date('2026-08-08T10:00:21Z'));
    expect(readAdvisorRTCTicket('room-1', 'audio_video')).toBeNull();
  });

  it('isolates audio and video tickets for a room', () => {
    const client = advisorClientInstanceId();
    saveAdvisorRTCTicket('room-1', 'session-1', client, 'audio', {
      ticket_id: 'audio-ticket', status: 'queued', position: 1,
      expires_at: '2099-01-01T00:00:00Z', poll_after_ms: 2_000, mode: 'audio',
    });
    saveAdvisorRTCTicket('room-1', 'session-1', client, 'audio_video', {
      ticket_id: 'video-ticket', status: 'queued', position: 2,
      expires_at: '2099-01-01T00:00:00Z', poll_after_ms: 2_000, mode: 'audio_video',
    });

    clearAdvisorRTCTicket('room-1', 'audio');
    expect(readAdvisorRTCTicket('room-1', 'audio')).toBeNull();
    expect(readAdvisorRTCTicket('room-1', 'audio_video')?.ticket_id).toBe('video-ticket');
  });
});
