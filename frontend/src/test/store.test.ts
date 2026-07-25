import {beforeEach, describe, expect, it} from 'vitest';
import {formatMoney, formatRange, readSession, writeSession} from '../store';

describe('session persistence', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the v2 storage contract and current route', () => {
    const session = {assessment_id: 'assessment-1', access_token: 'secret', last_route: 'upload/room-1'};
    writeSession(session);
    expect(readSession()).toEqual(session);
    expect(Object.keys(JSON.parse(localStorage.getItem('anju_h5_session_v2') || '{}')).sort())
      .toEqual(['access_token', 'assessment_id', 'last_route']);
  });

  it('clears invalid or deleted sessions safely', () => {
    localStorage.setItem('anju_h5_session_v2', '{broken');
    expect(readSession()).toBeNull();
    writeSession(null);
    expect(localStorage.getItem('anju_h5_session_v2')).toBeNull();
  });
});

describe('money formatting', () => {
  it('formats integer fen and unknown prices', () => {
    expect(formatMoney(129900)).toContain('1,299');
    expect(formatRange(1200, 3600)).toContain('—');
    expect(formatRange(null, 3600)).toBe('需现场询价');
  });
});
