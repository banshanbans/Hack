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


ROOM_SCENE_ELEMENTS = {
    "bathroom": ["floor", "entrance_threshold", "shower", "toilet", "support_wall", "lighting"],
    "bedroom": ["floor", "bed", "bedside", "wardrobe", "walking_path", "lighting", "switch"],
    "living_room": ["floor", "sofa", "coffee_table", "rug", "cable", "walking_path", "lighting"],
    "kitchen": ["floor", "counter", "stove", "sink", "storage", "walking_path", "lighting"],
    "corridor": ["floor", "doorway", "entrance_threshold", "shoe_area", "handrail", "walking_path", "lighting"],
    "balcony": ["floor", "balcony_door", "entrance_threshold", "drying_area", "guardrail", "walking_path", "lighting"],
}
ALL_SCENE_ELEMENTS = sorted({item for values in ROOM_SCENE_ELEMENTS.values() for item in values})
ROOM_NAMES = {"bathroom": "卫生间", "bedroom": "卧室", "living_room": "客厅", "kitchen": "厨房", "corridor": "玄关走廊", "balcony": "阳台"}


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
    def inspect_camera(self, assessment_id: str, room_type: str, media: dict, allowed_risks: list[str], profile_summary: dict, previous_summary: list[str]) -> tuple[dict, dict]: ...
    def fair_turbo(self, scan_id: str, zone_id: str, media: dict, allowed_risks: list[str]) -> tuple[dict, dict]: ...
    def fair_review(self, scan_id: str, zone_id: str, media: list[dict], candidates: list[dict], allowed_risks: list[str]) -> tuple[dict, dict]: ...


QUALITY_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["usable", "clear", "floor_visible", "path_visible", "lighting_sufficient", "major_occlusion", "scene_elements", "missing_element_ids"],
    "properties": {
        "usable": {"type": "boolean"},
        "clear": {"type": "boolean"},
        "floor_visible": {"type": "boolean"},
        "path_visible": {"type": "boolean"},
        "lighting_sufficient": {"type": "boolean"},
        "major_occlusion": {"type": "boolean"},
        "scene_elements": {"type": "array", "items": {"type": "string", "enum": ALL_SCENE_ELEMENTS}},
        "missing_element_ids": {"type": "array", "items": {"type": "string", "enum": ALL_SCENE_ELEMENTS}},
    },
}


ANALYSIS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["room_type", "scene_elements", "risk_candidates"],
    "properties": {
        "room_type": {"type": "string"},
        "scene_elements": {"type": "array", "items": {"type": "string", "enum": ALL_SCENE_ELEMENTS}},
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

CAMERA_PROMPT_VERSION = "anju_h5_camera_adaptive_v1"
CAMERA_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["media_id", "quality_usable", "scene_elements", "suggestions", "save_as_evidence_recommended"],
    "properties": {
        "media_id": {"type": "string"}, "quality_usable": {"type": "boolean"},
        "scene_elements": {"type": "array", "items": {"type": "string", "enum": ALL_SCENE_ELEMENTS}},
        "save_as_evidence_recommended": {"type": "boolean"},
        "suggestions": {"type": "array", "maxItems": 5, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["risk_code", "title", "evidence", "confidence", "needs_manual_check", "possible_repeat", "region"],
            "properties": {
                "risk_code": {"type": "string"}, "title": {"type": "string"}, "evidence": {"type": "string"},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "needs_manual_check": {"type": "boolean"}, "possible_repeat": {"type": "boolean"},
                "region": ANALYSIS_SCHEMA["properties"]["risk_candidates"]["items"]["properties"]["region"],
            },
        }},
    },
}

