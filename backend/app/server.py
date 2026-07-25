from __future__ import annotations

import logging
import os

import uvicorn


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    host = os.environ.get("ANJU_HOST", "127.0.0.1")
    port = int(os.environ.get("ANJU_PORT", "8080"))
    forwarded_allow_ips = os.environ.get("ANJU_FORWARDED_ALLOW_IPS", "127.0.0.1")
    uvicorn.run(
        "backend.app.asgi:app",
        host=host,
        port=port,
        workers=1,
        proxy_headers=True,
        forwarded_allow_ips=forwarded_allow_ips,
        log_config=None,
    )


if __name__ == "__main__":
    main()
