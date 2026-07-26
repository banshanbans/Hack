import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';

vi.mock('../video', async importOriginal => {
  const original = await importOriginal<typeof import('../video')>();
  return {
    ...original,
    inspectPixels: () => ({brightness: 120, sharpness: 12, hash: '0123456789abcdef'}),
  };
});

import App from '../App';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

describe('H5 camera session recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'stale', access_token: 'old-token', last_route: 'camera'}));
    window.location.hash = '#/camera';
    Object.defineProperty(navigator, 'mediaDevices', {configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({getTracks: () => [{stop: vi.fn()}]}),
    }});
    Object.defineProperties(HTMLVideoElement.prototype, {
      readyState: {configurable: true, get: () => 2},
      videoWidth: {configurable: true, get: () => 640},
      videoHeight: {configurable: true, get: () => 480},
      play: {configurable: true, value: vi.fn().mockResolvedValue(undefined)},
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {configurable: true, value: vi.fn(() => ({
      drawImage: vi.fn(),
      getImageData: () => ({data: new Uint8ClampedArray(640 * 480 * 4)}),
    }))});
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {configurable: true, value: vi.fn(callback => callback(new Blob(['frame'], {type: 'image/jpeg'})))});
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('creates a fresh assessment after the server rejects a stale one', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true, h5_video: true, ios_fair_ar: true}});
      if (url.includes('/assessments/stale/camera/frames:inspect')) return json({code: 'assessment_access_denied', message: 'expired'}, 404);
      if (url.endsWith('/api/v2/assessments') && init?.method === 'POST') return json({assessment_id: 'fresh', access_token: 'new-token'}, 201);
      if (url.includes('/assessments/fresh/camera/frames:inspect')) return json({
        frame_id: 'fresh-frame', temporary: true, quality_usable: false, scene_elements: [], suggestions: [],
        save_as_evidence_recommended: false, prompt_version: 'anju_h5_camera_adaptive_v1',
      });
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '开启后置相机'}));

    await waitFor(() => expect(JSON.parse(localStorage.getItem('anju_h5_session_v2') || '{}')).toMatchObject({
      assessment_id: 'fresh', access_token: 'new-token', last_route: 'camera',
    }));
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/api/v2/assessments') && init?.method === 'POST')).toBe(true);
    expect(await screen.findByText('服务器已更新，已为你重新开始本次检查')).toBeVisible();
  });

  it('shows a short camera overlay and keeps every suggestion in in-memory history', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    localStorage.setItem('anju_h5_session_v2', JSON.stringify({assessment_id: 'fresh', access_token: 'token', last_route: 'camera'}));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/health')) return json({analysis: 'ark', capabilities: {h5_camera: true, h5_video: true, ios_fair_ar: true}});
      if (url.includes('/assessments/fresh/camera/frames:inspect')) return json({
        frame_id: 'frame-1', temporary: true, quality_usable: true, scene_elements: ['walking_path'],
        suggestions: [{
          suggestion_id: 'suggestion-1', risk_code: 'floor_clutter', title: '通道有杂物', short_advice: '先移开通道里的杂物',
          evidence: '通道中有一个纸箱', confidence: .91, needs_manual_check: false, possible_repeat: true,
          region: {type: 'bbox', x: .1, y: .2, width: .3, height: .2}, temporary: true, save_as_evidence_recommended: true,
        }],
        save_as_evidence_recommended: true, prompt_version: 'anju_h5_camera_discovery_v3', rule_version: 'live-camera-rules-2026-07-26-v3',
      });
      return json({code: 'not_found', message: 'not found'}, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: '开启后置相机'}));

    expect((await screen.findAllByText('通道有杂物')).length).toBeGreaterThanOrEqual(2);
    expect((await screen.findAllByText('先移开通道里的杂物')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('1 条 · 刷新清空')).toBeVisible();
    expect(screen.getByText('模型把握度 91%').tagName).toBe('STRONG');
    expect(screen.getByText('可能重复').tagName).toBe('STRONG');
    expect(document.querySelector('.camera-advice-overlay')).not.toBeNull();
    expect(document.querySelector('.camera-region-overlay rect')).not.toBeNull();
    expect(document.querySelector('.camera-region-overlay > img')?.getAttribute('src')).toMatch(/^blob:anju-test-/);
    expect(document.querySelector('.camera-region-number')?.textContent).toBe('1');
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3_000);

    fireEvent.click(screen.getByRole('button', {name: '关闭相机'}));
    expect(document.querySelector('.camera-region-overlay')).toBeNull();
    expect(revokeSpy).toHaveBeenCalled();
  });
});
