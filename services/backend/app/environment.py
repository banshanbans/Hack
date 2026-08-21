from __future__ import annotations

import os
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parent.parent
SERVICE_ROOT = BACKEND_ROOT.parent
PROJECT_ROOT = SERVICE_ROOT.parent if SERVICE_ROOT.name == "services" else SERVICE_ROOT


def load_environment(path: Path | None = None) -> Path | None:
    """Load a simple server-side env file without overriding process variables."""
    configured = os.environ.get("ANJU_ENV_FILE", "").strip()
    env_path = path or (Path(configured).expanduser() if configured else PROJECT_ROOT / ".env")
    if not env_path.is_file():
        return None

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key or not key.replace("_", "").isalnum() or key[0].isdigit():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)
    return env_path
