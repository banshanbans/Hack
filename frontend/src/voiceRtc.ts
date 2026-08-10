import type {AdvisorRTCConfig, PreparedCameraInspection} from './types';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnecting' | 'error';

export interface VoiceTranscript {
  role: 'user' | 'assistant';
  text: string;
  final: boolean;
  eventId: string;
}

interface VoiceCallbacks {
  onState: (state: VoiceState) => void;
  onTranscript: (value: VoiceTranscript) => void;
  onPlaybackBlocked?: () => void;
}

interface ConnectOptions {
  videoTrack?: MediaStreamTrack;
  microphone?: boolean;
}

function encodeTLV(value: string, type: string): ArrayBuffer {
  const typeBytes = new Uint8Array(4);
  for (let index = 0; index < Math.min(4, type.length); index += 1) typeBytes[index] = type.charCodeAt(index);
  const data = new TextEncoder().encode(value);
  const output = new Uint8Array(8 + data.length);
  output.set(typeBytes, 0);
  output[4] = (data.length >> 24) & 0xff;
  output[5] = (data.length >> 16) & 0xff;
  output[6] = (data.length >> 8) & 0xff;
  output[7] = data.length & 0xff;
  output.set(data, 8);
  return output.buffer;
}

function decodeTLV(input: ArrayBuffer): {type: string; value: string} | null {
  if (input.byteLength < 8) return null;
  const bytes = new Uint8Array(input);
  const type = String.fromCharCode(...bytes.slice(0, 4));
  const length = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
  if (length > input.byteLength - 8) return null;
  return {type, value: new TextDecoder().decode(bytes.slice(8, 8 + length))};
}

export class AdvisorVoiceRTC {
  private engine: any = null;
  private sdk: any = null;
  private connected = false;
  private microphoneEnabled = false;
  private videoPublished = false;
  private weakVideoMode = false;
  private videoEncoderConfigs: {normal: Record<string, unknown>; weak: Record<string, unknown>} | null = null;
  private sequence = 0;
  private finalKeys = new Set<string>();
  private blockedAudioPlayback: {userId: string; mediaType: number; streamIndex?: number; playerId?: string} | null = null;
  private readonly playbackGestureHandler = () => { void this.resumeBlockedAudioPlayback(); };

  constructor(private readonly config: AdvisorRTCConfig, private readonly callbacks: VoiceCallbacks) {}

  get isConnected(): boolean { return this.connected; }
  get isMicrophoneEnabled(): boolean { return this.microphoneEnabled; }

