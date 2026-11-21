#!/usr/bin/env bash
# 链上端到端测试：本地验证器 → 部署 → Anchor TS 测试 → 清理。
#
# 与 Rust 单测（chain 里的 cargo test-sbf）互补：
#   - cargo test-sbf 验证「规则逻辑」对不对（19683 棋盘穷举）；
#   - 本脚本验证「部署后的程序在真实链上」按这些规则执行。
#
# 注意：ts-node 默认会在 $HOME 建缓存目录，在受限沙盒里会被拒绝，
# 因此这里显式关闭缓存（TS_NODE_CACHE=false），并用工作区内的 ledger。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN="$ROOT/chain"
LEDGER="${LEDGER_DIR:-/tmp/nine-grid-validator-ledger}"
RPC="${RPC_URL:-http://127.0.0.1:8899}"
PROGRAM_ID="AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6"
WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
VALIDATOR_PID=""

cleanup() {
  if [ -n "$VALIDATOR_PID" ]; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  # 兜底：杀掉可能残留的验证器（只针对本项目端口）
  lsof -ti tcp:8899 2>/dev/null | xargs kill 2>/dev/null || true
}
trap cleanup EXIT

echo "==> 1/5 编译 .so"
(cd "$CHAIN" && anchor build >/dev/null 2>&1)

echo "==> 2/5 启动本地验证器"
lsof -ti tcp:8899 2>/dev/null | xargs kill 2>/dev/null || true
sleep 0.4
rm -rf "$LEDGER"
solana-test-validator --reset --ledger "$LEDGER" --quiet >/tmp/nine-grid-validator.log 2>&1 &
VALIDATOR_PID=$!
for _ in $(seq 1 40); do
  solana cluster-version --url "$RPC" >/dev/null 2>&1 && break
  sleep 0.5
done
solana cluster-version --url "$RPC" | head -1

echo "==> 3/5 部署程序 $PROGRAM_ID"
(cd "$CHAIN" && solana program deploy --url "$RPC" \
  --program-id target/deploy/nine_grid-keypair.json \
  target/deploy/nine_grid.so 2>&1 | grep -E "Program Id|Signature" | head -2)

echo "==> 4/5 跑 TS 集成测试（10 项）"
cd "$CHAIN"
ANCHOR_PROVIDER_URL="$RPC" \
ANCHOR_WALLET="$WALLET" \
TS_NODE_PROJECT=./tsconfig.json \
TS_NODE_CACHE=false \
node -r ./node_modules/ts-node/register \
  ./node_modules/mocha/bin/mocha -t 1000000 tests/nine-grid.ts 2>&1 \
  | grep -vE "DeprecationWarning|MODULE_TYPELESS|Reparsing as ES|To eliminate|trace-warnings|trace-deprecation|punycode"

echo "==> 5/5 验证链上前端的交易构造方式"
# chain.js（浏览器）用的 IDL、PDA 派生、program.methods 调用和账户订阅解码，
# 在这里用 Node keypair 代替 Phantom 跑一遍，保证浏览器端逻辑不跑偏。
node verify-frontend.js 2>&1 | grep -vE "DeprecationWarning|trace-deprecation|punycode"

echo "==> 完成"
