import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
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
    expect(await screen.findByRole('button', {name: /下一步/})).toBeDisabled();
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
    expect(screen.getByText('检查仍可继续')).toBeVisible();
    expect(screen.getAllByText('还没有选择这一级别的整改方案')).toHaveLength(3);
  });

  it('shows the product share-expired state without leaking an API response', async () => {
    window.location.hash = '#/share/expired';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/health')) return json({analysis: 'ark'});
      return json({code: 'share_expired', message: '分享链接已失效'}, 404);
    });
    render(<App />);
    expect(await screen.findByText('分享链接已失效')).toBeVisible();
    expect(screen.queryByText('share_expired')).not.toBeInTheDocument();
  });

  it('recovers a stale risk route after re-analysis instead of showing a generic failure', async () => {
    restoreAt('/solutions/room-1/stale-risk');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
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
