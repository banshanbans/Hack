from __future__ import annotations

from contextlib import asynccontextmanager
import asyncio
from pathlib import Path
import json
import logging
import mimetypes
import os
from typing import Any, AsyncIterator, Optional, TypeVar
import uuid

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from .assessment_service import AssessmentError, AssessmentService
from .environment import load_environment
from .logging_safety import install_sensitive_log_filter
from .providers import ProviderError, VisionProvider, VolcengineVoiceProvider
from .repositories import SQLiteRepository
from .service import SessionService, demo_analysis, empty_analysis


load_environment()
install_sensitive_log_filter()


LOGGER = logging.getLogger("anjuguard.backend")
PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STATIC_ROOT = PROJECT_ROOT / "frontend" / "dist"
MAX_BODY_BYTES = 6 * 1024 * 1024
STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https://*.volcengine.com wss://*.volcengine.com https://*.volces.com wss://*.volces.com; font-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

ERROR_MESSAGES = {
    "assessment_access_denied": "没有找到这次检查或访问已失效",
    "assessment_not_found": "没有找到这次检查",
    "profile_incomplete": "请完成三项家人情况",
    "invalid_room_type": "暂不支持这个房间",
    "room_rules_not_ready": "这个房间的完整规则仍在完善中",
    "invalid_image_format": "照片格式暂不支持，请重新选择",
    "invalid_image_dimensions": "照片尺寸不正确，请重新选择",
    "invalid_media_metadata": "媒体来源信息不正确，请重新选择",
    "invalid_camera_frame": "相机画面信息不完整，请重试",
    "camera_request_in_progress": "上一张画面仍在检查，请稍候",
    "camera_not_enabled": "实时相机功能暂未开放",
    "video_not_enabled": "视频检查功能暂未开放",
    "ios_home_camera_not_enabled": "iPhone 实时相机功能暂未开放",
    "camera_session_not_found": "本次实时扫描已结束，请重新进入相机",
    "invalid_camera_session": "扫描结果与当前房间不匹配",
    "camera_suggestion_not_found": "没有找到这条扫描提示",
    "camera_inspection_expired": "这张画面已过期，请停稳后重新拍摄",
    "rtc_tool_schema_invalid": "实时顾问没有返回可用的扫描提示",
    "rtc_callback_denied": "实时顾问回调校验失败",
    "rtc_callback_invalid": "实时顾问回调内容不完整",
    "advisor_session_not_found": "本次顾问对话已结束，请重新进入",
    "advisor_message_invalid": "请输入需要咨询的问题",
    "advisor_confirmation_not_found": "这项确认已处理或已失效",
    "advisor_confirmation_in_progress": "这项确认正在另一端处理，请稍候",
    "advisor_confirmation_already_decided": "这项确认已经处理，请刷新查看",
    "advisor_tool_not_allowed": "这项操作不能由顾问直接执行",
    "advisor_room_in_use": "这个房间正在另一台设备上使用，请稍后再试",
    "advisor_queue_required": "AI 顾问体验人数较多，正在排队，请稍候。",
    "advisor_queue_expired": "本次排队已失效，请重新排队",
    "advisor_capacity_busy": "当前体验人数较多，请稍后重试",
    "knowledge_advisor_not_enabled": "AI 助手暂未开放",
    "knowledge_advisor_access_denied": "没有找到这次对话或访问已失效",
    "knowledge_advisor_session_not_found": "本次对话已结束，请开始新对话",
    "knowledge_advisor_session_expired": "本次对话已过期，已为你准备新对话",
    "knowledge_advisor_message_invalid": "请输入 500 字以内的适老化问题",
    "knowledge_advisor_message_limit": "本次对话已达到上限，请开始新对话",
    "knowledge_advisor_request_in_progress": "上一个问题正在回答，请稍候",
    "renovation_preview_not_enabled": "改造效果预览暂未开放",
    "renovation_source_not_found": "没有找到这张原始照片",
    "renovation_source_not_usable": "这张照片不适合生成改造效果，请换一张清晰照片",
    "renovation_no_selected_solutions": "请先为这个房间选择改造方案",
    "renovation_no_visualizable_actions": "当前已选方案不适合生成图片效果",
    "renovation_preview_in_progress": "这个房间已有一张效果图正在生成",
    "renovation_preview_daily_limit": "今天的生成次数已用完，请稍后再试",
    "renovation_preview_not_found": "没有找到这张改造效果图",
    "renovation_preview_not_ready": "改造效果图还没有生成完成",
    "renovation_preview_stale": "改造方案已更新，请重新生成效果图",
    "renovation_preview_interrupted": "服务重启中断了生成，请重新尝试",
    "renovation_preview_start_failed": "暂时无法开始生成，请稍后重试",
    "renovation_preview_timeout": "效果图生成时间较长，请稍后重试",
    "renovation_preview_capacity_busy": "当前生成任务较多，请稍后再试",
    "renovation_preview_refusal": "这张照片暂时无法生成改造效果",
    "renovation_preview_invalid_response": "模型没有返回可用的效果图，请重新尝试",
    "renovation_preview_failed": "效果图没有生成完成，请重新尝试",
    "too_many_images": "每个房间最多上传 6 张照片",
    "no_usable_media": "至少需要一张可以看清的照片",
    "provider_not_configured": "分析服务尚未配置",
    "provider_timeout": "分析时间较长，请稍后重试",
    "provider_invalid_response": "这次没有看清，请重新分析",
    "provider_refusal": "这张照片暂时无法完成分析",
    "provider_http_429": "分析请求较多，请稍后重试",
    "provider_capacity_busy": "当前实时分析较多，请稍后再试",
    "provider_invalid_request": "分析请求配置不完整",
    "result_not_ready": "检查结果还没有准备好",
    "share_expired": "分享链接已失效",
    "invalid_region": "请重新圈选风险位置",
    "invalid_request": "提交内容不完整，请检查后重试",
}


