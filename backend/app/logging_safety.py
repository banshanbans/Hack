from __future__ import annotations

import logging
import re
from typing import Any


_SENSITIVE_QUERY_PATTERN = re.compile(
    r"([?&](?:token|access_token)=)[^&\s\"]+",
    flags=re.IGNORECASE,
)


def redact_sensitive_query(value: str) -> str:
    return _SENSITIVE_QUERY_PATTERN.sub(r"\1[REDACTED]", value)


class SensitiveQueryFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_sensitive_query(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_redact_argument(item) for item in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: _redact_argument(item) for key, item in record.args.items()}
        return True


def _redact_argument(value: Any) -> Any:
    if isinstance(value, str):
        return redact_sensitive_query(value)
    return value


def install_sensitive_log_filter() -> None:
    for logger_name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        logger = logging.getLogger(logger_name)
        if not any(isinstance(item, SensitiveQueryFilter) for item in logger.filters):
            logger.addFilter(SensitiveQueryFilter())