FAIR_TURBO_PROMPT_VERSION = "anju_ios_fair_turbo_v1"
FAIR_REVIEW_PROMPT_VERSION = "anju_ios_fair_review_pro_v1"
FAIR_TURBO_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["frame_id", "zone_id", "candidates"],
    "properties": {
        "frame_id": {"type": "string"}, "zone_id": {"type": "string", "enum": ["entrance", "main_aisle", "booth", "rest_area"]},
        "candidates": {"type": "array", "maxItems": 5, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["risk_code", "evidence", "confidence", "needs_manual_check", "bbox"],
            "properties": {
                "risk_code": {"type": "string"}, "evidence": {"type": "string"},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1}, "needs_manual_check": {"type": "boolean"},
                "bbox": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4},
            },
        }},
    },
}
FAIR_REVIEW_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["zone_id", "reviews"],
    "properties": {
        "zone_id": {"type": "string", "enum": ["entrance", "main_aisle", "booth", "rest_area"]},
        "reviews": {"type": "array", "maxItems": 30, "items": {
            "type": "object", "additionalProperties": False,
            "required": ["candidate_id", "status", "risk_code", "evidence", "bbox", "merged_into_candidate_id"],
            "properties": {
                "candidate_id": {"type": "string"},
                "status": {"type": "string", "enum": ["confirmed", "rejected", "merged", "region_corrected", "manual_check"]},
                "risk_code": {"type": "string"}, "evidence": {"type": "string"},
                "bbox": {"anyOf": [{"type": "null"}, {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4}]},
                "merged_into_candidate_id": {"type": ["string", "null"]},
            },
        }},
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
        room_type = str(media.get("room_type", "bathroom"))
        allowed_elements = ROOM_SCENE_ELEMENTS.get(room_type, ROOM_SCENE_ELEMENTS["bathroom"])
        prompt = (
            f"检查这张居家{ROOM_NAMES.get(room_type, '房间')}照片是否适合做环境安全辅助筛查。只描述画面中可观察的内容。"
            "判断清晰度、主要地面和通道、光线、遮挡，并从允许的场景要素中选择已清楚拍到的项。"
            f"允许的场景要素仅为: {allowed_elements}。"
            "scene_elements 和 missing_element_ids 只能返回上述英文枚举 ID，不要输出自由文本。"
            "不要输出医疗结论，也不要把未拍到的区域当作安全。"
        )
        return self._request(assessment_id, prompt, [media], QUALITY_SCHEMA, "media_quality", "low")

    def analyze(self, assessment_id: str, room_type: str, media: list[dict], allowed_risks: list[str]) -> tuple[dict, dict]:
        media_ids = [item["media_id"] for item in media]
        prompt = (
            f"你正在辅助筛查老人家庭{ROOM_NAMES.get(room_type, '房间')}的环境跌倒与行动风险。只报告图片中可观察且有证据的候选，"
            "不得推断遮挡区域，不得给最终风险等级、分数、价格、施工结论、HTML 或 SVG。"
            f"只允许 risk_code: {allowed_risks}。media_id 必须从 {media_ids} 选择。"
            "bbox 坐标为相对对应原图的 0 到 1 值；无法可靠定位时 region 为 null 且 needs_manual_check 为 true。"
            "玻璃门、毛巾架和吸盘装置不能默认视为可靠支撑。避免重复报告同一照片中的同一风险。"
        )
        return self._request(assessment_id, prompt, media, ANALYSIS_SCHEMA, "risk_analysis", "original")

    def inspect_camera(self, assessment_id: str, room_type: str, media: dict, allowed_risks: list[str], profile_summary: dict, previous_summary: list[str]) -> tuple[dict, dict]:
        allowed_elements = ROOM_SCENE_ELEMENTS.get(room_type, [])
        prompt = (
            "你正在对老人家庭的实时相机候选帧做环境安全辅助筛查。"
            f"结构化上下文: assessment_context=home, room_type={room_type}, media_id={media['media_id']}, "
            f"allowed_risk_codes={allowed_risks}, allowed_scene_elements={allowed_elements}, "
            f"profile_summary={profile_summary}, previous_accepted_summary={previous_summary[:5]}。"
            "只描述本帧中可直接观察且有图像证据的内容，不推断画面外或遮挡区域。"
            "相机帧可能不完整；不得把未看到的区域描述为安全，也不得声称完成房间或全屋检查。"
            "只从允许的 risk_code 和场景要素中选择；无法可靠定位时 region 为 null。"
            "输出是临时建议，不给最终等级、分数、价格、施工结论、HTML、SVG 或医疗结论。"
            "若与上一帧摘要可能是同一问题，设置 possible_repeat=true。"
        )
        return self._request(assessment_id, prompt, [media], CAMERA_SCHEMA, "camera_suggestions", "high", CAMERA_PROMPT_VERSION)

    def fair_turbo(self, scan_id: str, zone_id: str, media: dict, allowed_risks: list[str]) -> tuple[dict, dict]:
        prompt = (
            "你正在游园会活动现场对 iPhone 相机关键帧做临时环境安全辅助筛查。"
            f"assessment_context=venue_fair, frame_id={media['media_id']}, zone_id={zone_id}, allowed_risk_codes={allowed_risks}。"
            "只报告本帧中清楚可见、可定位、与人员通行或现场使用直接相关的候选风险。"
            "不得推断画面外、遮挡区域、承重、消防合规、施工质量或活动整体安全状态。"
            "bbox 使用左上角原点的 [x_min,y_min,x_max,y_max] 归一化坐标，无法可靠定位时不要输出候选。"
            "不要输出风险等级、分数、价格、整改方案、HTML、SVG、医疗结论或场馆验收表述。"
        )
        model = os.environ.get("ANJU_ARK_TURBO_MODEL" if self.provider_name == "ark" else "ANJU_OPENAI_TURBO_MODEL", self.model_name)
        return self._request(scan_id, prompt, [media], FAIR_TURBO_SCHEMA, "fair_turbo_candidates", "high", FAIR_TURBO_PROMPT_VERSION, model)

    def fair_review(self, scan_id: str, zone_id: str, media: list[dict], candidates: list[dict], allowed_risks: list[str]) -> tuple[dict, dict]:
        compact_candidates = [{key: item.get(key) for key in ("candidate_id", "frame_id", "risk_code", "evidence", "confidence", "bbox")} for item in candidates]
        prompt = (
            "你正在复核一次游园会 Zone 扫描的代表帧和 Turbo 候选。"
            f"assessment_context=venue_fair, zone_id={zone_id}, allowed_risk_codes={allowed_risks}, candidates={compact_candidates}。"
            "逐个候选返回 confirmed、rejected、merged、region_corrected 或 manual_check，并保留 candidate_id。"
            "只依据提供图片和候选证据，不补充画面外事实；只能使用允许的 risk_code。"
            "bbox 为左上角原点的 [x_min,y_min,x_max,y_max]；不得决定最终等级、分数、价格或工程结论。"
        )
        model = os.environ.get("ANJU_ARK_PRO_MODEL" if self.provider_name == "ark" else "ANJU_OPENAI_PRO_MODEL", self.model_name)
        return self._request(scan_id, prompt, media, FAIR_REVIEW_SCHEMA, "fair_candidate_reviews", "high", FAIR_REVIEW_PROMPT_VERSION, model)

    def _request(self, assessment_id: str, prompt: str, media: list[dict], schema: dict, schema_name: str, detail: str, prompt_version: str | None = None, model_name: str | None = None) -> tuple[dict, dict]:
        content: list[dict] = [{"type": "input_text", "text": prompt}]
        for item in media:
            encoded = base64.b64encode(Path(item["path"]).read_bytes()).decode("ascii")
            content.append({
                "type": "input_image",
                "image_url": f"data:{item['mime_type']};base64,{encoded}",
                "detail": self._image_detail(detail),
            })
        payload = {
            "model": model_name or self.model_name,
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
                usage = self._usage(response_data, attempt)
                if prompt_version:
                    usage["prompt_version"] = prompt_version
                return parsed, usage
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
        room_type = str(media.get("room_type", "bathroom"))
        scene_elements = ROOM_SCENE_ELEMENTS.get(room_type, ROOM_SCENE_ELEMENTS["bathroom"])
        return ({
            "usable": True, "clear": True, "floor_visible": True, "path_visible": True,
            "lighting_sufficient": True, "major_occlusion": False,
            "scene_elements": scene_elements,
            "missing_element_ids": [],
        }, self._usage())

    def analyze(self, assessment_id: str, room_type: str, media: list[dict], allowed_risks: list[str]) -> tuple[dict, dict]:
        media_id = media[0]["media_id"]
        room_candidates = {
            "bathroom": [("BATH_NO_GRAB_BAR", "淋浴区缺少稳定支撑点", "淋浴区入口及内部未看到可靠固定扶手", 0.91, [0.55, 0.25, 0.25, 0.32])],
            "bedroom": [("BED_TRANSFER_NO_SUPPORT", "床边起身缺少稳定支撑", "床边常用起身位置未见可靠支撑点", 0.88, [0.52, 0.34, 0.24, 0.38])],
            "living_room": [("LIVING_PATH_OBSTRUCTION", "客厅通行动线有障碍", "沙发与茶几之间的通行空间较紧张", 0.86, [0.26, 0.56, 0.48, 0.28])],
            "kitchen": [("KITCHEN_HIGH_REACH", "常用物品放置过高", "常用储物区需明显抬手或踮脚取物", 0.84, [0.58, 0.10, 0.30, 0.32])],
            "corridor": [("CORRIDOR_SHOE_OBSTRUCTION", "换鞋区物品占用通道", "鞋物进入主要通行动线", 0.89, [0.18, 0.62, 0.42, 0.24])],
            "balcony": [("BALCONY_REACHING_RISK", "晾衣位置需过度伸展", "晾衣杆位置较高，操作时可能需踮脚或探身", 0.83, [0.46, 0.12, 0.36, 0.44])],
        }
        candidates = room_candidates.get(room_type, []) + [
            ("LIGHTING_NIGHT_INSUFFICIENT", "夜间照明可能不足", "主要通道附近未看到夜间辅助照明", 0.64, [0.02, 0.12, 0.20, 0.24])
        ]
        return ({
            "room_type": room_type,
            "scene_elements": ROOM_SCENE_ELEMENTS.get(room_type, ROOM_SCENE_ELEMENTS["bathroom"]),
            "risk_candidates": [{
                "risk_code": code, "media_id": media_id, "title": title, "evidence": evidence,
                "confidence": confidence, "needs_manual_check": confidence < 0.8,
                "region": {"type": "bbox", "x": box[0], "y": box[1], "width": box[2], "height": box[3], "points": None},
            } for code, title, evidence, confidence, box in candidates if code in allowed_risks],
        }, self._usage())

    def inspect_camera(self, assessment_id: str, room_type: str, media: dict, allowed_risks: list[str], profile_summary: dict, previous_summary: list[str]) -> tuple[dict, dict]:
        code = next(iter(allowed_risks), "")
        suggestions = [] if not code else [{
            "risk_code": code, "title": "现场画面中的待确认提示", "evidence": "当前画面可见一个需要进一步确认的环境细节",
            "confidence": 0.82, "needs_manual_check": True, "possible_repeat": bool(previous_summary),
            "region": {"type": "bbox", "x": 0.2, "y": 0.45, "width": 0.4, "height": 0.3, "points": None},
        }]
        usage = self._usage()
        usage["prompt_version"] = CAMERA_PROMPT_VERSION
        return {"media_id": media["media_id"], "quality_usable": True, "scene_elements": ROOM_SCENE_ELEMENTS.get(room_type, []), "suggestions": suggestions, "save_as_evidence_recommended": bool(suggestions)}, usage

    def fair_turbo(self, scan_id: str, zone_id: str, media: dict, allowed_risks: list[str]) -> tuple[dict, dict]:
        code = next(iter(allowed_risks), "floor_clutter")
        usage = self._usage(); usage["prompt_version"] = FAIR_TURBO_PROMPT_VERSION
        return {"frame_id": media["media_id"], "zone_id": zone_id, "candidates": [{"risk_code": code, "evidence": "游园会通行区域可见需要确认的低位障碍", "confidence": .88, "needs_manual_check": False, "bbox": [.2, .5, .6, .85]}]}, usage

    def fair_review(self, scan_id: str, zone_id: str, media: list[dict], candidates: list[dict], allowed_risks: list[str]) -> tuple[dict, dict]:
        usage = self._usage(); usage["prompt_version"] = FAIR_REVIEW_PROMPT_VERSION
        return {"zone_id": zone_id, "reviews": [{"candidate_id": item["candidate_id"], "status": "confirmed", "risk_code": item["risk_code"], "evidence": item["evidence"], "bbox": item["bbox"], "merged_into_candidate_id": None} for item in candidates]}, usage

    def _usage(self) -> dict:
        return {"model_name": self.model_name, "prompt_version": self.prompt_version, "input_tokens": 0, "output_tokens": 0, "latency_ms": 0, "schema_valid": True, "retry_count": 0, "fallback_used": False, "error_type": None}


@dataclass
class ArkVisionProvider(OpenAIVisionProvider):
    model_name: str = "doubao-seed-2-1-pro-260628"
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
            model_name=os.environ.get("ANJU_ARK_MODEL", "doubao-seed-2-1-pro-260628"),
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
