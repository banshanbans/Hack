"""Volcengine RTC voice-session adapter.

The RTC token encoding follows Volcengine's BSD-3-Clause rtc-aigc-demo
(`Server/token.js`, copyright 2025 Beijing Volcano Engine Technology Co., Ltd.).
Only short-lived client tokens are returned; AppKey, AK/SK and ASR/TTS
credentials remain server-side.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import threading
import time
from urllib.parse import quote

import httpx


class VoiceProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class VoiceConnection:
    app_id: str
    room_id: str
    user_id: str
    bot_user_id: str
    task_id: str
    token: str
    expires_at: str


def _u16(value: int) -> bytes:
    return struct.pack("<H", value)


def _u32(value: int) -> bytes:
    return struct.pack("<I", value)


def _bytes(value: bytes) -> bytes:
    if len(value) > 0xFFFF:
        raise VoiceProviderError("rtc_token_value_too_large")
    return _u16(len(value)) + value


def _string(value: str) -> bytes:
    return _bytes(value.encode("utf-8"))


def build_rtc_token(app_id: str, app_key: str, room_id: str, user_id: str, expires_at: int) -> str:
    """Generate the official version-001 RTC token with audio/data privileges."""
    if len(app_id) != 24 or not app_key or not room_id or not user_id:
        raise VoiceProviderError("rtc_credentials_invalid")
    issued_at = int(time.time())
    privileges = {0: expires_at, 1: expires_at, 2: expires_at, 3: expires_at, 4: expires_at}
    packed = b"".join([
        _u32(secrets.randbits(32)),
        _u32(issued_at),
        _u32(expires_at),
        _string(room_id),
        _string(user_id),
        _u16(len(privileges)),
        b"".join(_u16(key) + _u32(value) for key, value in sorted(privileges.items())),
    ])
    signature = hmac.new(app_key.encode("utf-8"), packed, hashlib.sha256).digest()
    content = _bytes(packed) + _bytes(signature)
    return "001" + app_id + base64.b64encode(content).decode("ascii")


class VolcengineVoiceProvider:
    endpoint = "https://rtc.volcengineapi.com"
    service = "rtc"
    region = "cn-north-1"
    _video_probe_lock = threading.Lock()
    _video_probe_succeeded_at = 0.0

    @classmethod
    def configured(cls) -> bool:
        required = (
            "ANJU_VOLC_RTC_APP_ID",
            "ANJU_VOLC_RTC_APP_KEY",
            "ANJU_VOLC_ACCESS_KEY",
            "ANJU_VOLC_SECRET_KEY",
            "ANJU_VOLC_VOICE_CONFIG_JSON",
        )
        return os.environ.get("ANJU_ENABLE_VOICE_ADVISOR", "0") == "1" and all(
            os.environ.get(key, "").strip() for key in required
        )

    @classmethod
    def video_configured(cls) -> bool:
        callback = os.environ.get("ANJU_VOLC_FC_CALLBACK_URL", "").strip()
        signature = os.environ.get("ANJU_VOLC_FC_CALLBACK_SIGNATURE", "").strip()
        if not (
            cls.configured()
            and os.environ.get("ANJU_ENABLE_RTC_VIDEO_ADVISOR", "0") == "1"
            and callback.startswith("https://")
            and len(signature) >= 24
        ):
            return False
        try:
            template = json.loads(os.environ["ANJU_VOLC_VOICE_CONFIG_JSON"])
        except (TypeError, ValueError, json.JSONDecodeError):
            return False
        config = template.get("Config") if isinstance(template, dict) else None
        llm = config.get("LLMConfig") if isinstance(config, dict) else None
        return isinstance(llm, dict)

    @classmethod
    def mark_video_probe_success(cls) -> None:
        with cls._video_probe_lock:
            cls._video_probe_succeeded_at = time.monotonic()

    @classmethod
    def video_healthy(cls) -> bool:
        with cls._video_probe_lock:
            succeeded_at = cls._video_probe_succeeded_at
            age = time.monotonic() - succeeded_at
        return succeeded_at > 0 and cls.video_configured() and 0 <= age <= 30 * 60

    def start(
        self, session_id: str, welcome: str, system_context: str,
        *, video_enabled: bool = False, tools: list[dict] | None = None,
    ) -> VoiceConnection:
        if not self.configured():
            raise VoiceProviderError("voice_not_configured")
        app_id = os.environ["ANJU_VOLC_RTC_APP_ID"].strip()
        app_key = os.environ["ANJU_VOLC_RTC_APP_KEY"].strip()
        compact = session_id.replace("-", "")
        room_id = f"anju_{compact[:24]}"
        user_id = f"user_{compact[:20]}"
        bot_user_id = f"advisor_{compact[:16]}"
        task_id = f"task_{compact[:20]}"
        expires_at_epoch = int(time.time()) + 15 * 60
        token = build_rtc_token(app_id, app_key, room_id, user_id, expires_at_epoch)

        try:
            template = json.loads(os.environ["ANJU_VOLC_VOICE_CONFIG_JSON"])
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise VoiceProviderError("voice_config_invalid") from error
        if not isinstance(template, dict):
            raise VoiceProviderError("voice_config_invalid")
        body = deepcopy(template)
        body["AppId"] = app_id
        body["RoomId"] = room_id
        body["TaskId"] = task_id
        agent = body.setdefault("AgentConfig", {})
        config = body.setdefault("Config", {})
        if not isinstance(agent, dict) or not isinstance(config, dict):
            raise VoiceProviderError("voice_config_invalid")
        agent["TargetUserId"] = [user_id]
        agent["UserId"] = bot_user_id
        agent["WelcomeMessage"] = welcome[:300]
        agent["EnableConversationStateCallback"] = True
        llm = config.setdefault("LLMConfig", {})
        if not isinstance(llm, dict):
            raise VoiceProviderError("voice_config_invalid")
        safety = (
            "你是安心家AI适老顾问。只根据随附的结构化检查上下文回答。临时建议不得称为正式风险，"
            "不得编造照度、尺寸、价格、工期、墙体、防水或管线事实。价格只能复述上下文中的规则区间；"
            "选择方案或开始分析必须提示用户在页面确认。回答简短、温和、适合语音播报。"
            "扫描时一次只给一个动作，主动语音指引之间至少间隔8秒；"
            "用户正在说话、画面不清、快速移动或上下文不明确时不要主动播报，先请用户停稳或靠近。"
            "只有收到带 inspection_id 的显式稳定画面时，才可调用 record_camera_suggestions；"
            "工具参数不得包含风险等级、评分、价格、工期或测量值。\n" + system_context
        )
        messages = llm.get("SystemMessages")
        if not isinstance(messages, list):
            messages = []
        llm["SystemMessages"] = [*messages, safety]
        if video_enabled:
            vision = llm.setdefault("VisionConfig", {})
            if not isinstance(vision, dict):
                raise VoiceProviderError("voice_config_invalid")
            vision["Enable"] = True
            snapshot = vision.setdefault("SnapshotConfig", {})
            if not isinstance(snapshot, dict):
                raise VoiceProviderError("voice_config_invalid")
            snapshot.update({
                "Interval": 900,
                "ImagesLimit": 1,
                "Height": 720,
                "ImageDetail": "low",
            })
            llm["ThinkingType"] = "disabled"
            llm["Tools"] = tools or []
            config["FunctionCallingConfig"] = {
                "ServerMessageUrl": os.environ["ANJU_VOLC_FC_CALLBACK_URL"].strip(),
                "ServerMessageSignature": os.environ["ANJU_VOLC_FC_CALLBACK_SIGNATURE"].strip(),
            }
        self._call("StartVoiceChat", body)
        expires_at = datetime.fromtimestamp(expires_at_epoch, tz=timezone.utc).isoformat()
        return VoiceConnection(app_id, room_id, user_id, bot_user_id, task_id, token, expires_at)

    def stop(self, connection: VoiceConnection) -> None:
        if not self.configured():
            return
        self._call("StopVoiceChat", {
            "AppId": connection.app_id,
            "RoomId": connection.room_id,
            "TaskId": connection.task_id,
        })

    def update_function_result(
        self, *, app_id: str, room_id: str, task_id: str,
        tool_call_id: str, result: dict,
    ) -> dict:
        return self._call("UpdateVoiceChat", {
            "AppId": app_id,
            "RoomId": room_id,
            "TaskId": task_id,
            "Command": "function",
            "Message": json.dumps({
                "ToolCallID": tool_call_id,
                "Content": json.dumps(result, ensure_ascii=False, separators=(",", ":")),
            }, ensure_ascii=False, separators=(",", ":")),
            "InterruptMode": 2,
        })

    def _call(self, action: str, body: dict) -> dict:
        version = os.environ.get("ANJU_VOLC_VOICE_API_VERSION", "2025-06-01").strip()
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        now = datetime.now(timezone.utc)
        x_date = now.strftime("%Y%m%dT%H%M%SZ")
        date = now.strftime("%Y%m%d")
        content_hash = hashlib.sha256(payload).hexdigest()
        query = f"Action={quote(action, safe='-_.~')}&Version={quote(version, safe='-_.~')}"
        canonical_headers = (
            "content-type:application/json\n"
            "host:rtc.volcengineapi.com\n"
            f"x-content-sha256:{content_hash}\n"
            f"x-date:{x_date}\n"
        )
        signed_headers = "content-type;host;x-content-sha256;x-date"
        canonical_request = "\n".join([
            "POST", "/", query, canonical_headers, signed_headers, content_hash,
        ])
        scope = f"{date}/{self.region}/{self.service}/request"
        string_to_sign = "\n".join([
            "HMAC-SHA256", x_date, scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ])
        secret = os.environ["ANJU_VOLC_SECRET_KEY"].encode("utf-8")
        date_key = hmac.new(secret, date.encode("utf-8"), hashlib.sha256).digest()
        region_key = hmac.new(date_key, self.region.encode("utf-8"), hashlib.sha256).digest()
        service_key = hmac.new(region_key, self.service.encode("utf-8"), hashlib.sha256).digest()
        signing_key = hmac.new(service_key, b"request", hashlib.sha256).digest()
        signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        authorization = (
            f"HMAC-SHA256 Credential={os.environ['ANJU_VOLC_ACCESS_KEY'].strip()}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        headers = {
            "Content-Type": "application/json",
            "Host": "rtc.volcengineapi.com",
            "X-Content-Sha256": content_hash,
            "X-Date": x_date,
            "Authorization": authorization,
        }
        try:
            response = httpx.post(f"{self.endpoint}?{query}", content=payload, headers=headers, timeout=8.0)
            response.raise_for_status()
            value = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise VoiceProviderError("voice_provider_unavailable") from error
        if not isinstance(value, dict) or value.get("ResponseMetadata", {}).get("Error"):
            raise VoiceProviderError("voice_provider_rejected")
        return value
