# 九宫棋 · Nine Grid

default: check

# 启动（需要先 createdb nine_grid）
run:
    cargo run -p nine-grid-server

# 建库（已存在会报错，可忽略）
db:
    createdb nine_grid

# 全量检查：与 .github/workflows/ci.yml 的 job 一一对应
check: fmt-check toml-check clippy test audit

fmt:
    cargo fmt
    taplo fmt

fmt-check:
    cargo fmt --all -- --check

toml-check:
    taplo fmt --check

clippy:
    cargo clippy --all-targets --all-features --tests --benches -- -D warnings

test:
    cargo test

# 和 CI 一样的并行测试器（需要 cargo-nextest）
test-nextest:
    cargo nextest run --all-features

# 依赖安全审计（忽略项与理由见 .cargo/audit.toml）
audit:
    cargo audit

# MSRV：Cargo.toml 写着 rust-version = "1.94"，这一条让它是真的
msrv:
    cargo +1.94.0 check --all-features --locked

# 端到端冒烟：需要服务已经在跑
smoke:
    bash scripts/smoke.sh

# 链上端到端：本地验证器 + 部署 + TS 测试（自包含，自动清理）
chain-test:
    bash scripts/chain-test.sh

# 链上 Rust 单测（含 19683 棋盘一致性，不需要验证器）
chain-unit:
    cd chain && cargo test-sbf -p nine-grid
