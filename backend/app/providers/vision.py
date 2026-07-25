from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import socket
import time
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ProviderError(RuntimeError):
    def __init__(self, code: str, retryable: bool = True) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


class VisionProvider(Protocol):
    provider_name: str
    model_name: str
    prompt_version: str

    def quality(self, assessment_id: str, media: dict) -> tuple[dict, dict]: ...
    def analyze(self, assessment_id: str, room_type: str, media: list[dict], allowed_risks: list[str]) -> tuple[dict, dict]: ...


QUALITY_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["usable", "clear", "floor_visible", "path_visible", "lighting_sufficient", "major_occlusion", "scene_elements", "missing_views"],
    "properties": {
        "usable": {"type": "boolean"},
        "clear": {"type": "boolean"},
        "floor_visible": {"type": "boolean"},
        "path_visible": {"type": "boolean"},
        "lighting_sufficient": {"type": "boolean"},
        "major_occlusion": {"type": "boolean"},
        "scene_elements": {"type": "array", "items": {"type": "string", "enum": ["floor", "entrance_threshold", "shower", "toilet", "support_wall", "lighting"]}},
        "missing_views": {"type": "array", "items": {"type": "string"}},
    },
}


ANALYSIS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["room_type", "scene_elements", "risk_candidates"],
    "properties": {
        "room_type": {"type": "string"},
        "scene_elements": {"type": "array", "items": {"type": "string", "enum": ["floor", "entrance_threshold", "shower", "toilet", "support_wall", "lighting"]}},
        "risk_candidates": {
            "type": "array",
            "maxItems": 12,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["risk_code", "media_id", "title", "evidence", "confidence", "needs_manual_check", "region"],
                "properties": {
                    "risk_code": {"type": "string"},
                    "media_id": {"type": "string"},
                    "title": {"type": "string"},
                    "evidence": {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "needs_manual_check": {"type": "boolean"},
                    "region": {
                        "anyOf": [
                            {"type": "null"},
                            {
                                "type": "object", "additionalProperties": False,
                                "required": ["type", "x", "y", "width", "height", "points"],
                                "properties": {
                                    "type": {"type": "string", "enum": ["bbox", "polygon"]},
                                    "x": {"type": ["number", "null"]}, "y": {"type": ["number", "null"]},
                                    "width": {"type": ["number", "null"]}, "height": {"type": ["number", "null"]},
                                    "points": {"type": ["array", "null"], "items": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2}},
                                },
                            },
                        ]
                    },
                },
            },
        },
    },
}


@dataclass
class OpenAIVisionProvider:
    api_key: str
    model_name: str = "gpt-5.6-sol"
    timeout_seconds: float = 60.0
    endpoint: str = "https://api.openai.com/v1/responses"
    prompt_version: str = "anju_vision_v2"
    provider_name: str = "openai"

    def _generation_options(self) -> dict:
        return {"reasoning": {"effort": "medium"}}

    def _image_detail(self, detail: str) -> str:
        return detail

    def quality(self, assessment_id: str, media: dict) -> tuple[dict, dict]:
        prompt = (
            "检查这张居家卫生间照片是否适合做环境安全辅助筛查。只描述画面中可观察的内容。"
            "判断清晰度、主要地面和通道、光线、遮挡，并从允许的场景要素中选择已清楚拍到的项。"
            "不要输出医疗结论，也不要把未拍到的区域当作安全。"
        )
        return self._request(assessment_id, prompt, [media], QUALITY_SCHEMA, "media_quality", "low")

    def analyze(self, assessment_id: str, room_type: str, media: list[dict], allowed_risks: list[str]) -> tuple[dict, dict]:
        media_ids = [item["media_id"] for item in media]
        prompt = (
            "你正在辅助筛查老人家庭卫生间的环境跌倒与行动风险。只报告图片中可观察且有证据的候选，"
            "不得推断遮挡区域，不得给最终风险等级、分数、价格、施工结论、HTML 或 SVG。"
            f"只允许 risk_code: {allowed_risks}。media_id 必须从 {media_ids} 选择。"
            "bbox 坐标为相对对应原图的 0 到 1 值；无法可靠定位时 region 为 null 且 needs_manual_check 为 true。"
            "玻璃门、毛巾架和吸盘装置不能默认视为可靠支撑。避免重复报告同一照片中的同一风险。"
        )
        return self._request(assessment_id, prompt, media, ANALYSIS_SCHEMA, "risk_analysis", "original")

    def _request(self, assessment_id: str, prompt: str, media: list[dict], schema: dict, schema_name: str, detail: str) -> tuple[dict, dict]:
        content: list[dict] = [{"type": "input_text", "text": prompt}]
        for item in media:
            encoded = base64.b64encode(Path(item["path"]).read_bytes()).decode("ascii")
            content.append({
                "type": "input_image",
                "image_url": f"data:{item['mime_type']};base64,{encoded}",
                "detail": self._image_detail(detail),
            })
        payload = {
            "model": self.model_name,
            "store": False,
            "safety_identifier": hashlib.sha256(assessment_id.encode("utf-8")).hexdigest(),
            "input": [{"role": "user", "content": content}],
            "text": {"format": {"type": "json_schema", "name": schema_name, "strict": True, "schema": schema}},
        }
        payload.update(self._generation_options())
        last_error: ProviderError | None = None
        for attempt in range(2):
            try:
                request = Request(self.endpoint, data=json.dumps(payload).encode("utf-8"), method="POST", headers={
                    "Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"
                })
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    response_data = json.loads(response.read())
                parsed = self._extract(response_data)
                return parsed, self._usage(response_data, attempt)
            except HTTPError as error:
                retryable = error.code == 429 or error.code >= 500
                last_error = ProviderError(f"provider_http_{error.code}", retryable)
            except (URLError, TimeoutError, socket.timeout):
                last_error = ProviderError("provider_timeout", True)
            except (ValueError, KeyError, json.JSONDecodeError):
                last_error = ProviderError("provider_invalid_response", True)
            if not last_error.retryable or attempt == 1:
                raise last_error
            time.sleep(0.25)
        raise last_error or ProviderError("provider_failed")

    def _extract(self, response: dict) -> dict:
        if response.get("status") not in {"completed", None}:
            raise ValueError("response incomplete")
        for output in response.get("output", []):
            for content in output.get("content", []):
                if content.get("type") == "refusal":
                    raise ProviderError("provider_refusal", False)
                if content.get("type") == "output_text":
                    value = json.loads(content["text"])
                    if not isinstance(value, dict):
                        raise ValueError("expected object")
                    return value
        raise ValueError("missing output")

    def _usage(self, response: dict, retry_count: int) -> dict:
        usage = response.get("usage", {})
        return {
            "model_name": response.get("model", self.model_name),
            "prompt_version": self.prompt_version,
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "latency_ms": None,
            "schema_valid": True,
            "retry_count": retry_count,
            "fallback_used": False,
            "error_type": None,
        }


