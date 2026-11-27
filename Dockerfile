# syntax=docker/dockerfile:1
#
# 九宫棋服务端镜像：多阶段构建，运行层只有二进制 + 静态文件。
#
#   docker build -t nine-grid .
#   docker run --rm -p 8080:8080 \
#     -e DATABASE_URL=postgres://user:pass@host:5432/nine_grid nine-grid
#
# 数据库迁移是编译期内嵌的（`sqlx::migrate!`），运行层不需要 migrations 目录。
# 依赖缓存走 BuildKit cache mount（见 `--mount=type=cache`），改代码不会重编依赖。

ARG RUST_VERSION=1.94

FROM rust:${RUST_VERSION}-slim-bookworm AS builder

WORKDIR /src

# sqlx 的 postgres 走 rustls，不需要 OpenSSL；只补最小编译依赖。
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations

# 迁移是编译期内嵌的，所以 migrations 必须在这层就位。
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p nine-grid-server \
    && cp target/release/nine-grid /tmp/nine-grid

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行；固定 uid 方便给挂载卷配权限。
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin ninegrid

WORKDIR /app
COPY --from=builder /tmp/nine-grid /usr/local/bin/nine-grid
COPY --chown=10001:10001 crates/server/static ./static

ENV STATIC_DIR=/app/static \
    BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=info

USER 10001
EXPOSE 8080

# 编排层据此判断「真的能服务了」，而不是「进程还活着」。
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["nine-grid"]
