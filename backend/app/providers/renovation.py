from __future__ import annotations

import base64
from dataclasses import dataclass
import ipaddress
import json
import os
from pathlib import Path
import socket
import time
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .vision import ProviderError


RENOVATION_PROMPT_VERSION = "anju_renovation_visualization_v1"
MAX_GENERATED_IMAGE_BYTES = 12 * 1024 * 1024


@dataclass(frozen=True)
class RenovationImage:
    body: bytes
    mime_type: str
    usage: dict


class RenovationProvider(Protocol):
    provider_name: str
    model_name: str
    prompt_version: str

    def edit(self, assessment_id: str, source: dict, prompt: str) -> RenovationImage: ...


def _mime_type(body: bytes, declared: str = "") -> str:
    if body.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if body.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if body.startswith(b"RIFF") and body[8:12] == b"WEBP":
        return "image/webp"
    if declared.split(";", 1)[0].strip().lower() in {"image/jpeg", "image/png", "image/webp"}:
        raise ProviderError("provider_invalid_response", True)
    raise ProviderError("provider_invalid_response", True)


def _safe_output_url(value: str) -> str:
    parsed = urlparse(value)
    hostname = (parsed.hostname or "").strip().lower()
    if parsed.scheme != "https" or not hostname or hostname == "localhost" or hostname.endswith(".localhost"):
        raise ProviderError("provider_invalid_response", False)
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address and (address.is_private or address.is_loopback or address.is_link_local or address.is_reserved):
        raise ProviderError("provider_invalid_response", False)
    return value


class ArkRenovationProvider:
    provider_name = "ark"
    prompt_version = RENOVATION_PROMPT_VERSION

    def __init__(
        self,
        api_key: str,
        model_name: str = "doubao-seedream-4-5-251128",
        endpoint: str = "https://ark.cn-beijing.volces.com/api/v3/images/generations",
        timeout_seconds: float = 90,
    ) -> None:
        self.api_key = api_key
        self.model_name = model_name
        self.endpoint = endpoint
        self.timeout_seconds = timeout_seconds

    def edit(self, assessment_id: str, source: dict, prompt: str) -> RenovationImage:
        started = time.monotonic()
        source_body = Path(source["path"]).read_bytes()
        encoded = base64.b64encode(source_body).decode("ascii")
        payload = {
            "model": self.model_name,
            "prompt": prompt,
            "image": [f"data:{source['mime_type']};base64,{encoded}"],
            "response_format": "url",
            "size": os.environ.get("ANJU_ARK_IMAGE_EDIT_SIZE", "2K"),
            "watermark": False,
            "sequential_image_generation": "disabled",
            "stream": False,
        }
        request = Request(
            self.endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                response_data = json.loads(response.read())
            body, declared = self._extract_and_download(response_data)
        except HTTPError as error:
            retryable = error.code == 429 or error.code >= 500
            raise ProviderError(f"provider_http_{error.code}", retryable) from error
        except (URLError, TimeoutError, socket.timeout) as error:
            raise ProviderError("provider_timeout", True) from error
        except ProviderError:
            raise
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise ProviderError("provider_invalid_response", True) from error
        usage = dict(response_data.get("usage") or {})
        usage.update({
            "latency_ms": round((time.monotonic() - started) * 1_000),
            "prompt_version": self.prompt_version,
            "model": str(response_data.get("model") or self.model_name),
        })
        return RenovationImage(body=body, mime_type=_mime_type(body, declared), usage=usage)

    def _extract_and_download(self, response: dict) -> tuple[bytes, str]:
        data = response.get("data")
        if not isinstance(data, list) or not data or not isinstance(data[0], dict):
            raise ProviderError("provider_invalid_response", True)
        item = data[0]
        if isinstance(item.get("b64_json"), str):
            try:
                body = base64.b64decode(item["b64_json"], validate=True)
            except ValueError as error:
                raise ProviderError("provider_invalid_response", True) from error
            if len(body) > MAX_GENERATED_IMAGE_BYTES:
                raise ProviderError("provider_invalid_response", False)
            return body, ""
        url = _safe_output_url(str(item.get("url") or ""))
        download = Request(url, headers={"User-Agent": "AnjuGuard/2.0"})
        with urlopen(download, timeout=self.timeout_seconds) as response:
            body = response.read(MAX_GENERATED_IMAGE_BYTES + 1)
            declared = response.headers.get("Content-Type", "")
        if not body or len(body) > MAX_GENERATED_IMAGE_BYTES:
            raise ProviderError("provider_invalid_response", False)
        return body, declared


class MockRenovationProvider:
    provider_name = "mock"
    model_name = "mock-renovation-preview-v1"
    prompt_version = RENOVATION_PROMPT_VERSION

    def edit(self, assessment_id: str, source: dict, prompt: str) -> RenovationImage:
        body = Path(source["path"]).read_bytes()
        return RenovationImage(
            body=body,
            mime_type=_mime_type(body, source.get("mime_type", "")),
            usage={"latency_ms": 0, "prompt_version": self.prompt_version, "model": self.model_name, "mock": True},
        )


def renovation_provider_from_environment() -> RenovationProvider:
    if os.environ.get("ANJU_MOCK_ANALYSIS") == "1":
        return MockRenovationProvider()
    api_key = os.environ.get("ARK_API_KEY", "").strip()
    if not api_key:
        raise ProviderError("provider_not_configured", False)
    try:
        timeout = float(os.environ.get("ANJU_RENOVATION_PREVIEW_TIMEOUT_SECONDS", "90"))
    except ValueError:
        timeout = 90
    return ArkRenovationProvider(
        api_key=api_key,
        model_name=os.environ.get("ANJU_ARK_IMAGE_EDIT_MODEL", "doubao-seedream-4-5-251128"),
        endpoint=os.environ.get("ANJU_ARK_IMAGE_EDIT_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3/images/generations"),
        timeout_seconds=max(10, min(180, timeout)),
    )
