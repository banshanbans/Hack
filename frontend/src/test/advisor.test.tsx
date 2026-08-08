import {StrictMode} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from '../App';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {'Content-Type': 'application/json'},
});

describe('AI 适老顾问', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'assessment-1', access_token: 'token-1'}));
    window.location.hash = '#/advisor/room-1?risk_id=risk-1';
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('只在正式结果后恢复对话，隐藏底部导航，并可以文字追问', async () => {
    let messageCalls = 0;
    let createSessionCalls = 0;
    const sockets: Array<{onmessage: ((event: MessageEvent) => void) | null}> = [];
    vi.stubGlobal('WebSocket', class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() { sockets.push(this); }
      close() {}
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return jsonResponse({analysis: 'ark', capabilities: {voice_advisor: false}});
      if (url.includes('/media/media-1/content')) return new Response(new Blob(['image'], {type: 'image/jpeg'}), {status: 200, headers: {'Content-Type': 'image/jpeg'}});
      if (url.endsWith('/advisor/sessions') && init?.method === 'POST') {
        createSessionCalls += 1;
        return jsonResponse({
          session_id: 'advisor-1', phase: 'formal',
          room: {room_id: 'room-1', room_type: 'bathroom', room_name: '卫生间', status: 'result_ready'},
          current_media: {media_id: 'media-1', content_path: '/api/v2/assessments/assessment-1/media/media-1/content', mime_type: 'image/jpeg', width: 960, height: 720, quality: {usable: true, clear: true, floor_visible: true, path_visible: true, lighting_sufficient: true, major_occlusion: false, scene_elements: [], missing_views: []}},
          media: [{media_id: 'media-1', content_path: '/api/v2/assessments/assessment-1/media/media-1/content', mime_type: 'image/jpeg', width: 960, height: 720, quality: {usable: true, clear: true, floor_visible: true, path_visible: true, lighting_sufficient: true, major_occlusion: false, scene_elements: [], missing_views: []}}],
          suggestions: [], camera_session_id: 'camera-1',
          risks: [{risk_id: 'risk-1', room_id: 'room-1', media_id: 'media-1', risk_code: 'wet_floor', state: 'confirmed', feedback: null, title: '地面湿滑', evidence: '地面有水迹', confidence: .91, region: null, severity: 'high', score_deduction: 12}],
          quick_prompts: ['这个地方可能有什么问题？'],
          turns: [{turn_id: 'turn-1', role: 'assistant', kind: 'message', text: '您好，我是您的 AI 适老顾问。', status: 'final', context_refs: {}, cards: [], created_at: '2026-08-08T10:00:00+00:00'}],
          context_refs: {room_id: 'room-1', media_id: 'media-1', risk_id: 'risk-1'}, rtc: {available: false, reason: 'not_configured'},
          events: {websocket_path: '/api/v2/assessments/assessment-1/rooms/room-1/advisor/sessions/advisor-1/events', token: 'event-token', expires_at: '2026-08-08T10:02:00+00:00'},
          prompt_version: 'anju_voice_advisor_v1',
        }, 201);
      }
      if (url.endsWith('/advisor/sessions/advisor-1/messages') && init?.method === 'POST') {
        messageCalls += 1;
        return jsonResponse({
          user_turn: {turn_id: `user-${messageCalls}`, role: 'user', kind: 'message', text: '这个地方可能有什么问题？', status: 'final', context_refs: {room_id: 'room-1', media_id: 'media-1'}, cards: [], created_at: '2026-08-08T10:01:00+00:00'},
          assistant_turn: {turn_id: `assistant-${messageCalls}`, role: 'assistant', kind: 'message', text: '这是正式风险，可先查看证据位置。', status: 'final', context_refs: {room_id: 'room-1', media_id: 'media-1', risk_id: 'risk-1'}, cards: [], created_at: '2026-08-08T10:01:01+00:00'},
        });
      }
      return jsonResponse({code: 'not_found', message: 'not found'}, 404);
    });

    render(<StrictMode><App /></StrictMode>);

    expect(await screen.findByRole('heading', {name: '卫生间·AI适老顾问'})).toBeVisible();
    expect(createSessionCalls).toBe(1);
    expect(screen.getByText('正式检查结果', {selector: '.advisor-phase'})).toBeVisible();
    expect(screen.getAllByText('地面湿滑').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('navigation', {name: '主导航'})).not.toBeInTheDocument();
    sockets[sockets.length - 1].onmessage?.({data: JSON.stringify({type: 'turn', turn: {turn_id: 'turn-event', role: 'assistant', kind: 'message', text: '事件通道已连接。', status: 'final', context_refs: {}, cards: [], created_at: '2026-08-08T10:00:30+00:00'}})} as MessageEvent);
    expect(await screen.findByText('事件通道已连接。')).toBeVisible();

    fireEvent.click(screen.getByRole('button', {name: '这个地方可能有什么问题？'}));
    await waitFor(() => expect(screen.getByText('这是正式风险，可先查看证据位置。')).toBeVisible());
    expect(messageCalls).toBe(1);
  });
});
