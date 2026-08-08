import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App from '../App';
import {defaultOnboardingState, ONBOARDING_STORAGE_KEY, readOnboardingState} from '../onboarding';

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

  it('starts automatically, skips only the current step, and persists progress', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({analysis: 'ark', capabilities: {h5_camera: true}}));
    render(<App />);

    expect(await screen.findByRole('dialog', {name: '开始一次居家安全检查'})).toHaveTextContent('第 1 / 5 步');
    fireEvent.click(screen.getByRole('button', {name: '跳过这一步'}));

    await waitFor(() => expect(readOnboardingState()).toMatchObject({step: 2, phase: 'profile', skipped_steps: [1]}));
    expect(screen.queryByRole('dialog', {name: '开始一次居家安全检查'})).not.toBeInTheDocument();
  });

  it('reuses an existing assessment when the guide is restarted', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'existing', access_token: 'token', last_route: 'report'}));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true}});
      if (url.endsWith('/api/v2/assessments/existing')) return json({assessment_id: 'existing', profile: {}, rooms: []});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '上传家中照片'}));

    await waitFor(() => expect(window.location.hash).toBe('#/profile'));
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/v2/assessments'))).toBe(false);
    expect(readOnboardingState()).toMatchObject({step: 2, phase: 'profile'});
  });

  it('restarts from My without deleting the current session', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'existing', access_token: 'token', last_route: 'report'}));
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({...defaultOnboardingState(), status: 'completed', step: 5, phase: 'report'}));
    window.location.hash = '#/my';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true}});
      if (url.endsWith('/api/v2/assessments/existing')) return json({assessment_id: 'existing', profile: {}, rooms: []});
      if (url.endsWith('/report')) return json({rooms: [], selected_items: []});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '重新体验新手引导'}));

    await waitFor(() => expect(window.location.hash).toBe('#/home'));
    expect(readOnboardingState()).toMatchObject({status: 'active', step: 1, phase: 'home'});
    expect(JSON.parse(localStorage.getItem('anju_h5_session_v2') || '{}')).toMatchObject({assessment_id: 'existing', access_token: 'token'});
    expect(await screen.findByRole('dialog', {name: '开始一次居家安全检查'})).toBeVisible();
  });

  it('highlights photo upload and the central camera together in step three', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 'token', last_route: 'upload/room-1'}));
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({...defaultOnboardingState(), step: 3, phase: 'capture'}));
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
    expect(screen.getByRole('button', {name: '中央相机'})).toHaveAttribute('data-onboarding-target', 'central-camera');
    expect(container.querySelectorAll('.onboarding-outline')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', {name: '中央相机'}));
    expect(await screen.findByRole('dialog', {name: '开始家庭实时检查'})).toBeVisible();
    expect(screen.queryByRole('dialog', {name: '任选一种采集方式'})).not.toBeInTheDocument();
  });

  it('falls back to the photo target when the central camera is unavailable', async () => {
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'a-1', access_token: 'token'}));
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({...defaultOnboardingState(), step: 3, phase: 'capture'}));
    window.location.hash = '#/upload/room-1';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: false}});
      if (url.endsWith('/api/v2/assessments/a-1')) return json({assessment_id: 'a-1', profile: {}, rooms: [{room_id: 'room-1', room_type: 'bathroom', media: []}]});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    const {container} = render(<App />);
    await screen.findByRole('dialog', {name: '任选一种采集方式'});
    await waitFor(() => expect(screen.getByRole('button', {name: '中央相机暂未开放'})).toBeDisabled());
    await waitFor(() => expect(container.querySelectorAll('.onboarding-outline')).toHaveLength(1));
  });
});
