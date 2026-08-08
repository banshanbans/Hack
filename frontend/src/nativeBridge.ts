export const NATIVE_CAPTURE_RESULT_EVENT = 'anju:native-capture-result';

export type NativeCommand = 'capture_photo' | 'start_live_scan' | 'cancel_native_capture';
export type NativeCaptureMode = 'spatial_ar' | 'camera_2d' | 'photo';
export type NativeCaptureStatus = 'completed' | 'partial' | 'cancelled' | 'failed';

export interface NativeAdvisorEventConfig {
  websocket_path: string;
  token: string;
  expires_at: string;
}

export interface NativeCaptureRequest {
  request_id: string;
  assessment_id: string;
  access_token: string;
  room_id: string;
  room_type: string;
  remaining_slots: number;
  camera_session_id?: string;
  advisor_session_id?: string;
  advisor_events?: NativeAdvisorEventConfig;
  advisor_client_instance_id?: string;
  advisor_queue_ticket_id?: string;
}

export interface NativeCaptureResult {
  request_id: string;
  status: NativeCaptureStatus;
  room_id: string;
  capture_mode: NativeCaptureMode;
  uploaded_media_ids: string[];
  failed_count: number;
  error_code: string | null;
  camera_session_id?: string | null;
}

declare global {
  interface Window {
    __ANJU_NATIVE__?: {
      bridge_version: number;
      capabilities: {photo_capture?: boolean; live_scan?: boolean; spatial_tracking?: boolean};
    };
    webkit?: {messageHandlers?: {anjuNative?: {postMessage: (message: unknown) => void}}};
  }
}

export function nativeCapability(capability: 'photo_capture' | 'live_scan'): boolean {
  return window.__ANJU_NATIVE__?.bridge_version === 1
    && window.__ANJU_NATIVE__?.capabilities?.[capability] === true
    && typeof window.webkit?.messageHandlers?.anjuNative?.postMessage === 'function';
}

export function invokeNative(command: NativeCommand, request: NativeCaptureRequest): boolean {
  const required = command === 'capture_photo' ? 'photo_capture' : 'live_scan';
  if (command !== 'cancel_native_capture' && !nativeCapability(required)) return false;
  const handler = window.webkit?.messageHandlers?.anjuNative;
  if (!handler) return false;
  handler.postMessage({bridge_version: 1, command, ...request});
  return true;
}

export function nativeRequestId(): string {
  return globalThis.crypto?.randomUUID?.() || `native-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isNativeCaptureResult(value: unknown): value is NativeCaptureResult {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<NativeCaptureResult>;
  return typeof item.request_id === 'string'
    && typeof item.room_id === 'string'
    && ['completed', 'partial', 'cancelled', 'failed'].includes(String(item.status))
    && ['spatial_ar', 'camera_2d', 'photo'].includes(String(item.capture_mode))
    && Array.isArray(item.uploaded_media_ids)
    && item.uploaded_media_ids.every(id => typeof id === 'string')
    && Number.isInteger(item.failed_count);
}
