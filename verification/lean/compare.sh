#!/usr/bin/env bash
# Lean ↔ Rust 交叉验证：比对全部 3⁹ = 19683 个棋盘的判胜结果。
#
# 定理证明的是"规格正确"，这个脚本证明的是"Lean 与 Rust 生产实现逐格一致"。
# 两边都从同一个三进制编码铺棋盘，输出 `code,winner` 后逐行 diff。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

LEAN_OUT="$(mktemp)"
RUST_OUT="$(mktemp)"
trap 'rm -f "$LEAN_OUT" "$RUST_OUT"' EXIT

# Lean 侧：项目已 pin 工具链；清掉代理，避免 elan 做多余的联网检查。
echo "==> 构建 Lean 并导出棋盘"
(cd "$HERE" && env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
  lake build >/dev/null && \
  env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy lake exe dump) >"$LEAN_OUT"

echo "==> 构建 Rust core 并导出同一批棋盘"
(cd "$ROOT" && cargo run -q -p nine-grid-core --example dump_winner) >"$RUST_OUT"

if diff -q "$LEAN_OUT" "$RUST_OUT" >/dev/null; then
  echo "✓ 两侧判胜结果完全一致（$(wc -l <"$LEAN_OUT" | tr -d ' ') 个棋盘）"
else
  echo "✗ 两侧判胜结果存在差异：" >&2
  diff "$LEAN_OUT" "$RUST_OUT" | head -20 >&2
  exit 1
fi
