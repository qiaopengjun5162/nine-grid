# 九宫棋 · Nine Grid

default: check

# 启动（需要先 createdb nine_grid）
run:
    cargo run -p nine-grid-server

# 建库（已存在会报错，可忽略）
db:
    createdb nine_grid

# 主 workspace 的全量检查（对应 ci.yml 里 fmt/clippy/test/audit 四条；e2e、chain、lean 另有目标）
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

# 浏览器端 E2E：模拟 Phantom 走真实 UI 一局（验证 boot/按钮/订阅/判胜，自包含）
browser-e2e:
    bash scripts/browser-e2e.sh

# 链上 Rust 单测（含 19683 棋盘一致性，不需要验证器）
chain-unit:
    cd chain && cargo test-sbf -p nine-grid

# Lean 形式化验证：编译并检查全部定理（零 sorry，三条标准公理）
lean-verify:
    cd verification/lean && lake build

# Lean ↔ Rust 交叉验证：比对全部 19683 个棋盘的判胜结果
lean-compare:
    bash verification/lean/compare.sh

# 容器化自托管：构建镜像 + 起 Postgres，然后打开 http://127.0.0.1:8080
up:
    docker compose up -d --build

# 停掉容器（数据留在 pgdata 卷里；要连数据一起删用 down -v）
down:
    docker compose down

