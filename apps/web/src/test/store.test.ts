import {beforeEach, describe, expect, it} from 'vitest';
import {formatMoney, formatRange, readAssessmentHistory, readDefaultProfile, removeAssessmentHistory, readSession, writeDefaultProfile, writeSession} from '../store';

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

  it('migrates the current assessment into local history and removes one record without clearing others', () => {
    writeSession({assessment_id: 'assessment-1', access_token: 'secret'});
    writeSession({assessment_id: 'assessment-2', access_token: 'other'});
    expect(readAssessmentHistory().map(item => item.assessment_id)).toEqual(['assessment-2', 'assessment-1']);
    expect(removeAssessmentHistory('assessment-1').map(item => item.assessment_id)).toEqual(['assessment-2']);
  });

  it('stores a validated default profile independently from assessment snapshots', () => {
    const profile = {mobility: 'cane', fall_history: 'once', living_status: 'alone'} as const;
    writeDefaultProfile(profile);
    expect(readDefaultProfile()).toEqual(profile);
    localStorage.setItem('anju_h5_default_profile_v1', JSON.stringify({mobility: 'unknown'}));
    expect(readDefaultProfile()).toBeNull();
  });
});

describe('money formatting', () => {
  it('formats integer fen and unknown prices', () => {
    expect(formatMoney(129900)).toContain('1,299');
    expect(formatRange(1200, 3600)).toContain('—');
    expect(formatRange(null, 3600)).toBe('需现场询价');
  });
});
