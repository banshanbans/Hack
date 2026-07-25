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
    fireEvent.click(screen.getByRole('button', {name: /上传家中照片/}));
    await waitFor(() => expect(window.location.hash).toBe('#/profile'));
    expect(fetchMock).toHaveBeenCalledWith('/api/v2/assessments', expect.objectContaining({method: 'POST'}));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('anju_h5_session_v2') || '{}')).toMatchObject({assessment_id: 'a-1', access_token: 't-1'}));
  });

  it('offers the saved route when an assessment exists', () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 't-1', last_route: 'rooms'}));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({analysis: 'ark'}), {status: 200, headers: {'Content-Type': 'application/json'}}));
    render(<App />);
    expect(screen.getByRole('button', {name: '继续上次检查'})).toBeEnabled();
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
