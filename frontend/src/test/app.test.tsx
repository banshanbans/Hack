import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from '../App';

describe('P01 entry and route recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = '#/home';
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders the Stitch-based start screen and creates an assessment', async () => {
    const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return jsonResponse({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments')) return jsonResponse({assessment_id: 'a-1', access_token: 't-1'}, 201);
      if (url.endsWith('/api/v2/assessments/a-1')) return jsonResponse({assessment_id: 'a-1', rooms: []});
      return jsonResponse({error: {message: 'not found'}}, 404);
    });

    render(<App />);
    expect(screen.getByRole('heading', {name: /给父母的家/})).toBeVisible();
    expect(screen.getAllByText('长者友好家').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('heading', {name: '本次检查进度'})).toBeVisible();
    expect(screen.getByRole('progressbar', {name: '检查完成进度'})).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('进行到：家人情况')).toBeVisible();
    expect(screen.getByRole('navigation', {name: '主导航'})).toBeVisible();
    expect(screen.getByRole('button', {name: '首页'})).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', {name: '改造方案'})).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', {name: 'AR 实时识别'})).toBeVisible();
    expect(screen.getByRole('button', {name: '我的'})).toBeVisible();
    expect(screen.queryByText('浴室防滑指南')).not.toBeInTheDocument();
    expect(screen.queryByText('夜间照明建议')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: /上传家中照片/}));
    await waitFor(() => expect(window.location.hash).toBe('#/profile'));
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/assessments', expect.objectContaining({method: 'POST'}));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('anju_h5_session_v2') || '{}')).toMatchObject({assessment_id: 'a-1', access_token: 't-1'}));
  });

  it('shows the shared camera introduction before entering the realtime camera', async () => {
    const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return jsonResponse({analysis: 'ark', capabilities: {h5_camera: true, h5_video: true}});
      if (url.endsWith('/api/v2/assessments') && init?.method === 'POST') return jsonResponse({assessment_id: 'a-camera', access_token: 't-camera'}, 201);
      if (url.endsWith('/api/v2/assessments/a-camera')) return jsonResponse({assessment_id: 'a-camera', profile: {}, rooms: [{room_id: 'room-camera', room_type: 'bathroom', status: 'collecting_media', media: []}]});
      if (url.endsWith('/api/v2/assessments/a-camera/rooms') && init?.method === 'POST') return jsonResponse({room_id: 'room-camera', room_type: 'bathroom', status: 'collecting_media', media: []}, 201);
      return jsonResponse({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'AR 实时识别'}));

    const dialog = screen.getByRole('dialog', {name: '开始家庭实时检查'});
    expect(dialog).toBeVisible();
    expect(dialog).toHaveTextContent('不会自动保存照片或跳转页面');
    expect(window.location.hash).toBe('#/home');
    fireEvent.click(screen.getByRole('button', {name: /选择房间/}));
    fireEvent.click(screen.getByRole('button', {name: /卫生间/}));
    await waitFor(() => expect(window.location.hash).toBe('#/camera?room_id=room-camera&auto_start=1'));
    expect(await screen.findByRole('button', {name: '开启后置相机'})).toBeVisible();
    expect(screen.queryByRole('navigation', {name: '主导航'})).not.toBeInTheDocument();
    expect(screen.getByRole('heading', {name: '实时扫描'})).toBeVisible();
    expect(screen.getByRole('button', {name: '点击开始说话'})).toBeVisible();
    expect(screen.queryByRole('button', {name: '打开 AI 适老顾问对话'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: '结束扫描并保存'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: '改用照片'})).not.toBeInTheDocument();
    expect(screen.queryByText(/三维锚点|连续视频|当前区域/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/api/v2/assessments') && init?.method === 'POST')).toBe(true);
  });

  it('offers and restores the saved route when an assessment exists', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 't-1', last_route: 'rooms'}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response(JSON.stringify({analysis: 'ark'}), {status: 200, headers: {'Content-Type': 'application/json'}});
      if (url.endsWith('/api/v2/assessments/a-1')) return new Response(JSON.stringify({assessment_id: 'a-1', planned_rooms: [], rooms: []}), {status: 200, headers: {'Content-Type': 'application/json'}});
      return new Response(JSON.stringify({code: 'not_found', message: 'not found'}), {status: 404, headers: {'Content-Type': 'application/json'}});
    });
    render(<App />);
    expect(screen.getByRole('progressbar', {name: '检查完成进度'})).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText('进行到：选择房间')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: '继续上次检查'}));
    await waitFor(() => expect(window.location.hash).toBe('#/rooms'));
  });

  it.each([
    ['profile', '1', '家人情况'],
    ['rooms', '2', '选择房间'],
    ['upload/room-1', '3', '上传照片'],
    ['analyzing/room-1', '4', 'AI 检查'],
    ['risk/room-1/risk-1', '5', '查看结果'],
    ['report', '6', '改造清单'],
  ])('maps the saved route %s to home progress step %s', async (lastRoute, step, label) => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 't-1', last_route: lastRoute}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response(JSON.stringify({analysis: 'ark'}), {status: 200, headers: {'Content-Type': 'application/json'}});
      if (url.endsWith('/api/v2/assessments/a-1')) return new Response(JSON.stringify({assessment_id: 'a-1', planned_rooms: [], rooms: []}), {status: 200, headers: {'Content-Type': 'application/json'}});
      return new Response(JSON.stringify({code: 'not_found', message: 'not found'}), {status: 404, headers: {'Content-Type': 'application/json'}});
    });

    render(<App />);

    expect(screen.getByRole('progressbar', {name: '检查完成进度'})).toHaveAttribute('aria-valuenow', step);
    expect(screen.getByText(`进行到：${label}`)).toBeVisible();
  });

  it('keeps the primary action disabled while a new assessment is being created', async () => {
    let resolveAssessment: ((value: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response(JSON.stringify({analysis: 'ark'}), {status: 200, headers: {'Content-Type': 'application/json'}});
      if (url.endsWith('/api/v2/assessments')) return new Promise<Response>(resolve => { resolveAssessment = resolve; });
      return new Response(JSON.stringify({code: 'not_found', message: 'not found'}), {status: 404, headers: {'Content-Type': 'application/json'}});
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', {name: '上传家中照片'}));

    expect(screen.getByRole('button', {name: '正在开始…'})).toBeDisabled();
    resolveAssessment?.(new Response(JSON.stringify({assessment_id: 'a-1', access_token: 't-1'}), {status: 201, headers: {'Content-Type': 'application/json'}}));
    await waitFor(() => expect(window.location.hash).toBe('#/profile'));
  });

  it('hides the home camera entry and disables the camera tab when the capability is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({analysis: 'ark', capabilities: {h5_camera: false, h5_video: true}}), {status: 200, headers: {'Content-Type': 'application/json'}}));
    render(<App />);
    expect(await screen.findByRole('button', {name: 'AR 实时识别暂未开放'})).toBeDisabled();
    expect(screen.queryByRole('button', {name: '使用实时相机检查'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: '相机'})).not.toBeInTheDocument();
  });

  it('keeps legacy video sessions on the supported photo upload experience', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 't-1', last_route: 'upload/room-1'}));
    window.location.hash = '#/upload/room-1';
    const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return jsonResponse({analysis: 'ark', capabilities: {h5_camera: true, h5_video: true}});
      if (url.endsWith('/api/v2/assessments/a-1')) return jsonResponse({
        assessment_id: 'a-1', input_mode: 'video_frame', planned_rooms: ['bathroom'],
        rooms: [{room_id: 'room-1', room_type: 'bathroom', status: 'created', media: []}],
      });
      return jsonResponse({code: 'not_found', message: 'not found'}, 404);
    });

    const {container} = render(<App />);

    expect(await screen.findByRole('heading', {name: '上传卫生间照片'})).toBeVisible();
    expect(container.querySelector('input[accept="video/*"]')).toBeNull();
    expect(screen.queryByText('选择本地视频')).not.toBeInTheDocument();
  });

  it('opens a risk detail with only the solution action', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 't-1', last_route: 'risk/room-1/risk-1'}));
    window.location.hash = '#/risk/room-1/risk-1';
    const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return jsonResponse({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return jsonResponse({assessment_id: 'a-1', rooms: [{room_id: 'room-1', room_type: 'bedroom', media: []}]});
      if (url.endsWith('/rooms/room-1/result')) return jsonResponse({
        room_id: 'room-1', room_type: 'bedroom', status: 'result_ready', score: 90,
        score_label: '当前已评估区域相对稳妥', coverage: {percent: 100, limited: false},
        counts: {high: 1, medium: 0, low: 0}, score_breakdown: [], main_deductions: [], rule_set_version: 'v3',
        risks: [{risk_id: 'risk-1', room_id: 'room-1', media_id: 'media-1', risk_code: 'BED_TRANSFER_NO_SUPPORT', state: 'unreviewed', feedback: null, title: '床边起身缺少稳定支撑', evidence: '床边未见可靠支撑点', confidence: 0.9, region: null, severity: 'high', score_deduction: 8.5}],
      });
      return jsonResponse({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    expect(await screen.findByRole('heading', {name: '床边起身缺少稳定支撑'})).toBeVisible();
    expect(screen.getByRole('button', {name: '查看解决方案'})).toBeVisible();
    expect(screen.queryByRole('button', {name: '为什么有风险？'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: '这里判断不准确'})).not.toBeInTheDocument();
  });
});
