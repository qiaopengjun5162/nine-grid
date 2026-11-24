#!/usr/bin/env bash
# 浏览器端链上 E2E：本地验证器 → 部署 → 静态服务 → 两个模拟钱包 → Playwright 真实 UI 一局。
#
# 与 chain-test.sh 的分工：
#   chain-test.sh   验证「交易构造逻辑」（Node keypair 直接调 program.methods，10 项 TS 测试）；
#   browser-e2e.sh  验证「浏览器那条链」（boot 初始化、按钮绑定、UI 点击、订阅刷新、判胜高亮）。
# 后者能抓到前者测不出的事故，例如链上前端 Buffer 未注入导致整个模块顶层崩溃。
#
# 依赖：solana-test-validator / solana / Python playwright + pynacl / Chromium。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN="$ROOT/chain"
STATIC="$ROOT/crates/server/static"
LEDGER="${LEDGER_DIR:-/tmp/nine-grid-browser-ledger}"
RPC="${RPC_URL:-http://127.0.0.1:8899}"
WEB="${WEB_PORT:-8099}"
WALLET_DIR="${BROWSER_E2E_WALLETS:-/tmp}"
PROGRAM_ID="AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6"
PY="${BROWSER_E2E_PY:-python3}"

VALIDATOR_PID=""
WEB_PID=""

cleanup() {
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  if [ -n "$VALIDATOR_PID" ]; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  lsof -ti tcp:8899 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti tcp:"$WEB" 2>/dev/null | xargs kill 2>/dev/null || true
}
trap cleanup EXIT

echo "==> 依赖检查"
for tool in solana solana-test-validator; do
  command -v "$tool" >/dev/null || { echo "缺少 $tool"; exit 1; }
done
"$PY" -c "import playwright, nacl.signing" 2>/dev/null || {
  echo "缺少 Python 依赖：pip install playwright pynacl && playwright install chromium"; exit 1;
}

echo "==> 1/5 编译 .so"
(cd "$CHAIN" && anchor build >/dev/null 2>&1)

echo "==> 2/5 启动本地验证器"
lsof -ti tcp:8899 2>/dev/null | xargs kill 2>/dev/null || true
sleep 0.4
rm -rf "$LEDGER"
solana-test-validator --reset --ledger "$LEDGER" --quiet >/tmp/nine-grid-browser-validator.log 2>&1 &
VALIDATOR_PID=$!
for _ in $(seq 1 40); do
  curl -s --max-time 2 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" 2>/dev/null | grep -q '"result":"ok"' && break
  sleep 0.5
done
curl -s --max-time 3 -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" | grep -q '"result":"ok"' || {
  echo "验证器未就绪，日志："; tail -20 /tmp/nine-grid-browser-validator.log; exit 1;
}
echo "    验证器就绪"

echo "==> 3/5 部署程序 $PROGRAM_ID"
(cd "$CHAIN" && solana program deploy --url "$RPC" \
  --program-id target/deploy/nine_grid-keypair.json \
  target/deploy/nine_grid.so 2>&1 | grep -E "Program Id|Signature" | head -2)

echo "==> 4/5 静态服务 + 两个测试钱包"
lsof -ti tcp:"$WEB" 2>/dev/null | xargs kill 2>/dev/null || true
(cd "$STATIC" && "$PY" -m http.server "$WEB" --bind 127.0.0.1 >/tmp/nine-grid-browser-web.log 2>&1) &
WEB_PID=$!
for who in o x; do
  wallet="$WALLET_DIR/nine-grid-browser-$who.json"
  [ -f "$wallet" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$wallet" >/dev/null 2>&1
  addr=$(solana-keygen pubkey "$wallet")
  solana airdrop 2 "$addr" --url "$RPC" >/dev/null 2>&1 || true
  echo "    $who: $addr ($(solana balance "$addr" --url "$RPC" 2>/dev/null))"
done

echo "==> 5/5 浏览器 E2E（模拟 Phantom，真实 UI）"
BROWSER_E2E_URL="http://127.0.0.1:$WEB/chain.html?cluster=localnet" \
BROWSER_E2E_WALLETS="$WALLET_DIR" \
"$PY" "$ROOT/scripts/browser-e2e.py"

echo "==> 完成"
