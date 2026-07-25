from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
import json
import logging
import mimetypes
import os
from typing import Any, AsyncIterator, Optional, TypeVar

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .assessment_service import AssessmentError, AssessmentService
from .providers import VisionProvider
from .repositories import SQLiteRepository
from .service import SessionService, demo_analysis, empty_analysis


LOGGER = logging.getLogger("anjuguard.backend")
PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STATIC_ROOT = PROJECT_ROOT / "frontend" / "dist"
MAX_BODY_BYTES = 6 * 1024 * 1024
STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

ERROR_MESSAGES = {
    "assessment_access_denied": "没有找到这次检查或访问已失效",
    "assessment_not_found": "没有找到这次检查",
    "profile_incomplete": "请完成三项家人情况",
    "invalid_room_type": "暂不支持这个房间",
    "room_rules_not_ready": "这个房间的完整规则仍在完善中",
    "invalid_image_format": "照片格式暂不支持，请重新选择",
    "invalid_image_dimensions": "照片尺寸不正确，请重新选择",
    "too_many_images": "每个房间最多上传 6 张照片",
    "no_usable_media": "至少需要一张可以看清的照片",
    "provider_not_configured": "分析服务尚未配置",
    "provider_timeout": "分析时间较长，请稍后重试",
    "provider_invalid_response": "这次没有看清，请重新分析",
    "provider_refusal": "这张照片暂时无法完成分析",
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


class RoomCreate(DTO):
    room_type: str


class FeedbackCreate(DTO):
    feedback: str


class RegionUpdate(DTO):
    region: dict[str, Any]


class SolutionUpdate(DTO):
    solution_package_id: str


class AnalyticsCreate(DTO):
    event_name: str
    room_id: Optional[str] = None
    payload: dict[str, Any] = Field(default_factory=dict)


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


def _service(request: Request) -> AssessmentService:
    return request.app.state.v2_service


def _v1(request: Request) -> SessionService:
    return request.app.state.v1_service


def _authorize(request: Request, assessment_id: str) -> None:
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.startswith("Bearer ") else ""
    _service(request).authorize(assessment_id, token)


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
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = STRICT_CSP
        if request.url.path.startswith("/api/") or request.url.path == "/health":
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(AssessmentError)
    async def assessment_error_handler(_request: Request, error: AssessmentError) -> JSONResponse:
        message = ERROR_MESSAGES.get(error.code, "这次操作没有完成，请稍后重试")
        if error.code == "request_too_large":
            message = "照片太大，请压缩后重试"
        return JSONResponse({"code": error.code, "message": message}, status_code=error.status)

    @application.exception_handler(RequestValidationError)
    async def request_validation_handler(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return JSONResponse({"code": "invalid_request", "message": ERROR_MESSAGES["invalid_request"]}, status_code=400)

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "analysis": _analysis_mode(), "version": "v2"}

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
        body = await _read_limited_body(request)
        return _service(request).upload_media(assessment_id, room_id, body, mime_type, width, height)

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
