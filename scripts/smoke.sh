#!/usr/bin/env bash
# 九宫棋端到端冒烟测试：一次跑完「正常对局 + 全部拒绝分支」。
#
#   bash scripts/smoke.sh [BASE_URL]
#
# 默认打到 http://127.0.0.1:8080。需要 jq 与 uuidgen。
set -uo pipefail

BASE="${1:-http://127.0.0.1:8080}"
PASS=0
FAIL=0

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
no() {
  printf '  \033[31m✗\033[0m %s（期望 %s，实际 %s）\n' "$1" "$2" "$3"
  FAIL=$((FAIL + 1))
}
check() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "$2" "$3"; fi; }

post() { curl -s -X POST "$BASE$1" -H 'content-type: application/json' -d "$2"; }
err_code() { jq -r '.error.code // "none"'; }

A=$(uuidgen | tr 'A-Z' 'a-z')
B=$(uuidgen | tr 'A-Z' 'a-z')
C=$(uuidgen | tr 'A-Z' 'a-z')

echo "== 健康检查 =="
check "GET /healthz" "ok" "$(curl -s "$BASE/healthz" | jq -r .status)"
check "GET / 返回页面" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"

echo "== 建局 =="
VIEW=$(post /api/games "{\"player_id\":\"$A\"}")
CODE=$(echo "$VIEW" | jq -r .code)
check "房间码是 6 位" "6" "${#CODE}"
check "创建者执 O" "O" "$(echo "$VIEW" | jq -r .you)"
check "初始状态 waiting" "waiting" "$(echo "$VIEW" | jq -r .state)"
check "还没对手就落子被拒" "not_started" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":0}" | err_code)"

echo "== 加入 =="
VIEW=$(post "/api/games/$CODE/join" "{\"player_id\":\"$B\"}")
check "加入后进入进行中" "in_progress" "$(echo "$VIEW" | jq -r .state)"
check "加入者执 X" "X" "$(echo "$VIEW" | jq -r .you)"
check "第三个人加入被拒" "game_full" "$(post "/api/games/$CODE/join" "{\"player_id\":\"$C\"}" | err_code)"
check "建局者加入自己的房间被拒" "game_full" "$(post "/api/games/$CODE/join" "{\"player_id\":\"$A\"}" | err_code)"
check "X 抢先落子被拒" "not_your_turn" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$B\",\"position\":8}" | err_code)"

echo "== 落子（O0 X3 O1 X4）=="
post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":0,\"version\":1}" >/dev/null
post "/api/games/$CODE/moves" "{\"player_id\":\"$B\",\"position\":3,\"version\":2}" >/dev/null
post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":1,\"version\":3}" >/dev/null
post "/api/games/$CODE/moves" "{\"player_id\":\"$B\",\"position\":4,\"version\":4}" >/dev/null
check "重复占格被拒" "cell_occupied" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":4,\"version\":5}" | err_code)"
check "过期版本号被拒" "stale_version" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":2,\"version\":2}" | err_code)"
check "路人落子被拒" "not_a_player" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$C\",\"position\":2}" | err_code)"

echo "== 终局 =="
VIEW=$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":2,\"version\":5}")
check "O 三连获胜" "o_won" "$(echo "$VIEW" | jq -r .state)"
check "胜者标记正确" "O" "$(echo "$VIEW" | jq -r .winner)"
check "落满 5 手" "5" "$(echo "$VIEW" | jq -r .plies)"
check "终局后不能继续落子" "game_over" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$B\",\"position\":5}" | err_code)"

echo "== 读取 =="
check "旁观者 you 为空" "null" "$(curl -s "$BASE/api/games/$CODE?player_id=$C" | jq -r .you)"
check "棋谱可回放" "5" "$(curl -s "$BASE/api/games/$CODE/replay" | jq -r '.moves | length')"
check "不存在的房间 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/games/ZZZZZZ")"
check "非法房间码 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/games/ABC")"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m全部 %d 项通过\033[0m\n' "$PASS"
else
  printf '\033[31m%d 项失败 / 共 %d 项\033[0m\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