  async connect(options: ConnectOptions = {}): Promise<void> {
    const {app_id: appId, room_id: roomId, user_id: userId, token} = this.config;
    if (!this.config.available || !appId || !roomId || !userId || !token) throw new Error('voice_not_configured');
    this.callbacks.onState('connecting');
    const rtcModule = await import('@volcengine/rtc');
    const {default: VERTC} = rtcModule;
    this.sdk = VERTC;
    if (!await VERTC.isSupported()) throw new Error('voice_not_supported');
    this.engine = VERTC.createEngine(appId);
    this.engine.on(VERTC.events.onError, () => this.callbacks.onState('error'));
    this.engine.on(VERTC.events.onConnectionStateChanged, (event: {state?: number}) => {
      if (event?.state === 3) this.callbacks.onState('listening');
      else if (this.connected) this.callbacks.onState('reconnecting');
    });
    this.engine.on(VERTC.events.onNetworkQuality, (uplinkQuality: number) => {
      void this.updateVideoForNetwork(Number(uplinkQuality));
    });
    this.engine.on(VERTC.events.onRoomBinaryMessageReceived, (event: {userId: string; message: ArrayBuffer}) => this.handleBinary(event));
    this.engine.on(VERTC.events.onAutoplayFailed, (event: {
      userId?: string; kind?: string; mediaType?: number; streamIndex?: number; playerId?: string;
    }) => {
      if (event?.kind !== 'audio' || !event.userId) return;
      this.blockedAudioPlayback = {
        userId: event.userId,
        mediaType: event.mediaType ?? rtcModule.MediaType.AUDIO,
        streamIndex: event.streamIndex,
        playerId: event.playerId,
      };
      this.armPlaybackResume();
      this.callbacks.onPlaybackBlocked?.();
    });
    if (options.videoTrack && this.config.video_available) {
      await this.engine.setVideoSourceType(
        rtcModule.StreamIndex.STREAM_INDEX_MAIN,
        rtcModule.VideoSourceType.VIDEO_SOURCE_TYPE_EXTERNAL,
      );
      await this.engine.setExternalVideoTrack(rtcModule.StreamIndex.STREAM_INDEX_MAIN, options.videoTrack);
      const settings = options.videoTrack.getSettings?.() || {};
      const sourceWidth = Number(settings.width) || 1280;
      const sourceHeight = Number(settings.height) || 720;
      const scaled = (longEdge: number, frameRate: number, maxKbps: number) => {
        const scale = longEdge / Math.max(sourceWidth, sourceHeight);
        return {
          width: Math.max(2, Math.round(sourceWidth * scale / 2) * 2),
          height: Math.max(2, Math.round(sourceHeight * scale / 2) * 2),
          frameRate, maxKbps, contentHint: 'detail',
        };
      };
      this.videoEncoderConfigs = {
        normal: scaled(720, 15, 900),
        weak: scaled(540, 10, 500),
      };
      await this.engine.setVideoEncoderConfig(this.videoEncoderConfigs.normal);
    }
    await this.engine.joinRoom(token, roomId, {userId, extraInfo: JSON.stringify({call_scene: 'ANJU_ADVISOR'})}, {
      isAutoPublish: false,
      isAutoSubscribeAudio: true,
      isAutoSubscribeVideo: false,
      roomProfileType: 5,
    });
    this.connected = true;
    if (options.videoTrack && this.config.video_available) {
      await this.engine.publishStream(rtcModule.MediaType.VIDEO);
      this.videoPublished = true;
    }
    if (options.microphone) await this.enableMicrophone();
    else this.callbacks.onState('idle');
  }

  async enableMicrophone(): Promise<void> {
    if (!this.connected || !this.engine || this.microphoneEnabled) return;
    const permission = await this.sdk.enableDevices({video: false, audio: true});
    if (!permission.audio) throw permission.audioExceptionError || new Error('microphone_denied');
    await this.engine.startAudioCapture();
    await this.engine.publishStream(1);
    this.microphoneEnabled = true;
    this.callbacks.onState('listening');
  }

  async disableMicrophone(): Promise<void> {
    if (!this.connected || !this.engine || !this.microphoneEnabled) return;
    try {
      await this.engine.unpublishStream(1);
      await this.engine.stopAudioCapture();
    } finally {
      this.microphoneEnabled = false;
      this.callbacks.onState('idle');
    }
  }

  async interrupt(): Promise<void> {
    if (!this.connected || !this.engine || !this.config.bot_user_id) return;
    await this.engine.sendUserBinaryMessage(this.config.bot_user_id, encodeTLV(JSON.stringify({
      Command: 'interrupt', InterruptMode: 1, Message: '',
    }), 'ctrl'));
    this.callbacks.onState('listening');
  }

  private armPlaybackResume(): void {
    window.addEventListener('pointerdown', this.playbackGestureHandler, {capture: true, once: true});
    window.addEventListener('keydown', this.playbackGestureHandler, {capture: true, once: true});
  }

  private removePlaybackResumeListeners(): void {
    window.removeEventListener('pointerdown', this.playbackGestureHandler, true);
    window.removeEventListener('keydown', this.playbackGestureHandler, true);
  }

  private async resumeBlockedAudioPlayback(): Promise<void> {
    const blocked = this.blockedAudioPlayback;
    if (!blocked || !this.engine) return;
    this.removePlaybackResumeListeners();
    try {
      await this.engine.play(blocked.userId, blocked.mediaType, blocked.streamIndex, blocked.playerId);
      if (this.blockedAudioPlayback === blocked) this.blockedAudioPlayback = null;
    } catch {
      if (this.blockedAudioPlayback === blocked) this.armPlaybackResume();
    }
  }

