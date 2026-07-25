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
});