class DTO(BaseModel):
    model_config = ConfigDict(extra="ignore")


class AssessmentCreate(DTO):
    input_mode: str = "photo"
    planned_rooms: list[str] = Field(default_factory=list)


class ProfileUpdate(DTO):
    mobility: str
    fall_history: str
    living_status: str


class PlannedRoomsUpdate(DTO):
    planned_rooms: list[str]


class RoomCreate(DTO):
    room_type: str


class FeedbackCreate(DTO):
    feedback: str


class RegionUpdate(DTO):
    region: dict[str, Any]


class SolutionUpdate(DTO):
    solution_package_id: str


class RenovationPreviewCreate(DTO):
    source_media_id: str = Field(min_length=1, max_length=80)


class AnalyticsCreate(DTO):
    event_name: str
    room_id: Optional[str] = None
    payload: dict[str, Any] = Field(default_factory=dict)


class CameraFrameContext(DTO):
    frame_id: str
    room_type: str
    previous_summary: list[str] = Field(default_factory=list, max_length=5)


class RoomCameraFrameContext(DTO):
    frame_id: str = Field(min_length=1, max_length=80)
    source_kind: str = "h5_camera_frame"
    orientation: str = "up"
    previous_summary: list[str] = Field(default_factory=list, max_length=5)
    camera_session_id: Optional[str] = Field(default=None, min_length=1, max_length=80)


class CameraSessionComplete(DTO):
    media_ids: list[str] = Field(default_factory=list, max_length=6)


class CameraInspectionPrepare(DTO):
    frame_id: str = Field(min_length=1, max_length=80)
    captured_at_ms: int = Field(gt=0)
    width: int = Field(ge=1, le=1920)
    height: int = Field(ge=1, le=1920)
    orientation: str
    perceptual_hash: str = Field(default="", max_length=128)
    quality: dict[str, float] = Field(default_factory=dict)


class AdvisorSessionCreate(DTO):
    camera_session_id: Optional[str] = Field(default=None, min_length=1, max_length=80)
    context_refs: dict[str, str] = Field(default_factory=dict)


class AdvisorRTCQueueCreate(DTO):
    client_instance_id: str = Field(min_length=1, max_length=80)
    mode: str


class AdvisorMessageCreate(DTO):
    text: str = Field(min_length=1, max_length=500)
    context_refs: dict[str, str] = Field(default_factory=dict)
    requested_action: Optional[dict[str, Any]] = None


class AdvisorTranscriptCreate(DTO):
    role: str
    text: str = Field(min_length=1, max_length=500)
    provider_event_id: str = Field(min_length=1, max_length=120)
    context_refs: dict[str, str] = Field(default_factory=dict)


class AdvisorConfirmationDecision(DTO):
    approved: bool


class KnowledgeAdvisorMessageCreate(DTO):
    text: str = Field(min_length=1, max_length=500)


class KnowledgeAdvisorTranscriptCreate(DTO):
    role: str
    text: str = Field(min_length=1, max_length=800)
    provider_event_id: str = Field(min_length=1, max_length=120)


ModelT = TypeVar("ModelT", bound=DTO)


def _mock_enabled() -> bool:
    return os.environ.get("ANJU_MOCK_ANALYSIS") == "1"


def _analysis_mode() -> str:
    if _mock_enabled():
        return "demo"
    provider_name = os.environ.get("ANJU_VISION_PROVIDER", "openai").strip().lower()
    if provider_name == "ark" and os.environ.get("ARK_API_KEY", "").strip():
        return "ark"
    if provider_name == "openai" and os.environ.get("OPENAI_API_KEY", "").strip():
        return "openai"
    return "not_configured"


def _default_v2_service() -> AssessmentService:
    db_path = Path(os.environ.get("ANJU_DB_PATH", str(BACKEND_ROOT / "data" / "anju.db")))
    media_root = Path(os.environ.get("ANJU_MEDIA_ROOT", str(BACKEND_ROOT / "data" / "media")))
    return AssessmentService(SQLiteRepository(db_path), media_root)