  async sendInspectionImage(prepared: PreparedCameraInspection, blob: Blob): Promise<void> {
    if (!this.connected || !this.engine || !this.config.bot_user_id) throw new Error('rtc_not_connected');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('image_read_failed'));
      reader.readAsDataURL(blob);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const maxBytes = Math.max(8_000, Math.min(60_000, prepared.max_chunk_bytes || 60_000));
    // Reserve room for the JSON envelope and the TLV header.
    const chunkSize = Math.max(4_000, maxBytes - 2_000);
    const chunks = Array.from({length: Math.ceil(base64.length / chunkSize)}, (_, index) => (
      base64.slice(index * chunkSize, (index + 1) * chunkSize)
    ));
    for (let index = 0; index < chunks.length; index += 1) {
      await this.sendControl({
        Command: 'ExternalTextToLLM',
        InterruptMode: 3,
        Message: index === chunks.length - 1 ? prepared.rtc_message : '',
        ImageConfig: {
          Action: 'add',
          GroupID: prepared.group_id,
          ImageType: 'base64',
          Images: [chunks[index]],
          IsPartial: chunks.length > 1,
          FragmentID: index + 1,
          FragmentCount: chunks.length,
          ImageDetail: this.config.image_detail || 'low',
        },
      });
    }
  }

  async deleteInspectionImage(groupId: number): Promise<void> {
    if (!this.connected || !this.engine || !this.config.bot_user_id) return;
    await this.sendControl({
      Command: 'ExternalTextToLLM', InterruptMode: 3, Message: '清理本轮临时检查画面。',
      ImageConfig: {Action: 'delete', GroupID: groupId},
    });
  }

  async disconnect(): Promise<void> {
    if (!this.engine) return;
    try {
      if (this.microphoneEnabled) {
        await this.engine.unpublishStream(1).catch(() => undefined);
        await this.engine.stopAudioCapture().catch(() => undefined);
      }
      if (this.videoPublished) await this.engine.unpublishStream(2).catch(() => undefined);
      await this.engine.leaveRoom();
    } finally {
      this.removePlaybackResumeListeners();
      this.blockedAudioPlayback = null;
      this.sdk?.destroyEngine(this.engine);
      this.engine = null;
      this.sdk = null;
      this.connected = false;
      this.microphoneEnabled = false;
      this.videoPublished = false;
      this.videoEncoderConfigs = null;
      this.weakVideoMode = false;
      this.callbacks.onState('idle');
    }
  }

  private async sendControl(value: Record<string, unknown>): Promise<void> {
    await this.engine.sendUserBinaryMessage(
      this.config.bot_user_id,
      encodeTLV(JSON.stringify(value), 'ctrl'),
    );
  }

  private async updateVideoForNetwork(uplinkQuality: number): Promise<void> {
    if (!this.engine || !this.videoEncoderConfigs) return;
    const weak = this.weakVideoMode ? uplinkQuality > 2 : uplinkQuality >= 4;
    if (weak === this.weakVideoMode) return;
    this.weakVideoMode = weak;
    try {
      await this.engine.setVideoEncoderConfig(weak ? this.videoEncoderConfigs.weak : this.videoEncoderConfigs.normal);
    } catch {
      // SDK 自身仍会自适应码率；编码档位切换失败不终止扫描。
    }
  }

  private handleBinary(event: {userId: string; message: ArrayBuffer}) {
    const decoded = decodeTLV(event.message);
    if (!decoded) return;
    try {
      const value = JSON.parse(decoded.value);
      if (decoded.type === 'conv') {
        const code = Number(value?.Stage?.Code);
        if (code === 1) this.callbacks.onState('listening');
        else if (code === 2) this.callbacks.onState('thinking');
        else if (code === 3) this.callbacks.onState('speaking');
        else if (code === 4 || code === 5) this.callbacks.onState('listening');
        return;
      }
      if (decoded.type !== 'subv') return;
      const subtitle = value?.data?.[0];
      const text = String(subtitle?.text || '').trim();
      if (!text) return;
      const final = Boolean(subtitle?.definite || subtitle?.paragraph);
      const role: 'user' | 'assistant' = subtitle?.userId === this.config.user_id ? 'user' : 'assistant';
      const key = `${role}:${subtitle?.paragraph ?? ''}:${text}`;
      if (final && this.finalKeys.has(key)) return;
      if (final) this.finalKeys.add(key);
      this.sequence += 1;
      this.callbacks.onTranscript({role, text, final, eventId: `${role}-${subtitle?.paragraph ?? this.sequence}-${this.sequence}`});
    } catch {
      // Ignore malformed provider messages; business state never depends on them.
    }
  }
}
