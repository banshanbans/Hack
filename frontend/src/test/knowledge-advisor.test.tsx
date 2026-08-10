import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from '../App';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type': 'application/json'},
});

function bootstrap() {
  return {
    session_id: 'knowledge-1', access_token: 'knowledge-token', expires_at: '2099-01-01T00:00:00+00:00',
    welcome_title: '你好，我是长者友好家的 AI 适老顾问',
    turns: [{
      turn_id: 'welcome-1', role: 'assistant', kind: 'welcome',
      text: '欢迎', status: 'final', suggested_questions: [], created_at: '2026-08-10T00:00:00+00:00',
    }],
    quick_prompts: ['卫生间扶手怎么选？', '卧室夜间照明怎么改善？', '地垫怎样放更安全？', '长者友好家能帮我做什么？'],
    knowledge_version: 'anju_advisor_knowledge_v1', prompt_version: 'anju_knowledge_advisor_v1',
    rtc: {available: false, media_mode: 'audio', video_available: false},
  };
}

describe('general knowledge advisor', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.location.hash = '#/home';
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('opens /advisor without creating an assessment or camera session and sends text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return jsonResponse({analysis: 'ark', capabilities: {h5_camera: true, knowledge_advisor: true}});
      if (url.endsWith('/api/v2/knowledge-advisor/sessions') && init?.method === 'POST') return jsonResponse(bootstrap(), 201);
      if (url.endsWith('/api/v2/knowledge-advisor/sessions/knowledge-1/messages')) return jsonResponse({
        user_turn: {turn_id: 'u1', role: 'user', kind: 'text', text: '地垫怎样放更安全？', status: 'final', suggested_questions: [], created_at: '2026-08-10T00:01:00+00:00'},
        assistant_turn: {turn_id: 'a1', role: 'assistant', kind: 'text', text: '优先保持边缘平整，并使用可靠防滑背衬。', status: 'final', suggested_questions: ['还要注意什么？'], created_at: '2026-08-10T00:01:01+00:00'},
        expires_at: '2099-01-01T00:00:00+00:00',
      });
      if (url.endsWith('/api/v2/knowledge-advisor/sessions/knowledge-1') && init?.method === 'DELETE') return new Response(null, {status: 204});
      return jsonResponse({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '问问 AI 助手'}));

    await waitFor(() => expect(window.location.hash).toBe('#/advisor'));
    expect(await screen.findByRole('heading', {name: '我是长者友好家AI居家顾问，有任何适老化改造问题都可以问我'})).toBeVisible();
    expect(screen.getByText('我可以帮你了解居家环境中的行动风险，并把适老化改造建议讲得更清楚。')).toBeVisible();
    expect(screen.getByRole('heading', {name: '适老科普'})).toBeVisible();
    expect(screen.getByRole('heading', {name: '改造建议'})).toBeVisible();
    expect(screen.getByRole('button', {name: '防滑地面有哪些低成本方案？'})).toBeVisible();
    expect(screen.getByRole('button', {name: /开始家庭检查/})).toBeVisible();
    expect(screen.queryByRole('navigation', {name: '主导航'})).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/v2/assessments')).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/camera/'))).toBe(false);
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/knowledge-advisor/sessions') && init?.method === 'POST')).toHaveLength(1);

    const input = screen.getByPlaceholderText('输入你想了解的适老化问题…');
    fireEvent.change(input, {target: {value: '地垫怎样放更安全？'}});
    fireEvent.click(screen.getByRole('button', {name: '发送'}));
    expect(await screen.findByText('优先保持边缘平整，并使用可靠防滑背衬。')).toBeVisible();

    fireEvent.click(screen.getByRole('button', {name: '更多'}));
    expect(screen.getByText(/不保存原始音频/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: '新对话'}));
    await waitFor(() => expect(screen.queryByText('优先保持边缘平整，并使用可靠防滑背衬。')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/knowledge-advisor/sessions/knowledge-1') && init?.method === 'DELETE')).toBe(true);
  });

  it('shows an unavailable label when the capability is off', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({analysis: 'ark', capabilities: {knowledge_advisor: false}}));
    render(<App />);
    expect(await screen.findByRole('button', {name: 'AI 助手暂未开放'})).toBeDisabled();
  });
});
