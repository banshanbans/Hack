import {readSession, SESSION_INVALIDATED_EVENT, writeSession} from './store';
import type {
  AnalysisStatus,
  Assessment,
  AssessmentReport,
  ElderProfile,
  InputMode,
  RoomAssessment,
  RoomResult,
  RoomType,
  MediaUploadMetadata,
  RiskRegion,
  RenovationPreview,
  RenovationPreviewContext,
  SolutionsResult,
  CameraInspectionResult,
  ServerCapabilities,
  AdvisorBootstrap,
  AdvisorContextRef,
  AdvisorTurn,
  MediaAsset,
  PreparedCameraInspection,
  AdvisorRTCQueueTicket,
  AdvisorEventConfig,
} from './types';

async function request<T>(path: string, options: RequestInit = {}, authenticated = true): Promise<T> {
  const headers = new Headers(options.headers || {});
  const session = readSession();
  if (authenticated && session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  const response = await fetch(path, {...options, headers});
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) {
    const error = new Error(data?.message || '网络请求没有完成') as Error & {code?: string; status?: number};
    error.code = data?.code || `http_${response.status}`;
    error.status = response.status;
    if (authenticated && error.code === 'assessment_access_denied') {
      writeSession(null);
      window.dispatchEvent(new Event(SESSION_INVALIDATED_EVENT));
    }
    throw error;
  }
  return data as T;
}

function json(method: string, body?: unknown): RequestInit {
  return {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body ?? {})};
}

function assessmentPath(suffix = ''): string {
  const session = readSession();
  if (!session) throw new Error('请先开始一次检查');
  return `/api/v2/assessments/${session.assessment_id}${suffix}`;
}

