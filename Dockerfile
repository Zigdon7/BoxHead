# syntax=docker/dockerfile:1
# One image with the game server, the ops dashboard and the built website.
# Build and run it with compose.yaml (see docs/HOSTING.md).

# ---- Website (Vite) ----
FROM node:24-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Game server and dashboard (Rust) ----
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY backend/ backend/
COPY dashboard/ dashboard/
# Cache mounts keep the crate downloads and build output between builds, so
# an update only recompiles what changed.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/backend/target \
    cd backend && cargo build --release --locked && cp target/release/boxhead-server /usr/local/bin/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/dashboard/target \
    cd dashboard && cargo build --release --locked && cp target/release/boxhead-dashboard /usr/local/bin/

# ---- Runtime ----
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 curl sqlite3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin boxhead \
    && mkdir -p /data /backups && chown boxhead:boxhead /data /backups
COPY --from=build /usr/local/bin/boxhead-server /usr/local/bin/boxhead-dashboard /usr/local/bin/
COPY --from=web /src/frontend/dist /app/static
COPY --chmod=755 deploy/backup.sh /usr/local/bin/boxhead-backup
# A Windows checkout may have given the script CRLF line endings.
RUN sed -i 's/\r$//' /usr/local/bin/boxhead-backup
ENV PORT=3001 \
    STATIC_DIR=/app/static \
    BOXHEAD_DB=/data/boxhead.db
USER boxhead
WORKDIR /data
VOLUME ["/data", "/backups"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1
# tini forwards stop signals, so `docker stop` ends the server at once.
ENTRYPOINT ["tini", "--"]
CMD ["boxhead-server"]