async def _read_limited_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared:
        try:
            if int(declared) > MAX_BODY_BYTES:
                raise AssessmentError("request_too_large", 413)
        except ValueError as error:
            raise AssessmentError("invalid_request") from error
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY_BYTES:
            raise AssessmentError("request_too_large", 413)
    if not body:
        raise AssessmentError("invalid_request")
    return bytes(body)


async def _read_json(request: Request) -> dict[str, Any]:
    try:
        value = json.loads(await _read_limited_body(request))
    except (ValueError, json.JSONDecodeError) as error:
        raise AssessmentError("invalid_request") from error
    if not isinstance(value, dict):
        raise AssessmentError("invalid_request")
    return value


async def _read_model(request: Request, model_type: type[ModelT]) -> ModelT:
    try:
        return model_type.model_validate(await _read_json(request))
    except ValidationError as error:
        raise AssessmentError("invalid_request") from error


def _integer_header(request: Request, name: str) -> int:
    try:
        return int(request.headers.get(name, "0"))
    except ValueError:
        return 0


def _optional_integer_header(request: Request, name: str) -> int | None:
    raw = request.headers.get(name)
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError:
        return -1


def _service(request: Request) -> AssessmentService:
    return request.app.state.v2_service


def _v1(request: Request) -> SessionService:
    return request.app.state.v1_service


def _authorize(request: Request, assessment_id: str) -> None:
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.startswith("Bearer ") else ""
    _service(request).authorize(assessment_id, token)


def _authorize_knowledge_advisor(request: Request, session_id: str) -> None:
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.startswith("Bearer ") else ""
    _service(request).knowledge_advisor.authorize(session_id, token)


