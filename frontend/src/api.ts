import {readSession, writeSession} from './store';
import type {
  AnalysisStatus,
  Assessment,
  AssessmentReport,
  ElderProfile,
  InputMode,
  RoomAssessment,
  RoomResult,
  RoomType,
  RiskRegion,
  SolutionsResult,
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
  health: () => request<{status: string; analysis: string; version: string}>('/health', {}, false),
  async createAssessment(input_mode: InputMode) {
    const value = await request<{assessment_id: string; access_token: string}>('/api/v2/assessments', json('POST', {input_mode}), false);
    writeSession({assessment_id: value.assessment_id, access_token: value.access_token});
    return value;
  },
  getAssessment: (signal?: AbortSignal) => request<Assessment>(assessmentPath(), {signal}),
  saveProfile: (profile: ElderProfile) => request<ElderProfile>(assessmentPath('/profile'), json('PUT', profile)),
  createRoom: (room_type: RoomType) => request<RoomAssessment>(assessmentPath('/rooms'), json('POST', {room_type})),
  uploadMedia: (roomId: string, blob: Blob, width: number, height: number) => request<unknown>(assessmentPath(`/rooms/${roomId}/media`), {
    method: 'POST',
    headers: {'Content-Type': blob.type || 'image/jpeg', 'X-Image-Width': String(width), 'X-Image-Height': String(height)},
    body: blob,
  }),
  deleteMedia: (roomId: string, mediaId: string) => request<void>(assessmentPath(`/rooms/${roomId}/media/${mediaId}`), {method: 'DELETE'}),
  mediaBlob: (path: string, signal?: AbortSignal) => request<Blob>(path, {signal}),
  analyze: (roomId: string) => request<{job_id: string}>(assessmentPath(`/rooms/${roomId}:analyze`), {method: 'POST'}),
  status: (roomId: string, signal?: AbortSignal) => request<AnalysisStatus>(assessmentPath(`/rooms/${roomId}/status`), {signal}),
  result: (roomId: string, signal?: AbortSignal) => request<RoomResult>(assessmentPath(`/rooms/${roomId}/result`), {signal}),
  feedback: (riskId: string, feedback: string) => request<{score: number}>(assessmentPath(`/risks/${riskId}/feedback`), json('POST', {feedback})),
  region: (riskId: string, region: RiskRegion) => request<{region: RiskRegion}>(assessmentPath(`/risks/${riskId}/region`), json('PUT', {region})),
  solutions: (riskId: string, signal?: AbortSignal) => request<SolutionsResult>(assessmentPath(`/risks/${riskId}/solutions`), {signal}),
  selectSolution: (riskId: string, solutionId: string) => request<AssessmentReport>(assessmentPath(`/risks/${riskId}/selected-solution`), json('PUT', {solution_package_id: solutionId})),
  removeSolution: (riskId: string) => request<void>(assessmentPath(`/risks/${riskId}/selected-solution`), {method: 'DELETE'}),
  report: (signal?: AbortSignal) => request<AssessmentReport>(assessmentPath('/report'), {signal}),
  complete: () => request<AssessmentReport>(assessmentPath(':complete'), {method: 'POST'}),
  deleteAssessment: () => request<void>(assessmentPath(), {method: 'DELETE'}),
};

export function friendlyError(error: unknown): string {
  const value = error as Error & {code?: string};
  const messages: Record<string, string> = {
    assessment_access_denied: '上次检查已失效，请重新开始',
    provider_not_configured: '分析服务尚未配置',
    provider_timeout: '分析时间较长，请稍后重试',
    provider_invalid_response: '这次没有看清，请重新分析',
    provider_refusal: '这张照片暂时无法完成分析',
    room_rules_not_ready: '这个房间的完整规则仍在完善中',
    no_usable_media: '至少需要一张可以看清的照片',
    analysis_interrupted: '服务重启中断了分析，请重新开始',
  };
  return messages[value?.code || ''] || value?.message || '这次操作没有完成，请稍后重试';
}
