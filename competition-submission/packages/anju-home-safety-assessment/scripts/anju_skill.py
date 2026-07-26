#!/usr/bin/env python3
"""Dependency-free client for the AnjuGuard v2 assessment workflow."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
from pathlib import Path
import struct
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ROOMS = {"bathroom", "bedroom", "living_room", "kitchen", "corridor", "balcony"}
INPUT_MODES = {"photo", "video_frame"}
MOBILITY = {"normal", "limited", "cane", "walker", "wheelchair"}
FALL_HISTORY = {"none", "once", "multiple"}
LIVING_STATUS = {"alone", "with_family"}
ORIENTATIONS = {"up", "down", "left", "right", "up_mirrored", "down_mirrored", "left_mirrored", "right_mirrored"}


class SkillError(RuntimeError):
    pass


class Client:
    def __init__(self, base_url: str, token: str | None = None, timeout: float = 65) -> None:
        self.base_url = validate_base_url(base_url)
        self.token = token
        self.timeout = timeout

    def request(self, method: str, path: str, *, value: Any = None, body: bytes | None = None, headers: dict[str, str] | None = None) -> Any:
        request_headers = {"Accept": "application/json", **(headers or {})}
        if self.token:
            request_headers["Authorization"] = f"Bearer {self.token}"
        if value is not None:
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = Request(f"{self.base_url}{path}", data=body, headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except HTTPError as error:
            raw = error.read()
            try:
                payload = json.loads(raw)
                detail = payload.get("message") or payload.get("code") or str(error)
            except (ValueError, AttributeError):
                detail = str(error)
            raise SkillError(f"API {error.code}: {detail}") from error
        except URLError as error:
            raise SkillError(f"无法连接评估服务: {error.reason}") from error


def validate_base_url(value: str) -> str:
    parsed = urlparse(value.rstrip("/"))
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path not in {"", "/"}:
        raise SkillError("base URL 必须是不带路径的 http(s) URL")
    if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SkillError("远程评估服务必须使用 HTTPS")
    return value.rstrip("/")


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SkillError(f"无法读取 JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise SkillError(f"JSON 顶层必须是对象: {path}")
    return value


def write_private_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    finally:
        os.chmod(path, 0o600)


def write_report(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def image_info(path: Path) -> tuple[str, int, int]:
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return "image/png", width, height
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8X":
            width = 1 + int.from_bytes(data[24:27], "little")
            height = 1 + int.from_bytes(data[27:30], "little")
            return "image/webp", width, height
        return "image/webp", 0, 0
    if data.startswith(b"\xff\xd8\xff"):
        index = 2
        while index + 9 < len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            index += 2
            if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
                continue
            if index + 2 > len(data):
                break
            length = int.from_bytes(data[index:index + 2], "big")
            if length < 2 or index + length > len(data):
                break
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height = int.from_bytes(data[index + 3:index + 5], "big")
                width = int.from_bytes(data[index + 5:index + 7], "big")
                return "image/jpeg", width, height
            index += length
        raise SkillError(f"无法读取 JPEG 尺寸: {path}")
    guessed = mimetypes.guess_type(path.name)[0]
    raise SkillError(f"不支持的图片格式 {guessed or 'unknown'}: {path}")


def require_choice(value: Any, allowed: set[str], label: str) -> str:
    if value not in allowed:
        raise SkillError(f"{label} 必须是: {', '.join(sorted(allowed))}")
    return str(value)


def validate_manifest(value: dict[str, Any]) -> None:
    require_choice(value.get("input_mode", "photo"), INPUT_MODES, "input_mode")
    profile = value.get("profile")
    if not isinstance(profile, dict):
        raise SkillError("profile 必须是对象")
    require_choice(profile.get("mobility"), MOBILITY, "mobility")
    require_choice(profile.get("fall_history"), FALL_HISTORY, "fall_history")
    require_choice(profile.get("living_status"), LIVING_STATUS, "living_status")
    planned = value.get("planned_rooms")
    if not isinstance(planned, list) or not planned or len(planned) != len(set(planned)) or any(item not in ROOMS for item in planned):
        raise SkillError("planned_rooms 必须是不重复的受支持房间列表")
    rooms = value.get("rooms")
    if not isinstance(rooms, list) or not rooms:
        raise SkillError("rooms 至少包含一个房间")
    room_types = [item.get("room_type") for item in rooms if isinstance(item, dict)]
    if len(room_types) != len(rooms) or len(room_types) != len(set(room_types)):
        raise SkillError("rooms 必须是不重复的房间对象")
    if any(room_type not in planned for room_type in room_types):
        raise SkillError("待分析房间必须包含在 planned_rooms 中")
    for room in rooms:
        require_choice(room.get("room_type"), ROOMS, "room_type")
        media = room.get("media")
        if not isinstance(media, list) or not 1 <= len(media) <= 6 or any(not isinstance(item, dict) or not item.get("path") for item in media):
            raise SkillError(f"{room['room_type']} 必须包含 1–6 个带 path 的媒体对象")


def check_health(client: Client, allow_demo: bool) -> None:
    health = client.request("GET", "/health")
    if health.get("version") != "v2":
        raise SkillError("服务未提供安居守护 v2 能力")
    mode = health.get("analysis")
    if mode == "not_configured":
        raise SkillError("正式分析服务尚未配置")
    if mode == "demo" and not allow_demo:
        raise SkillError("拒绝将 Demo 分析作为正式结果；仅测试时使用 --allow-demo")


def normalized_region(region: Any) -> bool:
    if not isinstance(region, dict):
        return False
    if region.get("type") == "bbox":
        values = [region.get(key) for key in ("x", "y", "width", "height")]
        if not all(isinstance(item, (int, float)) for item in values):
            return False
        x, y, width, height = (float(item) for item in values)
        return width > 0 and height > 0 and 0 <= x <= 1 and 0 <= y <= 1 and x + width <= 1.000001 and y + height <= 1.000001
    if region.get("type") == "polygon":
        points = region.get("points")
        return isinstance(points, list) and len(points) >= 3 and all(
            isinstance(point, list) and len(point) == 2 and all(isinstance(item, (int, float)) and 0 <= item <= 1 for item in point)
            for point in points
        )
    return False


def validate_report(report: dict[str, Any]) -> None:
    required = {"rooms", "coverage_percent", "assessed_area_score", "household_score", "budget", "rule_set_version", "price_rule_version"}
    missing = sorted(required - report.keys())
    if missing:
        raise SkillError(f"报告缺少字段: {', '.join(missing)}")
    for room in report.get("rooms", []):
        for risk in room.get("risks", []):
            if not normalized_region(risk.get("region")):
                raise SkillError(f"正式风险 {risk.get('risk_id', 'unknown')} 缺少有效归一化证据区域")
    if report.get("coverage_percent", 0) < 80 and report.get("household_score") is not None:
        raise SkillError("覆盖度不足时不得返回全屋分")


def upload_headers(item: dict[str, Any], mime: str, width: int, height: int, input_mode: str) -> dict[str, str]:
    source_kind = item.get("source_kind", "video_frame" if input_mode == "video_frame" else "photo")
    headers = {
        "Content-Type": mime,
        "X-Image-Width": str(width),
        "X-Image-Height": str(height),
        "X-Media-Source-Kind": source_kind,
        "X-Media-Orientation": require_choice(item.get("orientation", "up"), ORIENTATIONS, "orientation"),
    }
    optional = {
        "X-Media-Source-Id": item.get("source_id"),
        "X-Media-Frame-Index": item.get("frame_index"),
        "X-Media-Captured-At-Ms": item.get("captured_at_ms"),
        "X-Media-Perceptual-Hash": item.get("perceptual_hash"),
    }
    headers.update({key: str(value) for key, value in optional.items() if value is not None})
    return headers


def command_assess(args: argparse.Namespace) -> None:
    manifest_path = args.manifest.resolve()
    manifest = read_json(manifest_path)
    validate_manifest(manifest)
    client = Client(args.base_url)
    check_health(client, args.allow_demo)
    created = client.request("POST", "/api/v2/assessments", value={
        "input_mode": manifest.get("input_mode", "photo"),
        "planned_rooms": manifest["planned_rooms"],
    })
    client.token = created["access_token"]
    assessment_id = created["assessment_id"]
    session = {"base_url": client.base_url, "assessment_id": assessment_id, "access_token": client.token}
    write_private_json(args.session, session)
    prefix = f"/api/v2/assessments/{assessment_id}"
    client.request("PUT", f"{prefix}/profile", value=manifest["profile"])
    client.request("PUT", f"{prefix}/planned-rooms", value={"planned_rooms": manifest["planned_rooms"]})
    for room in manifest["rooms"]:
        created_room = client.request("POST", f"{prefix}/rooms", value={"room_type": room["room_type"]})
        room_id = created_room["room_id"]
        usable = 0
        for item in room["media"]:
            path = Path(item["path"])
            if not path.is_absolute():
                path = manifest_path.parent / path
            if not path.is_file():
                raise SkillError(f"图片不存在: {path}")
            mime, detected_width, detected_height = image_info(path)
            width = int(item.get("width", detected_width))
            height = int(item.get("height", detected_height))
            if not 1 <= width <= 8192 or not 1 <= height <= 8192:
                raise SkillError(f"请为图片提供 1–8192 范围内的 width/height: {path}")
            uploaded = client.request(
                "POST", f"{prefix}/rooms/{room_id}/media", body=path.read_bytes(),
                headers=upload_headers(item, mime, width, height, manifest.get("input_mode", "photo")),
            )
            usable += int(bool(uploaded.get("quality", {}).get("usable")))
        if usable == 0:
            raise SkillError(f"{room['room_type']} 没有通过质量检查的图片")
        client.request("POST", f"{prefix}/rooms/{room_id}:analyze")
        deadline = time.monotonic() + args.poll_timeout
        while True:
            status = client.request("GET", f"{prefix}/rooms/{room_id}/status")
            if status.get("status") == "completed":
                break
            if status.get("status") == "failed":
                raise SkillError(f"{room['room_type']} 分析失败: {status.get('error') or 'analysis_failed'}")
            if time.monotonic() >= deadline:
                raise SkillError(f"{room['room_type']} 轮询超时；服务端可能仍在处理")
            time.sleep(args.poll_interval)
    report = client.request("GET", f"{prefix}/report")
    validate_report(report)
    write_report(args.output, report)
    print(f"评估完成: {assessment_id}\n报告: {args.output}\n私密会话: {args.session}")


def load_session(path: Path) -> tuple[Client, str]:
    session = read_json(path)
    assessment_id = session.get("assessment_id")
    token = session.get("access_token")
    if not isinstance(assessment_id, str) or not isinstance(token, str):
        raise SkillError("会话文件缺少 assessment_id 或 access_token")
    return Client(str(session.get("base_url", "")), token), assessment_id


def command_select(args: argparse.Namespace) -> None:
    client, assessment_id = load_session(args.session)
    payload = read_json(args.choices)
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise SkillError("choices 必须是非空列表")
    seen: set[str] = set()
    prefix = f"/api/v2/assessments/{assessment_id}"
    for choice in choices:
        if not isinstance(choice, dict) or not isinstance(choice.get("risk_id"), str) or not isinstance(choice.get("solution_package_id"), str):
            raise SkillError("每个 choice 必须包含字符串 risk_id 和 solution_package_id")
        risk_id = choice["risk_id"]
        if risk_id in seen:
            raise SkillError(f"risk_id 重复: {risk_id}")
        seen.add(risk_id)
        client.request("PUT", f"{prefix}/risks/{risk_id}/selected-solution", value={"solution_package_id": choice["solution_package_id"]})
    report = client.request("GET", f"{prefix}/report")
    validate_report(report)
    write_report(args.output, report)
    print(f"已更新 {len(choices)} 个整改选择\n报告: {args.output}")


def command_report(args: argparse.Namespace) -> None:
    client, assessment_id = load_session(args.session)
    report = client.request("GET", f"/api/v2/assessments/{assessment_id}/report")
    validate_report(report)
    write_report(args.output, report)
    print(f"报告: {args.output}")


def command_delete(args: argparse.Namespace) -> None:
    client, assessment_id = load_session(args.session)
    client.request("DELETE", f"/api/v2/assessments/{assessment_id}")
    args.session.unlink(missing_ok=True)
    print(f"评估已删除: {assessment_id}")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="安居守护家庭安全评估 Skill 客户端")
    commands = root.add_subparsers(dest="command", required=True)
    assess = commands.add_parser("assess", help="创建并运行评估")
    assess.add_argument("--manifest", type=Path, required=True)
    assess.add_argument("--output", type=Path, required=True)
    assess.add_argument("--session", type=Path, required=True)
    assess.add_argument("--base-url", default=os.environ.get("ANJU_API_BASE_URL", "http://127.0.0.1:8080"))
    assess.add_argument("--poll-timeout", type=float, default=180)
    assess.add_argument("--poll-interval", type=float, default=1.5)
    assess.add_argument("--allow-demo", action="store_true", help="仅用于显式 Demo/Mock 测试")
    assess.set_defaults(function=command_assess)
    select = commands.add_parser("select", help="提交用户明确选择的整改方案")
    select.add_argument("--session", type=Path, required=True)
    select.add_argument("--choices", type=Path, required=True)
    select.add_argument("--output", type=Path, required=True)
    select.set_defaults(function=command_select)
    report = commands.add_parser("report", help="重新读取报告")
    report.add_argument("--session", type=Path, required=True)
    report.add_argument("--output", type=Path, required=True)
    report.set_defaults(function=command_report)
    delete = commands.add_parser("delete", help="删除评估及本地会话")
    delete.add_argument("--session", type=Path, required=True)
    delete.set_defaults(function=command_delete)
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        args.function(args)
        return 0
    except (SkillError, OSError, ValueError) as error:
        print(f"错误: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