def create_app(
    *,
    assessment_service: AssessmentService | None = None,
    v1_service: SessionService | None = None,
    static_root: Path | None = None,
    provider: VisionProvider | None = None,
) -> FastAPI:
    resolved_static_root = static_root or Path(os.environ.get("ANJU_STATIC_ROOT", str(DEFAULT_STATIC_ROOT)))

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        owned_service = assessment_service is None
        application.state.v1_service = v1_service or SessionService()
        application.state.v2_service = assessment_service or _default_v2_service()
        if provider is not None:
            application.state.v2_service._provider = provider
        application.state.static_root = resolved_static_root
        try:
            yield
        finally:
            if owned_service:
                application.state.v2_service.close()

    docs_enabled = os.environ.get("ANJU_ENABLE_API_DOCS") == "1"
    application = FastAPI(
        title="AnjuGuard API",
        version="2.0",
        docs_url="/docs" if docs_enabled else None,
        redoc_url="/redoc" if docs_enabled else None,
        openapi_url="/openapi.json" if docs_enabled else None,
        lifespan=lifespan,
    )
    allowed_hosts = [item.strip() for item in os.environ.get("ANJU_ALLOWED_HOSTS", "127.0.0.1,localhost,testserver").split(",") if item.strip()]
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)

    @application.middleware("http")
    async def security_headers(request: Request, call_next):
        request.state.request_id = uuid.uuid4().hex
        if request.url.path == "/api/v2/fair-scans" or request.url.path.startswith("/api/v2/fair-scans/"):
            response = JSONResponse(
                {"code": "not_found", "message": "请求的功能不存在", "request_id": request.state.request_id},
                status_code=404,
            )
        else:
            response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = STRICT_CSP
        if request.url.path.startswith("/api/") or request.url.path == "/health":
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(AssessmentError)
    async def assessment_error_handler(request: Request, error: AssessmentError) -> JSONResponse:
        message = ERROR_MESSAGES.get(error.code, "这次操作没有完成，请稍后重试")
        if error.code == "request_too_large":
            message = "照片太大，请压缩后重试"
        return JSONResponse({"code": error.code, "message": message, "request_id": request.state.request_id}, status_code=error.status)

    @application.exception_handler(ProviderError)
    async def provider_error_handler(request: Request, error: ProviderError) -> JSONResponse:
        status = 502
        if error.code == "provider_timeout":
            status = 504
        elif error.code in {"provider_not_configured", "provider_http_429"} or error.code.startswith("provider_http_5"):
            status = 503
        elif error.code == "provider_capacity_busy":
            status = 429
        elif error.code in {"provider_refusal", "provider_invalid_request"}:
            status = 422
        LOGGER.warning("provider_call_failed code=%s request_id=%s", error.code, request.state.request_id)
        return JSONResponse({
            "code": error.code,
            "message": ERROR_MESSAGES.get(error.code, "分析服务暂时不可用，请稍后重试"),
            "request_id": request.state.request_id,
        }, status_code=status)

    @application.exception_handler(RequestValidationError)
    async def request_validation_handler(request: Request, _error: RequestValidationError) -> JSONResponse:
        return JSONResponse({"code": "invalid_request", "message": ERROR_MESSAGES["invalid_request"], "request_id": request.state.request_id}, status_code=400)

    @application.get("/health")
    def health(request: Request) -> dict[str, Any]:
        return {
            "status": "ok", "analysis": _analysis_mode(), "version": "v2",
            "capabilities": {
                "h5_video": os.environ.get("ANJU_ENABLE_H5_VIDEO", "0") == "1",
                "h5_camera": os.environ.get("ANJU_ENABLE_H5_CAMERA", "0") == "1",
                "ios_home_camera": os.environ.get("ANJU_ENABLE_IOS_HOME_CAMERA", "0") == "1",
                "voice_advisor": VolcengineVoiceProvider.configured(),
                "rtc_video_advisor": VolcengineVoiceProvider.video_healthy(),
                "renovation_preview": os.environ.get("ANJU_ENABLE_RENOVATION_PREVIEW", "0") == "1",
                "knowledge_advisor": _service(request).knowledge_advisor.available(),
            },
        }

    @application.get("/favicon.ico", include_in_schema=False)
    def favicon() -> Response:
        return Response(status_code=204)

    @application.post("/api/v1/sessions", status_code=201)
    async def v1_create_session(request: Request) -> dict[str, str]:
        record = _v1(request).create_session(await _read_json(request))
        return {"session_id": record.id}

    @application.post("/api/v1/sessions/{session_id}/frames:analyze")
    async def v1_analyze(session_id: str, request: Request) -> Any:
        if _v1(request).get_session(session_id) is None:
            return JSONResponse({"message": "本次检查已结束"}, status_code=404)
        frame_id = request.headers.get("x-frame-id", "")
        await _read_limited_body(request)
        if not frame_id:
            return JSONResponse({"message": "这张照片没有看清"}, status_code=400)
        analysis = demo_analysis(frame_id) if _mock_enabled() else empty_analysis(frame_id)
        accepted = _v1(request).record_analysis(session_id, frame_id, analysis["issues"])
        issues = [{key: value for key, value in issue.items() if key not in {"id", "state", "frame_id"}} for issue in accepted]
        return {"frame_id": frame_id, "issues": issues}

    @application.patch("/api/v1/sessions/{session_id}/issues/{issue_id}")
    async def v1_update_issue(session_id: str, issue_id: str, request: Request) -> Any:
        payload = await _read_json(request)
        try:
            return _v1(request).update_issue(session_id, issue_id, str(payload.get("state", "")))
        except ValueError:
            return JSONResponse({"message": "这个状态暂时不能使用"}, status_code=400)
        except KeyError:
            return JSONResponse({"message": "没有找到这项内容"}, status_code=404)

    @application.post("/api/v1/sessions/{session_id}:complete")
    def v1_complete(session_id: str, request: Request) -> Any:
        try:
            return _v1(request).complete(session_id)
        except KeyError:
            return JSONResponse({"message": "本次检查已结束"}, status_code=404)

    @application.post("/api/v1/sessions/{session_id}/share", status_code=201)
    def v1_share(session_id: str, request: Request) -> Any:
        try:
            token, expires_at = _v1(request).create_share(session_id)
        except KeyError:
            return JSONResponse({"message": "本次检查已结束"}, status_code=404)
        return {"token": token, "path": f"/api/v1/reports/{token}", "expires_at": expires_at.isoformat()}

    @application.get("/api/v1/reports/{token}")
    def v1_report(token: str, request: Request) -> Any:
        report = _v1(request).shared_report(token)
        return report or JSONResponse({"message": "链接已失效"}, status_code=404)

    @application.post("/api/v2/knowledge-advisor/sessions", status_code=201)
    def create_knowledge_advisor_session(request: Request) -> dict[str, Any]:
        return _service(request).knowledge_advisor.create_session()

    @application.get("/api/v2/knowledge-advisor/sessions/{session_id}")
    def get_knowledge_advisor_session(session_id: str, request: Request) -> dict[str, Any]:
        _authorize_knowledge_advisor(request, session_id)
        return _service(request).knowledge_advisor.get_session(session_id)

    @application.post("/api/v2/knowledge-advisor/sessions/{session_id}/messages")
    async def knowledge_advisor_message(session_id: str, request: Request) -> dict[str, Any]:
        _authorize_knowledge_advisor(request, session_id)
        payload = await _read_model(request, KnowledgeAdvisorMessageCreate)
        return await run_in_threadpool(_service(request).knowledge_advisor.add_message, session_id, payload.text)

    @application.post("/api/v2/knowledge-advisor/sessions/{session_id}/transcripts")
    async def knowledge_advisor_transcript(session_id: str, request: Request) -> dict[str, Any]:
        _authorize_knowledge_advisor(request, session_id)
        payload = await _read_model(request, KnowledgeAdvisorTranscriptCreate)
        return _service(request).knowledge_advisor.add_transcript(
            session_id, payload.role, payload.text, payload.provider_event_id,
        )

    @application.delete("/api/v2/knowledge-advisor/sessions/{session_id}", status_code=204)
    def delete_knowledge_advisor_session(session_id: str, request: Request) -> Response:
        _authorize_knowledge_advisor(request, session_id)
        _service(request).knowledge_advisor.delete_session(session_id)
        return Response(status_code=204)

    @application.post("/api/v2/knowledge-advisor/sessions/{session_id}/rtc-queue", status_code=201)
    async def join_knowledge_advisor_rtc_queue(session_id: str, request: Request) -> dict[str, Any]:
        _authorize_knowledge_advisor(request, session_id)
        payload = await _read_model(request, AdvisorRTCQueueCreate)
        return _service(request).knowledge_advisor.enqueue_rtc(
            session_id, payload.client_instance_id, payload.mode,
        )

    @application.get("/api/v2/knowledge-advisor/sessions/{session_id}/rtc-queue/{ticket_id}")
    def knowledge_advisor_rtc_queue_status(session_id: str, ticket_id: str, request: Request) -> dict[str, Any]:
        _authorize_knowledge_advisor(request, session_id)
        return _service(request).knowledge_advisor.queue_status(
            session_id, ticket_id, request.headers.get("X-Advisor-Client-ID", ""),
        )

    @application.post("/api/v2/knowledge-advisor/sessions/{session_id}/rtc-queue/{ticket_id}/heartbeat")
    def heartbeat_knowledge_advisor_rtc_queue(session_id: str, ticket_id: str, request: Request) -> dict[str, Any]:
        _authorize_knowledge_advisor(request, session_id)
        return _service(request).knowledge_advisor.heartbeat_queue(
            session_id, ticket_id, request.headers.get("X-Advisor-Client-ID", ""),
        )

    @application.delete("/api/v2/knowledge-advisor/sessions/{session_id}/rtc-queue/{ticket_id}", status_code=204)
    def cancel_knowledge_advisor_rtc_queue(session_id: str, ticket_id: str, request: Request) -> Response:
        _authorize_knowledge_advisor(request, session_id)
        _service(request).knowledge_advisor.cancel_queue(
            session_id, ticket_id, request.headers.get("X-Advisor-Client-ID", ""),
        )
        return Response(status_code=204)

    @application.post("/api/v2/knowledge-advisor/sessions/{session_id}/voice")
    def start_knowledge_advisor_voice(session_id: str, request: Request) -> dict[str, Any]:
        _authorize_knowledge_advisor(request, session_id)
        return _service(request).knowledge_advisor.start_voice(
            session_id,
            request.headers.get("X-Advisor-Client-ID", ""),
            request.headers.get("X-Advisor-Queue-Ticket", ""),
        )

    @application.post("/api/v2/assessments", status_code=201)
    async def create_assessment(request: Request) -> dict[str, Any]:
        payload = await _read_model(request, AssessmentCreate)
        return _service(request).create_assessment(payload.model_dump())

    @application.get("/api/v2/assessments/{assessment_id}")
    def get_assessment(assessment_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).assessment(assessment_id)

    @application.delete("/api/v2/assessments/{assessment_id}", status_code=204)
    def delete_assessment(assessment_id: str, request: Request) -> Response:
        _authorize(request, assessment_id)
        _service(request).delete_assessment(assessment_id)
        return Response(status_code=204)

    @application.put("/api/v2/assessments/{assessment_id}/profile")
    async def save_profile(assessment_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, ProfileUpdate)
        return _service(request).save_profile(assessment_id, payload.model_dump())

    @application.put("/api/v2/assessments/{assessment_id}/planned-rooms")
    async def save_planned_rooms(assessment_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, PlannedRoomsUpdate)
        return _service(request).save_planned_rooms(assessment_id, payload.planned_rooms)

    @application.post("/api/v2/assessments/{assessment_id}/rooms", status_code=201)
    async def create_room(assessment_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, RoomCreate)
        return _service(request).create_room(assessment_id, payload.model_dump())

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/media", status_code=201)
    async def upload_media(assessment_id: str, room_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        mime_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        width = _integer_header(request, "x-image-width")
        height = _integer_header(request, "x-image-height")
        metadata = {
            "source_kind": request.headers.get("x-media-source-kind", "photo"),
            "source_id": request.headers.get("x-media-source-id") or None,
            "frame_index": _optional_integer_header(request, "x-media-frame-index"),
            "captured_at_ms": _optional_integer_header(request, "x-media-captured-at-ms"),
            "orientation": request.headers.get("x-media-orientation", "up"),
            "perceptual_hash": request.headers.get("x-media-perceptual-hash") or None,
            "zone_id": request.headers.get("x-media-zone-id") or None,
        }
        body = await _read_limited_body(request)
        return await run_in_threadpool(
            _service(request).upload_media, assessment_id, room_id, body, mime_type, width, height, metadata,
        )

    @application.delete("/api/v2/assessments/{assessment_id}/rooms/{room_id}/media/{media_id}", status_code=204)
    def delete_media(assessment_id: str, room_id: str, media_id: str, request: Request) -> Response:
        _authorize(request, assessment_id)
        _service(request).delete_media(assessment_id, room_id, media_id)
        return Response(status_code=204)

    @application.get("/api/v2/assessments/{assessment_id}/media/{media_id}/content")
    def media_content(assessment_id: str, media_id: str, request: Request) -> FileResponse:
        _authorize(request, assessment_id)
        path, mime_type = _service(request).media_content(assessment_id, media_id)
        return FileResponse(path, media_type=mime_type, headers={"Cache-Control": "no-store"})

    @application.post("/api/v2/assessments/{assessment_id}/camera/frames:inspect")
    async def inspect_camera_frame(assessment_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        mime_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        width = _integer_header(request, "x-image-width")
        height = _integer_header(request, "x-image-height")
        context_header = request.headers.get("x-camera-context", "")
        try:
            context = CameraFrameContext.model_validate_json(context_header)
        except (ValidationError, ValueError) as error:
            raise AssessmentError("invalid_camera_frame") from error
        body = await _read_limited_body(request)
        return await run_in_threadpool(
            _service(request).inspect_camera_frame,
            assessment_id, body, mime_type, width, height, context.model_dump(),
        )

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/frames:inspect")
    async def inspect_room_camera_frame(assessment_id: str, room_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        mime_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        width = _integer_header(request, "x-image-width")
        height = _integer_header(request, "x-image-height")
        context_header = request.headers.get("x-camera-context", "")
        try:
            context = RoomCameraFrameContext.model_validate_json(context_header)
        except (ValidationError, ValueError) as error:
            raise AssessmentError("invalid_camera_frame") from error
        body = await _read_limited_body(request)
        return await run_in_threadpool(
            _service(request).inspect_room_camera_frame,
            assessment_id, room_id, body, mime_type, width, height, context.model_dump(),
        )

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/sessions", status_code=201)
    def create_camera_session(assessment_id: str, room_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).advisor.create_camera_session(assessment_id, room_id)

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/sessions/{camera_session_id}:complete")
    async def complete_camera_session(
        assessment_id: str, room_id: str, camera_session_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, CameraSessionComplete)
        return _service(request).advisor.complete_camera_session(
            assessment_id, room_id, camera_session_id, payload.media_ids,
        )

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/camera/sessions/{camera_session_id}/frames:prepare-inspection")
    async def prepare_camera_inspection(
        assessment_id: str, room_id: str, camera_session_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, CameraInspectionPrepare)
        return _service(request).advisor.prepare_camera_inspection(
            assessment_id, room_id, camera_session_id, payload.model_dump(),
        )

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}:analyze", status_code=202)
    def start_analysis(assessment_id: str, room_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).start_analysis(assessment_id, room_id)

    @application.get("/api/v2/assessments/{assessment_id}/rooms/{room_id}/status")
    def analysis_status(assessment_id: str, room_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).analysis_status(assessment_id, room_id)

    @application.get("/api/v2/assessments/{assessment_id}/rooms/{room_id}/result")
    def room_result(assessment_id: str, room_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).room_result(assessment_id, room_id)

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions", status_code=201)
    async def create_advisor_session(assessment_id: str, room_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, AdvisorSessionCreate)
        return await run_in_threadpool(
            _service(request).advisor.create_session,
            assessment_id, room_id, payload.camera_session_id, payload.context_refs,
        )

    @application.get("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/turns")
    def advisor_turns(assessment_id: str, room_id: str, session_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).advisor.list_turns(assessment_id, room_id, session_id)

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/events-token")
    def advisor_events_token(
        assessment_id: str, room_id: str, session_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).advisor.issue_event_token(assessment_id, room_id, session_id)

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/rtc-queue", status_code=201)
    async def join_advisor_rtc_queue(
        assessment_id: str, room_id: str, session_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, AdvisorRTCQueueCreate)
        return _service(request).advisor.enqueue_rtc(
            assessment_id, room_id, session_id, payload.client_instance_id, payload.mode,
        )

    @application.get("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/rtc-queue/{ticket_id}")
    def advisor_rtc_queue_status(
        assessment_id: str, room_id: str, session_id: str, ticket_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).advisor.rtc_queue_status(
            assessment_id, room_id, session_id, ticket_id,
            request.headers.get("X-Advisor-Client-ID", ""),
        )

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/rtc-queue/{ticket_id}/heartbeat")
    def heartbeat_advisor_rtc_queue(
        assessment_id: str, room_id: str, session_id: str, ticket_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).advisor.heartbeat_rtc_queue(
            assessment_id, room_id, session_id, ticket_id,
            request.headers.get("X-Advisor-Client-ID", ""),
        )

    @application.delete(
        "/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/rtc-queue/{ticket_id}",
        status_code=204,
    )
    def cancel_advisor_rtc_queue(
        assessment_id: str, room_id: str, session_id: str, ticket_id: str, request: Request,
    ) -> Response:
        _authorize(request, assessment_id)
        _service(request).advisor.cancel_rtc_queue(
            assessment_id, room_id, session_id, ticket_id,
            request.headers.get("X-Advisor-Client-ID", ""),
        )
        return Response(status_code=204)

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/voice")
    def start_advisor_voice(
        assessment_id: str, room_id: str, session_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).advisor.start_voice(
            assessment_id, room_id, session_id,
            request.headers.get("X-Advisor-Client-ID"),
            request.headers.get("X-Advisor-Queue-Ticket"),
        )

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/realtime")
    def start_advisor_realtime(
        assessment_id: str, room_id: str, session_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).advisor.start_realtime(
            assessment_id, room_id, session_id,
            request.headers.get("X-Advisor-Client-ID"),
            request.headers.get("X-Advisor-Queue-Ticket"),
        )

    @application.post("/api/internal/rtc/function-calls")
    async def rtc_function_calls(request: Request) -> dict[str, Any]:
        payload = await _read_json(request)
        if not isinstance(payload, dict):
            raise AssessmentError("rtc_callback_invalid")
        return await run_in_threadpool(_service(request).advisor.handle_function_callback, payload)

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/messages")
    async def advisor_message(
        assessment_id: str, room_id: str, session_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, AdvisorMessageCreate)
        return _service(request).advisor.add_message(
            assessment_id, room_id, session_id, payload.text, payload.context_refs, payload.requested_action,
        )

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/transcripts")
    async def advisor_transcript(
        assessment_id: str, room_id: str, session_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, AdvisorTranscriptCreate)
        return _service(request).advisor.add_transcript(
            assessment_id, room_id, session_id, payload.role, payload.text,
            payload.provider_event_id, payload.context_refs,
        )

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/confirmations/{confirmation_id}")
    async def advisor_confirmation(
        assessment_id: str, room_id: str, session_id: str, confirmation_id: str, request: Request,
    ) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, AdvisorConfirmationDecision)
        return _service(request).advisor.decide_confirmation(
            assessment_id, room_id, session_id, confirmation_id, payload.approved,
        )

    @application.delete("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}", status_code=204)
    def end_advisor_session(
        assessment_id: str, room_id: str, session_id: str, request: Request,
    ) -> Response:
        _authorize(request, assessment_id)
        _service(request).advisor.end_session(assessment_id, room_id, session_id)
        return Response(status_code=204)

    @application.websocket("/api/v2/assessments/{assessment_id}/rooms/{room_id}/advisor/sessions/{session_id}/events")
    async def advisor_events(
        websocket: WebSocket, assessment_id: str, room_id: str, session_id: str,
    ) -> None:
        token = websocket.query_params.get("token", "")
        service = websocket.app.state.v2_service
        accepted = await run_in_threadpool(
            service.advisor.consume_event_token, assessment_id, room_id, session_id, token,
        )
        if not accepted:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        known = {
            item["turn_id"] for item in await run_in_threadpool(
                service.advisor._room_turns, assessment_id, room_id,
            )
        }
        advisor_session = await run_in_threadpool(
            service.advisor._owned_session, assessment_id, room_id, session_id,
        )
        camera = await run_in_threadpool(service.advisor._camera_context, advisor_session)
        camera_session_id = camera.get("camera_session_id")
        known_suggestions = {item.get("suggestion_id") for item in camera.get("suggestions", [])}
        known_frames: dict[str, str] = {}
        await websocket.send_json({"type": "ready", "session_id": session_id})
        try:
            while True:
                await asyncio.sleep(1)
                turns = await run_in_threadpool(service.advisor._room_turns, assessment_id, room_id)
                for turn in turns:
                    if turn["turn_id"] not in known:
                        known.add(turn["turn_id"])
                        await websocket.send_json({"type": "turn", "turn": turn})
                context = await run_in_threadpool(service.advisor._camera_context, advisor_session)
                for suggestion in context.get("suggestions", []):
                    suggestion_id = suggestion.get("suggestion_id")
                    if suggestion_id and suggestion_id not in known_suggestions:
                        known_suggestions.add(suggestion_id)
                        await websocket.send_json({
                            "type": "camera_suggestion_added",
                            "inspection_id": suggestion.get("inspection_id"),
                            "frame_id": suggestion.get("frame_id"),
                            "suggestion": suggestion,
                        })
                if camera_session_id:
                    frames = await run_in_threadpool(
                        service.repository.fetchall,
                        "SELECT id,inspection_id,status,updated_at FROM camera_session_frames WHERE camera_session_id=? ORDER BY created_at",
                        (camera_session_id,),
                    )
                    for frame in frames:
                        if known_frames.get(frame["inspection_id"]) != frame["status"]:
                            known_frames[frame["inspection_id"]] = frame["status"]
                            await websocket.send_json({
                                "type": "inspection_state", "inspection_id": frame["inspection_id"],
                                "frame_id": frame["id"], "status": frame["status"],
                            })
                await websocket.send_json({"type": "heartbeat"})
        except (WebSocketDisconnect, RuntimeError):
            return

    @application.get("/api/v2/assessments/{assessment_id}/rooms/{room_id}/renovation-preview-context")
    def renovation_preview_context(assessment_id: str, room_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).renovation_preview_context(assessment_id, room_id)

    @application.post("/api/v2/assessments/{assessment_id}/rooms/{room_id}/renovation-previews", status_code=201)
    async def create_renovation_preview(assessment_id: str, room_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, RenovationPreviewCreate)
        return _service(request).create_renovation_preview(assessment_id, room_id, payload.source_media_id)

    @application.get("/api/v2/assessments/{assessment_id}/rooms/{room_id}/renovation-previews/{preview_id}")
    def renovation_preview(assessment_id: str, room_id: str, preview_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).renovation_preview(assessment_id, room_id, preview_id)

    @application.put("/api/v2/assessments/{assessment_id}/rooms/{room_id}/renovation-previews/{preview_id}:select")
    def select_renovation_preview(assessment_id: str, room_id: str, preview_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).select_renovation_preview(assessment_id, room_id, preview_id)

    @application.get("/api/v2/assessments/{assessment_id}/rooms/{room_id}/renovation-previews/{preview_id}/content")
    def renovation_preview_content(assessment_id: str, room_id: str, preview_id: str, request: Request) -> Response:
        _authorize(request, assessment_id)
        path, mime_type = _service(request).renovation_preview_content(assessment_id, room_id, preview_id)
        response = FileResponse(path, media_type=mime_type)
        response.headers["Cache-Control"] = "no-store"
        return response

    @application.post("/api/v2/assessments/{assessment_id}/risks/{risk_id}/feedback")
    async def feedback(assessment_id: str, risk_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, FeedbackCreate)
        return _service(request).feedback(assessment_id, risk_id, payload.model_dump())

    @application.put("/api/v2/assessments/{assessment_id}/risks/{risk_id}/region")
    async def update_region(assessment_id: str, risk_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, RegionUpdate)
        return _service(request).update_region(assessment_id, risk_id, payload.region)

    @application.get("/api/v2/assessments/{assessment_id}/risks/{risk_id}/solutions")
    def risk_solutions(assessment_id: str, risk_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).risk_solutions(assessment_id, risk_id)

    @application.put("/api/v2/assessments/{assessment_id}/risks/{risk_id}/selected-solution")
    async def select_solution(assessment_id: str, risk_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, SolutionUpdate)
        return _service(request).select_solution(assessment_id, risk_id, payload.solution_package_id)

    @application.delete("/api/v2/assessments/{assessment_id}/risks/{risk_id}/selected-solution", status_code=204)
    def remove_solution(assessment_id: str, risk_id: str, request: Request) -> Response:
        _authorize(request, assessment_id)
        _service(request).remove_solution(assessment_id, risk_id)
        return Response(status_code=204)

    @application.get("/api/v2/assessments/{assessment_id}/report")
    def report(assessment_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).report(assessment_id)

    @application.post("/api/v2/assessments/{assessment_id}:complete")
    def complete(assessment_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).complete(assessment_id)

    @application.post("/api/v2/assessments/{assessment_id}/share", status_code=201)
    def create_share(assessment_id: str, request: Request) -> dict[str, Any]:
        _authorize(request, assessment_id)
        return _service(request).create_share(assessment_id)

    @application.get("/api/v2/shared-reports/{token}")
    def shared_report(token: str, request: Request) -> dict[str, Any]:
        return _service(request).shared_report(token)

    @application.get("/api/v2/shared-reports/{token}/renovation-previews/{preview_id}/{kind}")
    def shared_renovation_preview_content(token: str, preview_id: str, kind: str, request: Request) -> Response:
        path, mime_type = _service(request).shared_renovation_preview_content(token, preview_id, kind)
        response = FileResponse(path, media_type=mime_type)
        response.headers["Cache-Control"] = "private, max-age=300"
        return response

    @application.post("/api/v2/assessments/{assessment_id}/analytics/events", status_code=202)
    async def analytics(assessment_id: str, request: Request) -> dict[str, bool]:
        _authorize(request, assessment_id)
        payload = await _read_model(request, AnalyticsCreate)
        event_name = payload.event_name[:64]
        if not event_name:
            raise AssessmentError("invalid_event")
        _service(request).event(assessment_id, payload.room_id, event_name, payload.payload)
        return {"accepted": True}

    @application.get("/{asset_path:path}", include_in_schema=False)
    def static_files(asset_path: str, request: Request) -> Response:
        root = request.app.state.static_root.resolve()
        relative = "index.html" if asset_path in {"", "index.html"} else asset_path
        candidate = (root / relative).resolve()
        if root not in candidate.parents and candidate != root:
            return JSONResponse({"message": "没有找到这个页面"}, status_code=404)
        if not (root / "index.html").is_file():
            return JSONResponse({"code": "frontend_not_built", "message": "前端尚未构建，请先执行 npm run build"}, status_code=503)
        if not candidate.is_file():
            return JSONResponse({"message": "没有找到这个页面"}, status_code=404)
        media_type = mimetypes.guess_type(candidate.name)[0]
        cache = "public, max-age=31536000, immutable" if relative.startswith("assets/") else "no-cache"
        return FileResponse(candidate, media_type=media_type, headers={"Cache-Control": cache})

    return application


app = create_app()
