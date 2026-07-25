from __future__ import annotations

from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
from urllib.parse import urlparse

from .service import SessionService, demo_analysis, empty_analysis


LOGGER = logging.getLogger("anjuguard.backend")
SERVICE = SessionService()
STATIC_ROOT = Path(__file__).resolve().parent.parent / "static"
MAX_BODY_BYTES = 6 * 1024 * 1024
SESSION_FRAME_PATTERN = re.compile(r"^/api/v1/sessions/([^/]+)/frames:analyze$")
SESSION_ISSUE_PATTERN = re.compile(r"^/api/v1/sessions/([^/]+)/issues/([^/]+)$")
SESSION_COMPLETE_PATTERN = re.compile(r"^/api/v1/sessions/([^/]+):complete$")
SESSION_SHARE_PATTERN = re.compile(r"^/api/v1/sessions/([^/]+)/share$")
SHARE_PATTERN = re.compile(r"^/api/v1/reports/([^/]+)$")


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "AnjuGuardLocal/0.1"

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok", "analysis": "mock" if _mock_enabled() else "empty"})
            return
        if path in {"/", "/index.html"}:
            self._static("index.html", "text/html; charset=utf-8")
            return
        match = SHARE_PATTERN.match(path)
        if match:
            report = SERVICE.shared_report(match.group(1))
            self._json(HTTPStatus.OK if report else HTTPStatus.NOT_FOUND, report or {"message": "链接已失效"})
            return
        self._json(HTTPStatus.NOT_FOUND, {"message": "没有找到这个页面"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/v1/sessions":
            payload = self._read_json()
            if payload is None:
                return
            record = SERVICE.create_session(payload)
            self._json(HTTPStatus.CREATED, {"session_id": record.id})
            return

        frame_match = SESSION_FRAME_PATTERN.match(path)
        if frame_match:
            session_id = frame_match.group(1)
            if SERVICE.get_session(session_id) is None:
                self._json(HTTPStatus.NOT_FOUND, {"message": "本次检查已结束"})
                return
            frame_id = self.headers.get("X-Frame-ID", "")
            body = self._read_body()
            if body is None:
                return
            if not frame_id or not body:
                self._json(HTTPStatus.BAD_REQUEST, {"message": "这张照片没有看清"})
                return
            analysis = demo_analysis(frame_id) if _mock_enabled() else empty_analysis(frame_id)
            accepted = SERVICE.record_analysis(session_id, frame_id, analysis["issues"])
            response_issues = [
                {key: value for key, value in issue.items() if key not in {"id", "state", "frame_id"}}
                for issue in accepted
            ]
            self._json(HTTPStatus.OK, {"frame_id": frame_id, "issues": response_issues})
            return

        complete_match = SESSION_COMPLETE_PATTERN.match(path)
        if complete_match:
            try:
                self._json(HTTPStatus.OK, SERVICE.complete(complete_match.group(1)))
            except KeyError:
                self._json(HTTPStatus.NOT_FOUND, {"message": "本次检查已结束"})
            return

        share_match = SESSION_SHARE_PATTERN.match(path)
        if share_match:
            try:
                token, expires_at = SERVICE.create_share(share_match.group(1))
                self._json(
                    HTTPStatus.CREATED,
                    {"token": token, "path": f"/api/v1/reports/{token}", "expires_at": expires_at.isoformat()},
                )
            except KeyError:
                self._json(HTTPStatus.NOT_FOUND, {"message": "本次检查已结束"})
            return

        self._json(HTTPStatus.NOT_FOUND, {"message": "没有找到这个页面"})

    def do_PATCH(self) -> None:  # noqa: N802
        match = SESSION_ISSUE_PATTERN.match(urlparse(self.path).path)
        if not match:
            self._json(HTTPStatus.NOT_FOUND, {"message": "没有找到这项内容"})
            return
        payload = self._read_json()
        if payload is None:
            return
        try:
            issue = SERVICE.update_issue(match.group(1), match.group(2), payload.get("state", ""))
            self._json(HTTPStatus.OK, issue)
        except ValueError:
            self._json(HTTPStatus.BAD_REQUEST, {"message": "这个状态暂时不能使用"})
        except KeyError:
            self._json(HTTPStatus.NOT_FOUND, {"message": "没有找到这项内容"})

    def log_message(self, format: str, *args: object) -> None:
        LOGGER.info("request %s", format % args)

    def _read_body(self) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"message": "照片太大，请重新拍一下"})
            return None
        return self.rfile.read(length)

    def _read_json(self) -> dict | None:
        try:
            body = self._read_body()
            if body is None:
                return None
            value = json.loads(body)
            if not isinstance(value, dict):
                raise ValueError("expected object")
            return value
        except (ValueError, json.JSONDecodeError):
            self._json(HTTPStatus.BAD_REQUEST, {"message": "这次内容没有看清"})
            return None

    def _json(self, status: HTTPStatus, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _static(self, filename: str, content_type: str) -> None:
        data = (STATIC_ROOT / filename).read_bytes()
        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'")
        self.end_headers()
        self.wfile.write(data)


def _mock_enabled() -> bool:
    return os.environ.get("ANJU_MOCK_ANALYSIS") == "1"


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    host = os.environ.get("ANJU_HOST", "127.0.0.1")
    port = int(os.environ.get("ANJU_PORT", "8080"))
    LOGGER.info("starting local server on http://%s:%s", host, port)
    server = ThreadingHTTPServer((host, port), RequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("local server stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
