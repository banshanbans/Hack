import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import App, {resolveCheckDestination} from '../App';
import type {Assessment, SessionState} from '../types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
const session = (last_route?: string): SessionState => ({assessment_id: 'a-1', access_token: 'token', last_route});
const assessment = (complete: boolean, roomId = 'room-1') => ({
  assessment_id: 'a-1',
  profile: complete ? {mobility: 'normal', fall_history: 'none', living_status: 'with_family'} : {},
  rooms: [{room_id: roomId, room_type: 'bathroom', status: 'collecting_media', media: []}],
}) as unknown as Assessment;

describe('fixed primary navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = '#/home';
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('restores only valid check routes and falls back by profile state', () => {
    expect(resolveCheckDestination(session('upload/room-1'), assessment(true))).toBe('/upload/room-1');
    expect(resolveCheckDestination(session('upload/missing'), assessment(true))).toBe('/rooms');
    expect(resolveCheckDestination(session('camera'), assessment(false))).toBe('/profile');
    expect(resolveCheckDestination(session('advisor/room-1'), assessment(true))).toBe('/rooms');
    expect(resolveCheckDestination(session('share/token'), assessment(true))).toBe('/rooms');
    expect(resolveCheckDestination(null, assessment(false))).toBeNull();
  });

  it('creates a photo assessment from Home and renders three primary tabs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true}});
      if (url.endsWith('/api/v2/assessments') && init?.method === 'POST') return json({assessment_id: 'created', access_token: 'created-token'}, 201);
      if (url.endsWith('/api/v2/assessments/created')) return json({assessment_id: 'created', profile: {}, rooms: []});
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', {name: '上传家中照片'}));

    await waitFor(() => expect(window.location.hash).toBe('#/profile'));
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/api/v2/assessments') && init?.method === 'POST')).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', {name: '首页'})).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('button', {name: '改造方案'})).toBeVisible();
    expect(screen.getByRole('navigation', {name: '主导航'}).querySelectorAll('button')).toHaveLength(3);
  });
});
