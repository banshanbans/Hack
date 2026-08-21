# Python runtime dependencies

The H5 production entry is an ASGI application. Exact direct dependency versions are pinned in `requirements.txt`; test-only packages are pinned separately.

| Package | Purpose | License | Deployment and security notes |
|---|---|---|---|
| FastAPI | Typed HTTP routing, dependencies, lifecycle and middleware | MIT | Replaces the standard-library HTTP entry; no database ORM is introduced. |
| Pydantic | Request DTO validation | MIT | Validation errors are mapped to the existing public error envelope. |
| Uvicorn | ASGI server | BSD-3-Clause | P0 runs one worker because v1 sessions and analysis executors are process-local. |
| HTTPX | ASGI integration tests only | BSD-3-Clause | Not required by the production service. |

Production remains behind an HTTPS edge or load balancer. Only configured forwarded proxy addresses should be trusted. Model and assessment keys stay in server-side environment variables and are not logged.
