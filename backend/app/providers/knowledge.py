from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
import socket
import time
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .vision import ProviderError


PROMPT_VERSION = "anju_knowledge_advisor_v1"
ANSWER_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["answer", "suggested_questions"],
    "properties": {
        "answer": {"type": "string", "maxLength": 800},
        "suggested_questions": {
            "type": "array", "maxItems": 4,
            "items": {"type": "string", "maxLength": 80},
        },
    },
}


class KnowledgeAdvisorProvider(Protocol):
    provider_name: str
    model_name: str
    prompt_version: str

    def answer(self, session_id: str, history: list[dict], question: str, knowledge: list[dict]) -> tuple[dict, dict]: ...


def _system_prompt(knowledge: list[dict]) -> str:
    approved = json.dumps(knowledge, ensure_ascii=False, separators=(",", ":"))
    return (
        "你是‘长者友好家’的 AI 适老顾问，回答中文居家适老化知识。回答应温和、清楚、简短，优先给出可执行的通用原则。"
        "长者友好家通过照片或实时相机辅助发现有证据的居家行动风险，并由规则生成等级、参考分、整改方案和价格区间。"
        "你不是医疗诊断、建筑验收、工程检查或施工报价工具。不得仅凭文字判断某个家庭存在正式风险，不得生成安全分或风险等级，"
        "不得编造金额、尺寸、照度、承重、防水、管线或电气事实。具体家庭问题应说明需要照片检查或现场专业评估。"
        "医疗、紧急、承重、防水、电气和结构问题必须建议联系相应专业人员。超出适老化和产品能力范围时简短说明范围。"
        "不得输出 HTML、SVG、Markdown 代码块、链接或可执行内容。suggested_questions 只能给出与当前主题相关的短问题。"
        f"本轮允许引用的受控知识如下：{approved}"
    )


@dataclass
class ResponsesKnowledgeAdvisorProvider:
    api_key: str
    model_name: str
    endpoint: str
    provider_name: str
    timeout_seconds: float = 30.0
    prompt_version: str = PROMPT_VERSION

    def _generation_options(self) -> dict:
        if self.provider_name == "ark":
            return {"thinking": {"type": "disabled"}}
        return {"reasoning": {"effort": "low"}}

    def answer(self, session_id: str, history: list[dict], question: str, knowledge: list[dict]) -> tuple[dict, dict]:
        started_at = time.monotonic()
        messages = [{"role": "system", "content": [{"type": "input_text", "text": _system_prompt(knowledge)}]}]
        for turn in history[-20:]:
            role = turn.get("role")
            text = str(turn.get("text") or "")[:800]
            if role in {"user", "assistant"} and text:
                messages.append({"role": role, "content": [{"type": "input_text", "text": text}]})
        messages.append({"role": "user", "content": [{"type": "input_text", "text": question}]})
        payload = {
            "model": self.model_name,
            "store": False,
            "safety_identifier": hashlib.sha256(session_id.encode("utf-8")).hexdigest(),
            "input": messages,
            "text": {"format": {"type": "json_schema", "name": "knowledge_advisor_answer", "strict": True, "schema": ANSWER_SCHEMA}},
        }
        payload.update(self._generation_options())
        try:
            request = Request(self.endpoint, data=json.dumps(payload).encode("utf-8"), method="POST", headers={
                "Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json",
            })
            with urlopen(request, timeout=self.timeout_seconds) as response:
                response_data = json.loads(response.read())
            parsed = self._extract(response_data)
            usage = response_data.get("usage") or {}
            return parsed, {
                "provider": self.provider_name, "model": response_data.get("model", self.model_name),
                "prompt_version": self.prompt_version, "schema_result": "valid",
                "latency_ms": round((time.monotonic() - started_at) * 1000),
                "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"),
                "error_type": None,
            }
        except HTTPError as error:
            raise ProviderError(f"provider_http_{error.code}", error.code == 429 or error.code >= 500) from error
        except (URLError, TimeoutError, socket.timeout) as error:
            raise ProviderError("provider_timeout", True) from error
        except ProviderError:
            raise
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            raise ProviderError("provider_invalid_response", True) from error

    @staticmethod
    def _extract(response: dict) -> dict:
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