export const api = {
  health: () => request<{status: string; analysis: string; version: string; capabilities?: ServerCapabilities}>('/health', {}, false),
  async analytics(eventName: string, roomId?: string, payload: Record<string, unknown> = {}) {
    return request<{accepted: boolean}>(
      assessmentPath('/analytics/events'), json('POST', {event_name: eventName, room_id: roomId, payload}),
    );
  },
  async createAssessment(input_mode: InputMode) {
    const value = await request<{assessment_id: string; access_token: string}>('/api/v2/assessments', json('POST', {input_mode}), false);
    writeSession({assessment_id: value.assessment_id, access_token: value.access_token});
    return value;
  },
  getAssessment: (signal?: AbortSignal) => request<Assessment>(assessmentPath(), {signal}),
  saveProfile: (profile: ElderProfile) => request<ElderProfile>(assessmentPath('/profile'), json('PUT', profile)),
  savePlannedRooms: (planned_rooms: RoomType[]) => request<{planned_rooms: RoomType[]}>(assessmentPath('/planned-rooms'), json('PUT', {planned_rooms})),
  createRoom: (room_type: RoomType) => request<RoomAssessment>(assessmentPath('/rooms'), json('POST', {room_type})),
  uploadMedia: (roomId: string, blob: Blob, width: number, height: number, metadata?: MediaUploadMetadata) => request<MediaAsset>(assessmentPath(`/rooms/${roomId}/media`), {
    method: 'POST',
    headers: {
      'Content-Type': blob.type || 'image/jpeg', 'X-Image-Width': String(width), 'X-Image-Height': String(height),
      ...(metadata ? {
        'X-Media-Source-Kind': metadata.sourceKind,
        ...(metadata.sourceId ? {'X-Media-Source-Id': metadata.sourceId} : {}),
        ...(metadata.frameIndex !== undefined ? {'X-Media-Frame-Index': String(metadata.frameIndex)} : {}),
        ...(metadata.capturedAtMs !== undefined ? {'X-Media-Captured-At-Ms': String(metadata.capturedAtMs)} : {}),
        ...(metadata.orientation ? {'X-Media-Orientation': metadata.orientation} : {}),
        ...(metadata.perceptualHash ? {'X-Media-Perceptual-Hash': metadata.perceptualHash} : {}),
        ...(metadata.zoneId ? {'X-Media-Zone-Id': metadata.zoneId} : {}),
      } : {}),
    },
    body: blob,
  }),
  deleteMedia: (roomId: string, mediaId: string) => request<void>(assessmentPath(`/rooms/${roomId}/media/${mediaId}`), {method: 'DELETE'}),
  mediaBlob: (path: string, signal?: AbortSignal) => request<Blob>(path, {signal}),
  inspectCamera: (roomId: string, blob: Blob, width: number, height: number, context: {frame_id: string; previous_summary: string[]; source_kind?: 'h5_camera_frame' | 'ios_camera_frame'; orientation?: 'up' | 'right' | 'down' | 'left'; camera_session_id?: string}, signal?: AbortSignal) => request<CameraInspectionResult>(assessmentPath(`/rooms/${roomId}/camera/frames:inspect`), {
    method: 'POST', signal,
    headers: {'Content-Type': blob.type || 'image/jpeg', 'X-Image-Width': String(width), 'X-Image-Height': String(height), 'X-Camera-Context': JSON.stringify(context)},
    body: blob,
  }),
  createCameraSession: (roomId: string) => request<{camera_session_id: string; expires_at: string}>(assessmentPath(`/rooms/${roomId}/camera/sessions`), {method: 'POST'}),
  prepareCameraInspection: (roomId: string, cameraSessionId: string, value: {
    frame_id: string;
    captured_at_ms: number;
    width: number;
    height: number;
    orientation: 'up' | 'right' | 'down' | 'left';
    perceptual_hash: string;
    quality: {brightness: number; sharpness: number; motion: number};
  }) => request<PreparedCameraInspection>(assessmentPath(`/rooms/${roomId}/camera/sessions/${cameraSessionId}/frames:prepare-inspection`), json('POST', value)),
  completeCameraSession: (roomId: string, cameraSessionId: string, mediaIds: string[]) => request<{camera_session_id: string; status: string; media_ids: string[]}>(assessmentPath(`/rooms/${roomId}/camera/sessions/${cameraSessionId}:complete`), json('POST', {media_ids: mediaIds})),
  createAdvisorSession: (roomId: string, value: {camera_session_id?: string; context_refs?: AdvisorContextRef} = {}) => request<AdvisorBootstrap>(assessmentPath(`/rooms/${roomId}/advisor/sessions`), json('POST', value)),
  advisorTurns: (roomId: string, advisorSessionId: string, signal?: AbortSignal) => request<{turns: AdvisorTurn[]; next_cursor: string | null}>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/turns`), {signal}),
  issueAdvisorEventToken: (roomId: string, advisorSessionId: string) => request<AdvisorEventConfig>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/events-token`), {method: 'POST'}),
  joinAdvisorRTCQueue: (roomId: string, advisorSessionId: string, clientInstanceId: string, mode: 'audio' | 'audio_video') => request<AdvisorRTCQueueTicket>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/rtc-queue`), json('POST', {client_instance_id: clientInstanceId, mode})),
  advisorRTCQueueStatus: (roomId: string, advisorSessionId: string, ticketId: string, clientInstanceId: string, signal?: AbortSignal) => request<AdvisorRTCQueueTicket>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/rtc-queue/${ticketId}`), {signal, headers: {'X-Advisor-Client-ID': clientInstanceId}}),
  heartbeatAdvisorRTCQueue: (roomId: string, advisorSessionId: string, ticketId: string, clientInstanceId: string) => request<AdvisorRTCQueueTicket>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/rtc-queue/${ticketId}/heartbeat`), {method: 'POST', headers: {'X-Advisor-Client-ID': clientInstanceId}}),
  cancelAdvisorRTCQueue: (roomId: string, advisorSessionId: string, ticketId: string, clientInstanceId: string) => request<void>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/rtc-queue/${ticketId}`), {method: 'DELETE', headers: {'X-Advisor-Client-ID': clientInstanceId}}),
  startAdvisorVoice: (roomId: string, advisorSessionId: string, clientInstanceId: string, queueTicketId: string) => request<AdvisorBootstrap['rtc']>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/voice`), {method: 'POST', headers: {'X-Advisor-Client-ID': clientInstanceId, 'X-Advisor-Queue-Ticket': queueTicketId}}),
  startAdvisorRealtime: (roomId: string, advisorSessionId: string, clientInstanceId: string, queueTicketId: string) => request<AdvisorBootstrap['rtc']>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/realtime`), {method: 'POST', headers: {'X-Advisor-Client-ID': clientInstanceId, 'X-Advisor-Queue-Ticket': queueTicketId}}),
  advisorMessage: (roomId: string, advisorSessionId: string, text: string, contextRefs: AdvisorContextRef, requestedAction?: {tool_name: string; arguments?: Record<string, string>}) => request<{user_turn: AdvisorTurn; assistant_turn: AdvisorTurn}>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/messages`), json('POST', {text, context_refs: contextRefs, requested_action: requestedAction})),
  advisorTranscript: (roomId: string, advisorSessionId: string, value: {role: 'user' | 'assistant'; text: string; provider_event_id: string; context_refs: AdvisorContextRef}) => request<AdvisorTurn>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/transcripts`), json('POST', value)),
  decideAdvisorConfirmation: (roomId: string, advisorSessionId: string, confirmationId: string, approved: boolean) => request<{confirmation_id: string; status: string; turn: AdvisorTurn; result?: unknown}>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}/confirmations/${confirmationId}`), json('POST', {approved})),
  endAdvisorSession: (roomId: string, advisorSessionId: string) => request<void>(assessmentPath(`/rooms/${roomId}/advisor/sessions/${advisorSessionId}`), {method: 'DELETE'}),
  analyze: (roomId: string) => request<{job_id: string; status: string; stage: string; reused?: boolean}>(assessmentPath(`/rooms/${roomId}:analyze`), {method: 'POST'}),
  status: (roomId: string, signal?: AbortSignal) => request<AnalysisStatus>(assessmentPath(`/rooms/${roomId}/status`), {signal}),
  result: (roomId: string, signal?: AbortSignal) => request<RoomResult>(assessmentPath(`/rooms/${roomId}/result`), {signal}),
  renovationPreviewContext: (roomId: string, signal?: AbortSignal) => request<RenovationPreviewContext>(assessmentPath(`/rooms/${roomId}/renovation-preview-context`), {signal}),
  createRenovationPreview: (roomId: string, sourceMediaId: string) => request<RenovationPreview>(assessmentPath(`/rooms/${roomId}/renovation-previews`), json('POST', {source_media_id: sourceMediaId})),
  renovationPreview: (roomId: string, previewId: string, signal?: AbortSignal) => request<RenovationPreview>(assessmentPath(`/rooms/${roomId}/renovation-previews/${previewId}`), {signal}),
  selectRenovationPreview: (roomId: string, previewId: string) => request<RenovationPreview>(assessmentPath(`/rooms/${roomId}/renovation-previews/${previewId}:select`), {method: 'PUT'}),
  feedback: (riskId: string, feedback: string) => request<{score: number}>(assessmentPath(`/risks/${riskId}/feedback`), json('POST', {feedback})),
  region: (riskId: string, region: RiskRegion) => request<{region: RiskRegion}>(assessmentPath(`/risks/${riskId}/region`), json('PUT', {region})),
  solutions: (riskId: string, signal?: AbortSignal) => request<SolutionsResult>(assessmentPath(`/risks/${riskId}/solutions`), {signal}),
  selectSolution: (riskId: string, solutionId: string) => request<AssessmentReport>(assessmentPath(`/risks/${riskId}/selected-solution`), json('PUT', {solution_package_id: solutionId})),
  removeSolution: (riskId: string) => request<void>(assessmentPath(`/risks/${riskId}/selected-solution`), {method: 'DELETE'}),
  report: (signal?: AbortSignal) => request<AssessmentReport>(assessmentPath('/report'), {signal}),
  complete: () => request<AssessmentReport>(assessmentPath(':complete'), {method: 'POST'}),
  deleteAssessment: () => request<void>(assessmentPath(), {method: 'DELETE'}),
};

export function parseAdvisorEvent(data: unknown): {
  type?: string;
  turn?: AdvisorTurn;
  suggestion?: import('./types').CameraSuggestion;
  inspection_id?: string;
  frame_id?: string;
  status?: string;
} | null {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

export function friendlyError(error: unknown): string {
  const value = error as Error & {code?: string};
  const messages: Record<string, string> = {
    assessment_access_denied: '上次检查已失效，请重新开始',
    provider_not_configured: '分析服务尚未配置',
    provider_timeout: '分析时间较长，请稍后重试',
    provider_invalid_response: '这次没有看清，请重新分析',
    provider_refusal: '这张照片暂时无法完成分析',
    provider_http_429: '当前检查人数较多，请稍后重试',
    provider_capacity_busy: '当前实时检查较多，正在等待下一次画面',
    camera_request_in_progress: '上一张画面仍在检查，请稍候',
    ios_home_camera_not_enabled: 'iPhone 实时相机暂未开放',
    profile_incomplete: '请先完成三项家人情况',
    room_rules_not_ready: '这个房间的完整规则仍在完善中',
    no_usable_media: '至少需要一张可以看清的照片',
    analysis_interrupted: '服务重启中断了分析，请重新开始',
    analysis_start_failed: '暂时无法开始分析，请稍后重试',
    analysis_failed: '分析没有完成，请重新尝试',
    advisor_room_in_use: '这个房间正在另一台设备上使用，请稍后再试',
    advisor_queue_required: 'AI 顾问体验人数较多，正在排队，请稍候。',
    advisor_queue_expired: '本次排队已失效，请重新排队',
    advisor_capacity_busy: '当前体验人数较多，请稍后重试',
    advisor_confirmation_in_progress: '这项确认正在另一端处理，请稍候',
    advisor_confirmation_already_decided: '这项确认已经处理，请刷新查看',
    renovation_preview_not_enabled: '改造效果预览暂未开放',
    renovation_source_not_usable: '这张照片不适合生成，请换一张清晰照片',
    renovation_no_selected_solutions: '请先为这个房间选择改造方案',
    renovation_no_visualizable_actions: '当前方案不适合生成图片效果',
    renovation_preview_in_progress: '已有一张效果图正在生成，请稍候',
    renovation_preview_daily_limit: '今天的生成次数已用完，请稍后再试',
    renovation_preview_interrupted: '生成被服务重启中断，请重新尝试',
    renovation_preview_stale: '改造方案已更新，请重新生成效果图',
    renovation_preview_start_failed: '暂时无法开始生成，请稍后重试',
    renovation_preview_timeout: '效果图生成时间较长，请稍后重试',
    renovation_preview_capacity_busy: '当前生成任务较多，请稍后再试',
    renovation_preview_refusal: '这张照片暂时无法生成改造效果',
    renovation_preview_invalid_response: '模型没有返回可用的效果图，请重新尝试',
    renovation_preview_failed: '效果图没有生成完成，请重新尝试',
  };
  return messages[value?.code || ''] || value?.message || '这次操作没有完成，请稍后重试';
}
