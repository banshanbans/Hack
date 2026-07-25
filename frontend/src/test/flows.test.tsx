import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from '../App';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

function restoreAt(route: string) {
  localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 't-1', last_route: route.replace(/^\//, '')}));
  window.location.hash = `#${route}`;
}

describe('recoverable product states', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('keeps P02 next disabled until all three profile answers exist', async () => {
    restoreAt('/profile');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: []});
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    expect(await screen.findByRole('button', {name: /保存并继续/})).toBeDisabled();
  });

  it('keeps profile edits as a draft until the user explicitly saves', async () => {
    restoreAt('/profile');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1/profile') && init?.method === 'PUT') return json({mobility: 'normal', fall_history: 'none', living_status: 'with_family'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: []});
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', {name: '行走基本正常'}));
    fireEvent.click(screen.getByLabelText('没有'));
    fireEvent.click(screen.getByLabelText('与家人同住'));
    await new Promise(resolve => window.setTimeout(resolve, 350));
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/profile') && init?.method === 'PUT')).toBe(false);

    fireEvent.click(screen.getByRole('button', {name: /保存并继续/}));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/profile') && init?.method === 'PUT')).toBe(true));
  });

  it('renders a low-coverage report as an assessed-area score with an empty budget', async () => {
    restoreAt('/report');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/report')) return json({
        status: 'in_progress', checked_room_count: 1, planned_room_count: 6, coverage_percent: 42,
        score_title: '当前已检查区域安全参考分', assessed_area_score: 81, household_score: null,
        rooms: [], selected_items: [], budget: {currency: 'CNY', total_min: 0, total_max: 0, material_min: 0, material_max: 0, labor_min: 0, labor_max: 0, unknown_items: []},
        projected_score: null, price_disclaimer: '仅供参考',
      });
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    expect(await screen.findByText('当前已检查区域安全参考分')).toBeVisible();
    expect(screen.getByText('42%')).toBeVisible();
    expect(screen.queryByText('检查仍可继续')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', {name: '存在的隐患'})).toBeVisible();
    expect(screen.getByText('当前已检查区域暂未发现明确隐患')).toBeVisible();
    expect(screen.getByRole('heading', {name: '改造建议与预算'})).toBeVisible();
    expect(screen.getByRole('button', {name: /下载报告图片/})).toBeEnabled();
  });

  it('saves profile edits from My and returns to My instead of entering the check flow', async () => {
    restoreAt('/my');
    const assessment = {assessment_id: 'a-1', rooms: [], profile: {mobility: 'cane', fall_history: 'once', living_status: 'alone'}};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json(assessment);
      if (url.endsWith('/profile') && init?.method === 'PUT') return json({mobility: 'normal', fall_history: 'once', living_status: 'alone'});
      if (url.endsWith('/report')) return json({status: 'in_progress', checked_room_count: 0, planned_room_count: 0, coverage_percent: 0, score_title: '当前已检查区域安全参考分', assessed_area_score: null, household_score: null, rooms: [], selected_items: [], budget: {currency: 'CNY', total_min: 0, total_max: 0, material_min: 0, material_max: 0, labor_min: 0, labor_max: 0, unknown_items: []}, projected_score: null, price_disclaimer: '仅供参考'});
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '编辑'}));
    expect(window.location.hash).toBe('#/profile?from=my');
    fireEvent.click(await screen.findByRole('button', {name: '行走基本正常'}));
    fireEvent.click(screen.getByRole('button', {name: /^保存$/}));
    await waitFor(() => expect(window.location.hash).toBe('#/my'));
  });

  it('opens score details in a bottom sheet and keeps the persistent tabs', async () => {
    restoreAt('/result/room-1');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: [{room_id: 'room-1', room_type: 'bathroom', status: 'result_ready', media: []}]});
      if (url.endsWith('/rooms/room-1/result')) return json({
        room_id: 'room-1', room_type: 'bathroom', status: 'result_ready', score: 78,
        score_label: '已检查区域参考分', coverage: {percent: 85, limited: false},
        counts: {high: 0, medium: 0, low: 0}, risks: [], score_breakdown: [],
        main_deductions: [{risk_id: 'risk-1', title: '缺少可靠扶手', deduction: 12, rule_ids: ['rule-1']}], rule_set_version: 'v1',
      });
      return json({code: 'not_found', message: 'not found'}, 404);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', {name: '查看评分依据'}));
    expect(screen.getByRole('dialog', {name: '参考分的计算依据'})).toBeVisible();
    expect(screen.getByText('扣 12 分')).toBeVisible();
    expect(screen.getByRole('navigation', {name: '主导航'})).toBeVisible();
    expect(screen.getByRole('button', {name: '我的'})).toBeVisible();
  });

  it('recovers a stale risk route after re-analysis instead of showing a generic failure', async () => {
    restoreAt('/solutions/room-1/stale-risk');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark'});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', rooms: [{room_id: 'room-1', room_type: 'bathroom', media: []}]});
      if (url.endsWith('/rooms/room-1/result')) return json({
        room_id: 'room-1', room_type: 'bathroom', status: 'result_ready', score: 82,
        score_label: '已检查区域参考分', coverage: {percent: 80, limited: false},
        counts: {high: 1, medium: 0, low: 0}, score_breakdown: [], main_deductions: [], rule_set_version: 'v1',
        risks: [{risk_id: 'current-risk', room_id: 'room-1', media_id: 'media-1', risk_code: 'BATH_NO_GRAB_BAR', state: 'unreviewed', feedback: null, title: '缺少可靠扶手', evidence: '淋浴区未见可靠扶手', confidence: 0.9, region: null, severity: 'high', score_deduction: 12}],
      });
      if (url.endsWith('/risks/stale-risk/solutions')) return json({code: 'risk_not_found', message: 'not found'}, 404);
      if (url.endsWith('/risks/current-risk/solutions')) return json({risk_id: 'current-risk', solutions: [], selected_solution_package_id: null, price_disclaimer: '仅供参考'});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    expect(await screen.findByRole('heading', {name: '缺少可靠扶手怎么改？'})).toBeVisible();
    expect(window.location.hash).toBe('#/solutions/room-1/current-risk');
    expect(screen.queryByText('这次没有完成')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/risks/stale-risk/solutions'))).toBe(false);
  });

  it('redirects a deep solution link without issuing protected calls when no session exists', async () => {
    window.location.hash = '#/solutions/room-1/stale-risk';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/health')) return json({analysis: 'ark'});
      return json({code: 'unexpected_request', message: 'unexpected'}, 500);
    });

    render(<App />);
    expect(await screen.findByRole('heading', {name: /给父母的家/})).toBeVisible();
    expect(window.location.hash).toBe('#/home');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/result') || String(input).includes('/solutions'))).toBe(false);
  });
});
