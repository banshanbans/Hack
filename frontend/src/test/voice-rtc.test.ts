import {beforeEach, describe, expect, it, vi} from 'vitest';

const rtc = vi.hoisted(() => {
  const engine = {
    on: vi.fn(),
    setVideoSourceType: vi.fn().mockResolvedValue(undefined),
    setExternalVideoTrack: vi.fn().mockResolvedValue(undefined),
    setVideoEncoderConfig: vi.fn().mockResolvedValue(undefined),
    joinRoom: vi.fn().mockResolvedValue(undefined),
    publishStream: vi.fn().mockResolvedValue(undefined),
    unpublishStream: vi.fn().mockResolvedValue(undefined),
    startAudioCapture: vi.fn().mockResolvedValue(undefined),
    stopAudioCapture: vi.fn().mockResolvedValue(undefined),
    sendUserBinaryMessage: vi.fn().mockResolvedValue(undefined),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
  };
  return {
    engine,
    sdk: {
      events: {
        onError: 'error', onConnectionStateChanged: 'connection',
        onRoomBinaryMessageReceived: 'binary', onNetworkQuality: 'network',
      },
      isSupported: vi.fn().mockResolvedValue(true),
      createEngine: vi.fn(() => engine),
      enableDevices: vi.fn().mockResolvedValue({audio: true}),
      destroyEngine: vi.fn(),
    },
  };
});

vi.mock('@volcengine/rtc', () => ({
  default: rtc.sdk,
  StreamIndex: {STREAM_INDEX_MAIN: 0},
  VideoSourceType: {VIDEO_SOURCE_TYPE_EXTERNAL: 1},
  MediaType: {AUDIO: 1, VIDEO: 2},
}));

import {AdvisorVoiceRTC} from '../voiceRtc';
import type {AdvisorRTCConfig} from '../types';

const config: AdvisorRTCConfig = {
  available: true,
  app_id: 'app', room_id: 'room', user_id: 'user', bot_user_id: 'bot', token: 'short-token',
  expires_at: '2026-08-08T12:00:00Z', media_mode: 'audio_video' as const,
  video_available: true, vision_mode: 'rtc_snapshot', snapshot_interval_ms: 900,
  snapshot_height: 720, image_detail: 'low' as const,
};

function decodeControl(input: ArrayBuffer) {
  const bytes = new Uint8Array(input);
  const length = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
  return JSON.parse(new TextDecoder().decode(bytes.slice(8, 8 + length)));
}

describe('AdvisorVoiceRTC video source and explicit image protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const value of Object.values(rtc.engine)) {
      if (typeof value === 'function' && 'mockResolvedValue' in value) value.mockResolvedValue(undefined);
    }
    rtc.sdk.isSupported.mockResolvedValue(true);
    rtc.sdk.createEngine.mockReturnValue(rtc.engine);
    rtc.sdk.enableDevices.mockResolvedValue({audio: true});
  });

  it('publishes the caller-owned camera track without requesting microphone access', async () => {
    const client = new AdvisorVoiceRTC(config, {onState: vi.fn(), onTranscript: vi.fn()});
    const track = {kind: 'video'} as MediaStreamTrack;

    await client.connect({videoTrack: track, microphone: false});

    expect(rtc.engine.setVideoSourceType).toHaveBeenCalledWith(0, 1);
    expect(rtc.engine.setExternalVideoTrack).toHaveBeenCalledWith(0, track);
    expect(rtc.engine.setVideoEncoderConfig).toHaveBeenCalledWith(expect.objectContaining({frameRate: 15, maxKbps: 900}));
    expect(rtc.engine.publishStream).toHaveBeenCalledWith(2);
    expect(rtc.sdk.enableDevices).not.toHaveBeenCalled();
    expect(rtc.engine.startAudioCapture).not.toHaveBeenCalled();

    const networkCallback = rtc.engine.on.mock.calls.find(call => call[0] === 'network')?.[1];
    networkCallback?.(4, 1);
    await Promise.resolve();
    expect(rtc.engine.setVideoEncoderConfig).toHaveBeenLastCalledWith(expect.objectContaining({maxKbps: 500}));
  });

  it('fragments oversized inspection images and explicitly deletes their GroupID', async () => {
    const client = new AdvisorVoiceRTC(config, {onState: vi.fn(), onTranscript: vi.fn()});
    await client.connect({videoTrack: {kind: 'video'} as MediaStreamTrack, microphone: false});
    rtc.engine.sendUserBinaryMessage.mockClear();

    await client.sendInspectionImage({
      inspection_id: 'inspection-1', frame_id: 'frame-1', group_id: 101,
      rtc_message: '仅分析 inspection_id=inspection-1', expires_at: '2026-08-08T12:00:00Z',
      max_chunk_bytes: 60_000,
    }, new Blob(['x'.repeat(90_000)], {type: 'image/jpeg'}));
    await client.deleteInspectionImage(101);

    const controls = rtc.engine.sendUserBinaryMessage.mock.calls.map(call => decodeControl(call[1]));
    const additions = controls.filter(value => value.ImageConfig?.Action === 'add');
    expect(additions.length).toBeGreaterThan(1);
    expect(additions.every(value => value.ImageConfig.GroupID === 101)).toBe(true);
    expect(additions.at(-1)?.Message).toContain('inspection_id=inspection-1');
    expect(controls.at(-1)?.ImageConfig).toEqual({Action: 'delete', GroupID: 101});
  });
});
