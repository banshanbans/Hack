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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

describe('H5 camera session recovery', () => {
  beforeEach(() => {
    localStorage.clear();
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

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
    expect(screen.getByRole('button', {name: /结束扫描并分析/})).toBeEnabled();
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

  it('restores a pending scan analysis after profile save and starts analysis automatically', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'fresh', access_token: 'token', last_route: 'profile'}));
    window.location.hash = '#/profile?resume=scan_analysis&room_id=room-1';
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
      if (url.endsWith('/api/v2/assessments/fresh/rooms/room-1/status')) return json({status: 'queued', stage: 'queued', progress: 0});
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

    await waitFor(() => expect(window.location.hash).toBe('#/analyzing/room-1'));
    expect(calls).toEqual(['profile', 'analysis']);
  });
});
