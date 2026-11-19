# 九宫棋 · Nine Grid

default: check

# 启动（需要先 createdb nine_grid）
run:
    cargo run -p nine-grid-server

# 建库（已存在会报错，可忽略）
db:
    createdb nine_grid

# 全量检查
check: fmt-check clippy test

fmt:
    cargo fmt

fmt-check:
    cargo fmt --all -- --check

clippy:
    cargo clippy --all-targets -- -D warnings

test:
    cargo test

# 端到端冒烟：需要服务已经在跑
smoke:
    bash scripts/smoke.sh