@dataclass
class MockKnowledgeAdvisorProvider:
    provider_name: str = "mock"
    model_name: str = "demo-knowledge-advisor"
    prompt_version: str = PROMPT_VERSION

    def answer(self, session_id: str, history: list[dict], question: str, knowledge: list[dict]) -> tuple[dict, dict]:
        del session_id, history
        if any(value in question for value in ("急救", "晕倒", "呼吸困难", "胸痛", "大量出血")):
            answer = "这可能是紧急情况，请立即联系当地急救服务，并遵循专业人员指引。"
        elif any(value in question for value in ("吃药", "用药", "疼痛", "诊断", "治疗")):
            answer = "我不能提供医疗诊断或用药建议。请咨询医生或药师；如果情况紧急，请立即联系当地急救服务。"
        elif any(value in question for value in ("承重", "防水", "电线", "电气", "墙体", "管线", "拆墙")):
            answer = "这类问题需要核对现场的结构、防水、电气或管线条件，仅凭文字无法确定。请联系有资质的对应专业人员现场评估。"
        elif any(value in question for value in ("多少钱", "报价", "预算", "价格")):
            answer = "通用咨询不会自由估算金额。完成照片或实时检查后，长者友好家可以根据结构化价格规则展示参考区间，实际施工仍需现场报价。"
        else:
            topic = knowledge[0] if knowledge else None
            if topic:
                points = "；".join(topic.get("key_points", [])[:2])
                caution = "；".join(topic.get("cautions", [])[:1])
                answer = f"可以先从这些通用原则考虑：{points}。"
                if caution:
                    answer += f"还要注意：{caution}。"
            else:
                answer = "我主要回答扶手、防滑、照明、通行动线等居家适老化知识。涉及你家的具体情况，需要结合照片检查或现场评估。"
        if any(value in question for value in ("我家", "这个位置", "安全吗", "几分", "风险")):
            answer += " 仅凭文字不能判断你家是否存在正式风险，可以上传清晰照片或开始实时检查。"
        return {"answer": answer[:800], "suggested_questions": ["还有哪些容易忽略的地方？"]}, {
            "provider": "mock", "model": self.model_name, "prompt_version": self.prompt_version,
            "schema_result": "valid", "latency_ms": 0, "input_tokens": None,
            "output_tokens": None, "error_type": None,
        }


def knowledge_provider_from_environment() -> KnowledgeAdvisorProvider:
    if os.environ.get("ANJU_MOCK_ANALYSIS") == "1":
        return MockKnowledgeAdvisorProvider()
    provider = os.environ.get("ANJU_VISION_PROVIDER", "openai").strip().lower()
    timeout = float(os.environ.get("ANJU_KNOWLEDGE_ADVISOR_TIMEOUT_SECONDS", "30"))
    if provider == "ark":
        api_key = os.environ.get("ARK_API_KEY", "").strip()
        if not api_key:
            raise ProviderError("provider_not_configured", False)
        return ResponsesKnowledgeAdvisorProvider(
            api_key=api_key,
            model_name=os.environ.get("ANJU_KNOWLEDGE_ADVISOR_MODEL", os.environ.get("ANJU_ARK_MODEL", "")).strip(),
            endpoint=os.environ.get("ANJU_ARK_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3/responses"),
            provider_name="ark", timeout_seconds=timeout,
        )
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise ProviderError("provider_not_configured", False)
    return ResponsesKnowledgeAdvisorProvider(
        api_key=api_key,
        model_name=os.environ.get("ANJU_KNOWLEDGE_ADVISOR_MODEL", os.environ.get("ANJU_OPENAI_MODEL", "gpt-5.6-sol")).strip(),
        endpoint=os.environ.get("ANJU_OPENAI_ENDPOINT", "https://api.openai.com/v1/responses"),
        provider_name="openai", timeout_seconds=timeout,
    )
