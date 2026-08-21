FROM node:22.22.0-alpine3.23 AS web-builder

WORKDIR /build/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM python:3.13.11-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN groupadd --gid 10001 anju \
    && useradd --uid 10001 --gid anju --no-create-home --shell /usr/sbin/nologin anju

COPY services/backend/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-cache-dir --requirement /tmp/requirements.lock \
    && rm /tmp/requirements.lock

COPY --chown=anju:anju services/backend/ /app/backend/
COPY --from=web-builder --chown=anju:anju /build/web/dist/ /app/apps/web/dist/

USER 10001:10001

EXPOSE 8080

CMD ["python", "-m", "backend.app.server"]
