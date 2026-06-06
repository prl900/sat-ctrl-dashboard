# ── Stage 1: build the React frontend ───────────────────────────────
FROM node:22-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Python backend serving API + built frontend ─────────────
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim
WORKDIR /srv/backend

COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

COPY backend/app ./app
# main.py serves this automatically when present (../frontend/dist)
COPY --from=frontend /build/dist /srv/frontend/dist

# Cloud Run injects PORT (defaults to 8080)
CMD ["sh", "-c", "uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
