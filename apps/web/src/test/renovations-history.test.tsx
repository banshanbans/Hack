import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from '../App';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

describe('local renovation history hub', () => {
  beforeEach(() => {
    localStorage.clear();
    const entry = {assessment_id: 'history-1', access_token: 'history-token', created_at: '2026-08-09T08:00:00Z', last_opened_at: '2026-08-09T08:00:00Z'};
    localStorage.setItem('anju_h5_session_v2', JSON.stringify(entry));
    localStorage.setItem('anju_h5_assessment_history_v1', JSON.stringify([entry]));
    window.location.hash = '#/renovations';
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows authenticated risk evidence, selected solutions and the existing preview entry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {renovation_preview: true}});
      if (url.endsWith('/api/v2/assessments/history-1')) return json({
        assessment_id: 'history-1', status: 'completed', created_at: '2026-08-09T08:00:00Z', profile: {},
        rooms: [{room_id: 'room-1', room_type: 'bathroom', status: 'result_ready', score: 82, coverage_percent: 80, supported: true, media: [{media_id: 'media-1', width: 1200, height: 900, mime_type: 'image/jpeg', content_path: '/api/v2/assessments/history-1/media/media-1/content', quality: {usable: true}}]}],
        rule_set_version: 'v1', price_rule_version: 'p1',
      });
      if (url.endsWith('/api/v2/assessments/history-1/report')) return json({
        assessment_id: 'history-1', status: 'completed', checked_room_count: 1, planned_room_count: 1, coverage_percent: 80,
        score_title: '家庭安全参考分', assessed_area_score: 82, household_score: 82,
        rooms: [{room_id: 'room-1', room_type: 'bathroom', status: 'result_ready', score: 82, score_label: '参考分', coverage: {percent: 80, limited: false}, counts: {high: 1, medium: 0, low: 0}, score_breakdown: [], main_deductions: [], rule_set_version: 'v1', risks: [{risk_id: 'risk-1', room_id: 'room-1', media_id: 'media-1', risk_code: 'BATH_NO_GRAB_BAR', state: 'confirmed', feedback: null, title: '缺少可靠扶手', evidence: '淋浴区未见扶手', confidence: .9, region: {type: 'bbox', x: .2, y: .2, width: .3, height: .4}, severity: 'high', score_deduction: 12}]}],
        selected_items: [{selected_solution_id: 'selected-1', risk_id: 'risk-1', risk_title: '缺少可靠扶手', severity: 'high', status: 'selected', solution: {solution_package_id: 'solution-b', tier: 'B', title: '安装固定扶手', summary: '在合适墙面安装固定扶手', actions: ['安装固定扶手'], difficulty: '中', duration: '半天', construction_required: true, professional_installation: '建议', improvement: '提升支撑', limitations: [], budget_group_id: 'grab-bar', expected_score_gain_min: 5, expected_score_gain_max: 8, price: {currency: 'CNY', material_min: 10000, material_max: 20000, labor_min: 5000, labor_max: 10000, total_min: 15000, total_max: 30000}}}],
        budget: {currency: 'CNY', total_min: 15000, total_max: 30000, material_min: 10000, material_max: 20000, labor_min: 5000, labor_max: 10000, unknown_items: []}, projected_score: null, renovation_previews: [], price_disclaimer: '仅供参考',
      });
      if (url.endsWith('/rooms/room-1/renovation-preview-context')) return json({room_id: 'room-1', room_type: 'bathroom', selection_hash: 'hash', selected_solutions: [], eligible_media: [], previews: [], disclaimer: 'AI 效果示意'});
      if (url.endsWith('/media/media-1/content')) return new Response(new Blob(['image'], {type: 'image/jpeg'}), {status: 200, headers: {'Content-Type': 'image/jpeg'}});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    expect(await screen.findByRole('heading', {name: '改造方案'})).toBeVisible();
    expect(screen.getByRole('button', {name: '改造方案'})).toHaveAttribute('aria-current', 'page');
    fireEvent.click(await screen.findByRole('button', {name: /2026年8月9日/}));
    expect(await screen.findByText('缺少可靠扶手')).toBeVisible();
    expect(screen.getByText('B 档 · 安装固定扶手')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', {name: /生成改造效果/}));
    await waitFor(() => expect(window.location.hash).toBe('#/renovation-preview/room-1?return_to=%2Frenovations'));
    expect(fetchMock.mock.calls.some(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer history-token')).toBe(true);
  });
});
