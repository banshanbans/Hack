import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from '../App';
import {defaultOnboardingState, LEGACY_ONBOARDING_STORAGE_KEY, ONBOARDING_STORAGE_KEY, readOnboardingState} from '../onboarding';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

describe('versioned onboarding state', () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = '#/home';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 20, y: 100, top: 100, left: 20, right: 320, bottom: 160, width: 300, height: 60, toJSON: () => ({}),
    }));
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('starts automatically, skips only the current phase, and persists progress', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({analysis: 'ark', capabilities: {h5_camera: true}}));
    render(<App />);

    expect(await screen.findByRole('dialog', {name: '开始一次居家安全检查'})).toHaveTextContent('第 1 / 5 步');
    expect(document.querySelectorAll('[data-onboarding-target="home-ar-entry"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-onboarding-target="home-photo-entry"]')).toHaveLength(1);
    expect(document.querySelectorAll('.onboarding-outline')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', {name: '跳过本步'}));

    await waitFor(() => expect(readOnboardingState()).toMatchObject({phase: 'home', phase_status: {home: 'skipped'}}));
    expect(screen.queryByRole('dialog', {name: '开始一次居家安全检查'})).not.toBeInTheDocument();
  });

  it('lets users acknowledge a tip without advancing or skipping the guided step', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({analysis: 'ark', capabilities: {h5_camera: true}}));
    render(<App />);

    expect(await screen.findByRole('dialog', {name: '开始一次居家安全检查'})).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: '知道了，继续操作'}));

    expect(screen.queryByRole('dialog', {name: '开始一次居家安全检查'})).not.toBeInTheDocument();
    expect(readOnboardingState()).toMatchObject({phase: 'home', phase_status: {home: 'acknowledged'}});
    cleanup();
    render(<App />);
    expect(screen.queryByRole('dialog', {name: '开始一次居家安全检查'})).not.toBeInTheDocument();
  });

  it('migrates completed and in-progress v1 records to phase results', () => {
    localStorage.setItem(LEGACY_ONBOARDING_STORAGE_KEY, JSON.stringify({version: 1, status: 'active', step: 3, phase: 'analyze', skipped_steps: [2]}));
    expect(readOnboardingState()).toMatchObject({
      version: 2,
      status: 'active',
      phase: 'analyze',
      phase_status: {home: 'completed', profile: 'skipped', rooms: 'skipped', capture: 'completed'},
    });
    expect(localStorage.getItem(LEGACY_ONBOARDING_STORAGE_KEY)).toBeNull();

    localStorage.clear();
    localStorage.setItem(LEGACY_ONBOARDING_STORAGE_KEY, JSON.stringify({version: 1, status: 'completed', step: 5, phase: 'report', skipped_steps: []}));
    expect(readOnboardingState()).toMatchObject({status: 'completed', phase: 'report', phase_status: {report: 'completed'}});
  });

  it('reuses an existing assessment when the guide is restarted', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'existing', access_token: 'token', last_route: 'profile'}));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true}});
      if (url.endsWith('/api/v2/assessments/existing')) return json({assessment_id: 'existing', profile: {}, rooms: []});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '上传家中照片'}));
    fireEvent.click(await screen.findByRole('button', {name: '继续本次检查'}));

    await waitFor(() => expect(window.location.hash).toBe('#/profile'));
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/v2/assessments'))).toBe(false);
    expect(readOnboardingState()).toMatchObject({phase: 'profile', phase_status: {home: 'completed'}});
  });

  it('keeps My focused on profile and report sharing without onboarding controls', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'existing', access_token: 'token', last_route: 'report'}));
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({...defaultOnboardingState(), status: 'completed', phase: 'report'}));
    window.location.hash = '#/my';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true}});
      if (url.endsWith('/api/v2/assessments/existing')) return json({assessment_id: 'existing', profile: {}, rooms: []});
      if (url.endsWith('/report')) return json({rooms: [], selected_items: []});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    expect(await screen.findByRole('heading', {name: '我的'})).toBeVisible();
    expect(screen.queryByRole('button', {name: '重新体验新手引导'})).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('anju_h5_session_v2') || '{}')).toMatchObject({assessment_id: 'existing', access_token: 'token'});
  });

  it('highlights the photo source in the capture phase without a camera tab', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 'token', last_route: 'upload/room-1'}));
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({...defaultOnboardingState(), phase: 'capture'}));
    window.location.hash = '#/upload/room-1';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true}});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({
        assessment_id: 'a-1', profile: {mobility: 'normal', fall_history: 'none', living_status: 'with_family'},
        rooms: [{room_id: 'room-1', room_type: 'bathroom', status: 'collecting_media', media: []}],
      });
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    const {container} = render(<App />);
    const guide = await screen.findByRole('dialog', {name: '任选一种采集方式'});
    expect(guide).toHaveTextContent('上传 1—3 张清晰照片');
    expect(container.querySelector('[data-onboarding-target="capture-source"]')).not.toBeNull();
    expect(screen.queryByRole('button', {name: '相机'})).not.toBeInTheDocument();
    expect(container.querySelectorAll('.onboarding-outline')).toHaveLength(1);
  });

  it('keeps the photo target when realtime camera capability is unavailable', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 'token'}));
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({...defaultOnboardingState(), phase: 'capture'}));
    window.location.hash = '#/upload/room-1';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: false}});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', profile: {}, rooms: [{room_id: 'room-1', room_type: 'bathroom', media: []}]});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    const {container} = render(<App />);
    await screen.findByRole('dialog', {name: '任选一种采集方式'});
    expect(screen.queryByRole('button', {name: '相机暂未开放'})).not.toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('.onboarding-outline')).toHaveLength(1));
  });

  it('finishes the whole guide when the final report phase is skipped', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 'token', last_route: 'report'}));
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({...defaultOnboardingState(), phase: 'report'}));
    window.location.hash = '#/report';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true}});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', profile: {}, rooms: []});
      if (url.endsWith('/report')) return json({
        status: 'in_progress', checked_room_count: 0, planned_room_count: 0, coverage_percent: 0,
        score_title: '当前已检查区域安全参考分', assessed_area_score: null, household_score: null,
        rooms: [], selected_items: [], budget: {currency: 'CNY', total_min: 0, total_max: 0, material_min: 0, material_max: 0, labor_min: 0, labor_max: 0, unknown_items: []},
        projected_score: null, price_disclaimer: '仅供参考',
      });
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    expect(await screen.findByRole('dialog', {name: '在报告中查看预算与进度'})).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: '跳过本步'}));

    await waitFor(() => expect(readOnboardingState()).toMatchObject({status: 'completed', phase: 'report', phase_status: {report: 'skipped'}}));
  });
});