class MockVisionProvider:
    provider_name = "demo"
    model_name = "anju-explicit-demo"
    prompt_version = "demo_fixture_v2"

    def quality(self, assessment_id: str, media: dict) -> tuple[dict, dict]:
        return ({
            "usable": True, "clear": True, "floor_visible": True, "path_visible": True,
            "lighting_sufficient": True, "major_occlusion": False,
            "scene_elements": ["floor", "entrance_threshold", "shower", "toilet", "support_wall", "lighting"],
            "missing_views": [],
        }, self._usage())

    def analyze(self, assessment_id: str, room_type: str, media: list[dict], allowed_risks: list[str]) -> tuple[dict, dict]:
        media_id = media[0]["media_id"]
        candidates = [
            ("BATH_NO_GRAB_BAR", "淋浴区缺少稳定支撑点", "淋浴区入口及内部未看到可靠固定扶手", 0.91, [0.55, 0.25, 0.25, 0.32]),
            ("BATH_WET_FLOOR", "地面湿滑容易失足", "淋浴区域地面可见水迹", 0.86, [0.28, 0.66, 0.45, 0.25]),
            ("FALL_THRESHOLD_HEIGHT", "门槛存在绊倒风险", "入口位置可见明显高度差", 0.74, [0.05, 0.64, 0.28, 0.16]),
            ("FALL_TRIP_LOOSE_MAT", "松动地垫可能滑移", "通行区域存在活动地垫", 0.72, [0.34, 0.55, 0.24, 0.16]),
            ("LIGHTING_NIGHT_INSUFFICIENT", "夜间照明可能不足", "主要通道附近未看到夜间辅助照明", 0.64, [0.02, 0.12, 0.20, 0.24]),
        ]
        return ({
            "room_type": room_type,
            "scene_elements": ["floor", "entrance_threshold", "shower", "toilet", "support_wall", "lighting"],
            "risk_candidates": [{
                "risk_code": code, "media_id": media_id, "title": title, "evidence": evidence,
                "confidence": confidence, "needs_manual_check": confidence < 0.8,
                "region": {"type": "bbox", "x": box[0], "y": box[1], "width": box[2], "height": box[3], "points": None},
            } for code, title, evidence, confidence, box in candidates if code in allowed_risks],
        }, self._usage())

    def _usage(self) -> dict:
        return {"model_name": self.model_name, "prompt_version": self.prompt_version, "input_tokens": 0, "output_tokens": 0, "latency_ms": 0, "schema_valid": True, "retry_count": 0, "fallback_used": False, "error_type": None}


@dataclass
class ArkVisionProvider(OpenAIVisionProvider):
    model_name: str = "doubao-seed-2-1-turbo-260628"
    endpoint: str = "https://ark.cn-beijing.volces.com/api/v3/responses"
    prompt_version: str = "anju_vision_v2_ark"
    provider_name: str = "ark"

    def _generation_options(self) -> dict:
        # Ark Responses API uses `thinking`, rather than OpenAI's `reasoning`,
        # to control deep-thinking output.
        return {"thinking": {"type": "disabled"}}

    def _image_detail(self, detail: str) -> str:
        # Ark accepts low/high/auto, while OpenAI's newest Responses models also
        # expose original. Preserve the highest supported Ark detail level.
        return "high" if detail == "original" else detail


def provider_from_environment() -> VisionProvider:
    if os.environ.get("ANJU_MOCK_ANALYSIS") == "1":
        return MockVisionProvider()

    provider_name = os.environ.get("ANJU_VISION_PROVIDER", "openai").strip().lower()
    timeout_seconds = float(os.environ.get("ANJU_ANALYSIS_TIMEOUT_SECONDS", "60"))
    if provider_name == "ark":
        api_key = os.environ.get("ARK_API_KEY", "").strip()
        if not api_key:
            raise ProviderError("provider_not_configured", False)
        return ArkVisionProvider(
            api_key=api_key,
            model_name=os.environ.get("ANJU_ARK_MODEL", "doubao-seed-2-1-turbo-260628"),
            endpoint=os.environ.get("ANJU_ARK_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3/responses"),
            timeout_seconds=timeout_seconds,
        )
    if provider_name != "openai":
        raise ProviderError("provider_not_configured", False)

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ProviderError("provider_not_configured", False)
    return OpenAIVisionProvider(
        api_key=api_key,
        model_name=os.environ.get("ANJU_OPENAI_MODEL", "gpt-5.6-sol"),
        timeout_seconds=timeout_seconds,
    )
