import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  isNativeCaptureResult,
  invokeNative,
  nativeCapability,
} from '../nativeBridge';

describe('iOS native bridge v1', () => {
  afterEach(() => {
    delete window.__ANJU_NATIVE__;
    delete window.webkit;
    vi.restoreAllMocks();
  });

  it('keeps browser behavior when the bridge is absent', () => {
    expect(nativeCapability('photo_capture')).toBe(false);
    expect(invokeNative('capture_photo', {
      request_id: 'request-1', assessment_id: 'assessment-1', access_token: 'token',
      room_id: 'room-1', room_type: 'bathroom', remaining_slots: 1,
    })).toBe(false);
  });

  it('posts only the versioned structured request when the capability exists', () => {
    const postMessage = vi.fn();
    window.__ANJU_NATIVE__ = {
      bridge_version: 1,
      capabilities: {photo_capture: true, live_scan: true, spatial_tracking: true, advisor_rtc_lease: true},
    };
    window.webkit = {messageHandlers: {anjuNative: {postMessage}}};
    const payload = {
      request_id: 'request-1', assessment_id: 'assessment-1', access_token: 'memory-only-token',
      room_id: 'room-1', room_type: 'bathroom', remaining_slots: 4, camera_session_id: 'camera-1',
      advisor_session_id: 'advisor-1',
      advisor_events: {
        websocket_path: '/api/v2/assessments/assessment-1/rooms/room-1/advisor/sessions/advisor-1/events',
        token: 'one-time-event-token', expires_at: '2026-08-08T10:02:00Z',
      },
    };

    expect(invokeNative('start_live_scan', payload)).toBe(true);
    expect(nativeCapability('advisor_rtc_lease')).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({bridge_version: 1, command: 'start_live_scan', ...payload});
  });

  it('validates completed, partial, cancelled and failed result envelopes', () => {
    const base = {
      request_id: 'request-1', room_id: 'room-1', capture_mode: 'spatial_ar',
      uploaded_media_ids: ['media-1'], failed_count: 0, error_code: null,
      camera_session_id: 'camera-1',
    };
    for (const status of ['completed', 'partial', 'cancelled', 'failed']) {
      expect(isNativeCaptureResult({...base, status})).toBe(true);
    }
    expect(isNativeCaptureResult({...base, status: 'complete'})).toBe(false);
  });
});
