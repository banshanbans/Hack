import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';

vi.mock('../video', async importOriginal => {
  const original = await importOriginal<typeof import('../video')>();
  return {
    ...original,
    inspectPixels: () => ({brightness: 120, sharpness: 12, hash: '0123456789abcdef'}),
  };
});

import App from '../App';
import {NATIVE_CAPTURE_RESULT_EVENT} from '../nativeBridge';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

describe('H5 camera session recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'stale', access_token: 'old-token', last_route: 'camera'}));
    window.location.hash = '#/camera?room_id=room-1';
    Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({getTracks: () => [{stop: vi.fn()}]}),
    }});
    Object.defineProperties(HTMLVideoElement.prototype, {
      readyState: {configurable: true, get: () => 2},
      videoWidth: {configurable: true, get: () => 640},
      videoHeight: {configurable: true, get: () => 480},
      play: {configurable: true, value: vi.fn().mockResolvedValue(undefined)},
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {configurable: true, value: vi.fn(() => ({
      drawImage: vi.fn(),
      getImageData: () => ({data: new Uint8ClampedArray(640 * 480 * 4)}),
    }))});
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {configurable: true, value: vi.fn(callback => callback(new Blob(['frame'], {type: 'image/jpeg'})))});
  });

  afterEach(() => {
    cleanup();
    delete window.__ANJU_NATIVE__;
    delete window.webkit;
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    vi.restoreAllMocks();
  });

  it('clears a stale assessment and returns to the home entry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true, h5_video: true, ios_home_camera: true}});
      if (url.endsWith('/api/v2/assessments/stale')) return json({code: 'assessment_access_denied', message: 'expired'}, 404);
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe('#/home'));
    expect(localStorage.getItem('anju_h5_session_v2')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/v2/assessments/stale'))).toBe(true);
  });

  it('creates both scan sessions, shows deterministic guidance and sends the selected suggestion context', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    let messageContext: Record<string, string> | undefined;
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'fresh', access_token: 'token', last_route: 'camera'}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true, h5_video: true, ios_home_camera: true}});
      if (url.endsWith('/api/v2/assessments/fresh')) return json({
        assessment_id: 'fresh', profile: {}, rooms: [{room_id: 'room-1', room_type: 'corridor', status: 'collecting_media', media: []}],
      });
      if (url.endsWith('/assessments/fresh/rooms/room-1/camera/sessions')) return json({camera_session_id: 'camera-session-1', expires_at: '2026-08-08T11:00:00Z'}, 201);
      if (url.endsWith('/assessments/fresh/rooms/room-1/advisor/sessions') && init?.method === 'POST') return json({
        session_id: 'advisor-session-1', phase: 'draft',
        room: {room_id: 'room-1', room_type: 'corridor', room_name: '玄关走廊', status: 'collecting_media'},
        current_media: null, media: [], suggestions: [], camera_session_id: 'camera-session-1', risks: [],
        quick_prompts: ['这个地方可能有什么问题？'],
        turns: [{turn_id: 'turn-1', role: 'assistant', kind: 'message', text: '我会在扫描时提醒你。', status: 'final', context_refs: {}, cards: [], created_at: '2026-08-08T10:00:00Z'}],
        context_refs: {room_id: 'room-1', camera_session_id: 'camera-session-1'},
        rtc: {available: false, reason: 'not_configured'}, prompt_version: 'anju_voice_advisor_v1',
      }, 201);
      if (url.includes('/assessments/fresh/rooms/room-1/camera/frames:inspect')) return json({
        frame_id: 'frame-1', temporary: true, quality_usable: true, scene_elements: ['walking_path'],
        suggestions: [{
          suggestion_id: 'suggestion-1', risk_code: 'floor_clutter', title: '通道有杂物', short_advice: '先移开通道里的杂物',
          evidence: '通道中有一个纸箱', confidence: .91, needs_manual_check: false, possible_repeat: true,
          region: {type: 'bbox', x: .1, y: .2, width: .3, height: .2}, temporary: true, save_as_evidence_recommended: true,
        }],
        save_as_evidence_recommended: true, prompt_version: 'anju_h5_camera_discovery_v3', rule_version: 'live-camera-rules-2026-07-26-v3',
      });
      if (url.endsWith('/advisor/sessions/advisor-session-1/messages') && init?.method === 'POST') {
        messageContext = JSON.parse(String(init.body)).context_refs;
        return json({
          user_turn: {turn_id: 'turn-user', role: 'user', kind: 'message', text: '这个地方可能有什么问题？', status: 'final', context_refs: messageContext, cards: [], created_at: '2026-08-08T10:01:00Z'},
          assistant_turn: {turn_id: 'turn-assistant', role: 'assistant', kind: 'message', text: '你选中的位置可能存在通道杂物，正式分析前仍需确认。', status: 'final', context_refs: messageContext, cards: [], created_at: '2026-08-08T10:01:01Z'},
        });
      }
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '开启后置相机'}));

    expect((await screen.findAllByText('通道有杂物')).length).toBeGreaterThanOrEqual(1);
    expect((await screen.findAllByText('先移开通道里的杂物')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('已发现 1 条待确认提示')).toBeVisible();
    expect(screen.getByRole('button', {name: /结束扫描并保存/})).toBeEnabled();
    expect(document.querySelector('.camera-advisor-guidance')).not.toBeNull();
    expect(document.querySelector('.camera-region-overlay rect')).not.toBeNull();
    expect(document.querySelector('.camera-region-overlay > img')?.getAttribute('src')).toMatch(/^blob:anju-test-/);
    expect(document.querySelector('.camera-region-number')?.textContent).toBe('1');
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3_000);

    fireEvent.click(screen.getByText('已发现 1 条待确认提示'));
    fireEvent.click(screen.getByRole('button', {name: /通道有杂物/}));
    fireEvent.click(screen.getByRole('button', {name: '这个地方可能有什么问题？'}));
    await waitFor(() => expect(messageContext).toEqual({
      room_id: 'room-1', camera_session_id: 'camera-session-1', camera_suggestion_id: 'suggestion-1', frame_id: 'frame-1',
    }));
    expect(await screen.findByText(/你选中的位置可能存在通道杂物/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', {name: /暂停扫描/}));
    expect(document.querySelector('.camera-region-overlay')).toBeNull();
    expect(revokeSpy).toHaveBeenCalled();
  });

  it('completes an H5 scan, closes the advisor and returns to upload without analyzing', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'fresh', access_token: 'token', last_route: 'camera'}));
    const calls: Array<{url: string; method: string}> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      calls.push({url, method});
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true}});
      if (url.endsWith('/api/v2/assessments/fresh')) return json({
        assessment_id: 'fresh', profile: {},
        rooms: [{room_id: 'room-1', room_type: 'corridor', status: 'collecting_media', media: []}],
      });
      if (url.endsWith('/rooms/room-1/camera/sessions') && method === 'POST') {
        return json({camera_session_id: 'camera-session-1', expires_at: '2026-08-09T01:00:00Z'}, 201);
      }
      if (url.endsWith('/rooms/room-1/advisor/sessions') && method === 'POST') return json({
        session_id: 'advisor-session-1', phase: 'draft',
        room: {room_id: 'room-1', room_type: 'corridor', room_name: '玄关走廊', status: 'collecting_media'},
        current_media: null, media: [], suggestions: [], camera_session_id: 'camera-session-1', risks: [],
        quick_prompts: [], turns: [], context_refs: {room_id: 'room-1'},
        rtc: {available: false, reason: 'not_configured'}, prompt_version: 'anju_voice_advisor_v1',
      }, 201);
      if (url.includes('/camera/frames:inspect')) return json({
        frame_id: 'frame-1', temporary: true, quality_usable: true, scene_elements: ['walking_path'],
        suggestions: [], save_as_evidence_recommended: true,
        prompt_version: 'anju_h5_camera_discovery_v3', rule_version: 'rules-v1',
      });
      if (url.endsWith('/rooms/room-1/media') && method === 'POST') return json({
        media_id: 'media-scan-1', content_path: '/media/media-scan-1', mime_type: 'image/jpeg', width: 640, height: 480,
        quality: {usable: true, clear: true, floor_visible: true, path_visible: true, lighting_sufficient: true, major_occlusion: false, scene_elements: ['walking_path'], missing_views: []},
      }, 201);
      if (url.endsWith('/camera/sessions/camera-session-1:complete') && method === 'POST') {
        return json({camera_session_id: 'camera-session-1', status: 'completed', media_ids: ['media-scan-1']});
      }
      if (url.endsWith('/advisor/sessions/advisor-session-1') && method === 'DELETE') return new Response(null, {status: 204});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '开启后置相机'}));
    const finish = await screen.findByRole('button', {name: /结束扫描并保存/});
    await waitFor(() => expect(finish).toBeEnabled());
    fireEvent.click(finish);

    await waitFor(() => expect(window.location.hash).toBe('#/upload/room-1'));
    expect(calls.some(call => call.url.endsWith('/camera/sessions/camera-session-1:complete') && call.method === 'POST')).toBe(true);
    expect(calls.some(call => call.url.endsWith('/advisor/sessions/advisor-session-1') && call.method === 'DELETE')).toBe(true);
    expect(calls.some(call => call.url.endsWith('/rooms/room-1:analyze'))).toBe(false);
  });

  it('completes a native scan through the same save-only boundary', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'fresh', access_token: 'token', last_route: 'camera'}));
    const postMessage = vi.fn();
    window.__ANJU_NATIVE__ = {bridge_version: 1, capabilities: {live_scan: true, advisor_rtc_lease: true}};
    window.webkit = {messageHandlers: {anjuNative: {postMessage}}};
    const calls: Array<{url: string; method: string}> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      calls.push({url, method});
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true, ios_home_camera: true}});
      if (url.endsWith('/api/v2/assessments/fresh')) return json({
        assessment_id: 'fresh', profile: {}, rooms: [{room_id: 'room-1', room_type: 'corridor', status: 'collecting_media', media: []}],
      });
      if (url.endsWith('/rooms/room-1/camera/sessions') && method === 'POST') return json({camera_session_id: 'camera-native-1', expires_at: '2026-08-09T01:00:00Z'}, 201);
      if (url.endsWith('/rooms/room-1/advisor/sessions') && method === 'POST') return json({
        session_id: 'advisor-native-1', phase: 'draft',
        room: {room_id: 'room-1', room_type: 'corridor', room_name: '玄关走廊', status: 'collecting_media'},
        current_media: null, media: [], suggestions: [], camera_session_id: 'camera-native-1', risks: [],
        quick_prompts: [], turns: [], context_refs: {room_id: 'room-1'},
        rtc: {available: false, reason: 'not_configured'}, prompt_version: 'anju_voice_advisor_v1',
      }, 201);
      if (url.endsWith('/camera/sessions/camera-native-1:complete') && method === 'POST') {
        return json({camera_session_id: 'camera-native-1', status: 'completed', media_ids: ['media-native-1']});
      }
      if (url.endsWith('/advisor/sessions/advisor-native-1') && method === 'DELETE') return new Response(null, {status: 204});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '开启后置相机'}));
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const request = postMessage.mock.calls[0][0] as {request_id: string};
    window.dispatchEvent(new CustomEvent(NATIVE_CAPTURE_RESULT_EVENT, {detail: {
      request_id: request.request_id, status: 'completed', room_id: 'room-1', capture_mode: 'spatial_ar',
      uploaded_media_ids: ['media-native-1'], failed_count: 0, error_code: null, camera_session_id: 'camera-native-1',
    }}));

    await waitFor(() => expect(window.location.hash).toBe('#/upload/room-1'));
    expect(calls.some(call => call.url.endsWith('/camera/sessions/camera-native-1:complete') && call.method === 'POST')).toBe(true);
    expect(calls.some(call => call.url.endsWith('/rooms/room-1:analyze'))).toBe(false);
  });

  it.each([
    ['new native lease capability', true, false],
    ['legacy native bridge', false, true],
  ])('%s controls whether H5 cancels the handed-off RTC ticket', async (_label, nativeLease, expectsDelete) => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'fresh', access_token: 'token', last_route: 'camera'}));
    const postMessage = vi.fn();
    window.__ANJU_NATIVE__ = {bridge_version: 1, capabilities: {live_scan: true, advisor_rtc_lease: nativeLease}};
    window.webkit = {messageHandlers: {anjuNative: {postMessage}}};
    const calls: Array<{url: string; method: string}> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      calls.push({url, method});
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true, ios_home_camera: true}});
      if (url.endsWith('/api/v2/assessments/fresh')) return json({
        assessment_id: 'fresh', profile: {}, rooms: [{room_id: 'room-1', room_type: 'corridor', status: 'collecting_media', media: []}],
      });
      if (url.endsWith('/rooms/room-1/camera/sessions') && method === 'POST') return json({camera_session_id: 'camera-native-1', expires_at: '2026-08-09T01:00:00Z'}, 201);
      if (url.endsWith('/rooms/room-1/advisor/sessions') && method === 'POST') return json({
        session_id: 'advisor-native-1', phase: 'draft', room: {room_id: 'room-1', room_type: 'corridor', room_name: '玄关走廊', status: 'collecting_media'},
        current_media: null, media: [], suggestions: [], camera_session_id: 'camera-native-1', risks: [], quick_prompts: [], turns: [], context_refs: {room_id: 'room-1'},
        rtc: {available: true, video_available: true, requires_start: true, media_mode: 'audio_video'}, prompt_version: 'anju_voice_advisor_v1',
      }, 201);
      if (url.endsWith('/advisor/sessions/advisor-native-1/rtc-queue') && method === 'POST') return json({
        ticket_id: 'ticket-native-1', status: 'granted', position: 0, expires_at: '2099-08-09T01:00:00Z', poll_after_ms: 2_000, mode: 'audio_video',
      }, 201);
      if (url.endsWith('/rtc-queue/ticket-native-1') && method === 'DELETE') return new Response(null, {status: 204});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '开启后置相机'}));
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    document.dispatchEvent(new Event('visibilitychange'));
    if (expectsDelete) {
      await waitFor(() => expect(calls.some(call => call.url.endsWith('/rtc-queue/ticket-native-1') && call.method === 'DELETE')).toBe(true));
    } else {
      await Promise.resolve();
      expect(calls.some(call => call.url.endsWith('/rtc-queue/ticket-native-1') && call.method === 'DELETE')).toBe(false);
    }
  });

  it('returns to the upload page after profile save without starting analysis automatically', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'fresh', access_token: 'token', last_route: 'profile'}));
    window.location.hash = '#/profile?return_to=%2Fupload%2Froom-1';
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true}});
      if (url.endsWith('/api/v2/assessments/fresh')) return json({
        assessment_id: 'fresh', profile: {},
        rooms: [{room_id: 'room-1', room_type: 'corridor', status: 'media_ready', media: [{
          media_id: 'media-1', content_path: '/media/media-1', mime_type: 'image/jpeg', width: 960, height: 720,
          quality: {usable: true, clear: true, floor_visible: true, path_visible: true, lighting_sufficient: true, major_occlusion: false, scene_elements: ['walking_path'], missing_views: []},
        }]}],
      });
      if (url.endsWith('/api/v2/assessments/fresh/profile') && init?.method === 'PUT') {
        calls.push('profile');
        return json({mobility: 'normal', fall_history: 'none', living_status: 'with_family'});
      }
      if (url.endsWith('/api/v2/assessments/fresh/rooms/room-1:analyze') && init?.method === 'POST') {
        calls.push('analysis');
        return json({job_id: 'job-1', status: 'queued', stage: 'queued'}, 202);
      }
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '行走基本正常'}));
    fireEvent.click(screen.getByRole('radio', {name: '没有'}));
    fireEvent.click(screen.getByRole('radio', {name: '与家人同住'}));
    fireEvent.click(screen.getByRole('button', {name: /保存并继续/}));

    await waitFor(() => expect(window.location.hash).toBe('#/upload/room-1'));
    expect(calls).toEqual(['profile']);
  });
});
