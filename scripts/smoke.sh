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
TA=$(echo "$VIEW" | jq -r .seat_token)
check "房间码是 6 位" "6" "${#CODE}"
check "创建者执 O" "O" "$(echo "$VIEW" | jq -r .you)"
check "初始状态 waiting" "waiting" "$(echo "$VIEW" | jq -r .state)"
check "还没对手就落子被拒" "not_started" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":0,\"seat_token\":\"$TA\"}" | err_code)"

echo "== 加入 =="
VIEW=$(post "/api/games/$CODE/join" "{\"player_id\":\"$B\"}")
TB=$(echo "$VIEW" | jq -r .seat_token)
check "加入后进入进行中" "in_progress" "$(echo "$VIEW" | jq -r .state)"
check "加入者执 X" "X" "$(echo "$VIEW" | jq -r .you)"
check "第三个人加入被拒" "game_full" "$(post "/api/games/$CODE/join" "{\"player_id\":\"$C\"}" | err_code)"
check "建局者加入自己的房间被拒" "game_full" "$(post "/api/games/$CODE/join" "{\"player_id\":\"$A\"}" | err_code)"
check "X 抢先落子被拒" "not_your_turn" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$B\",\"position\":8,\"seat_token\":\"$TB\"}" | err_code)"

# 凭证这一层要单独验：知道 player_id 不等于坐在这把椅子上
check "不带座位凭证落子被拒" "missing_seat_token" \
  "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":0}" | err_code)"
check "座位凭证不对被拒" "bad_seat_token" \
  "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":0,\"seat_token\":\"deadbeef\"}" | err_code)"

echo "== 落子（O0 X3 O1 X4）=="
post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":0,\"version\":1,\"seat_token\":\"$TA\"}" >/dev/null
post "/api/games/$CODE/moves" "{\"player_id\":\"$B\",\"position\":3,\"version\":2,\"seat_token\":\"$TB\"}" >/dev/null
post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":1,\"version\":3,\"seat_token\":\"$TA\"}" >/dev/null
post "/api/games/$CODE/moves" "{\"player_id\":\"$B\",\"position\":4,\"version\":4,\"seat_token\":\"$TB\"}" >/dev/null
check "重复占格被拒" "cell_occupied" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":4,\"version\":5,\"seat_token\":\"$TA\"}" | err_code)"
check "过期版本号被拒" "stale_version" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":2,\"version\":2,\"seat_token\":\"$TA\"}" | err_code)"
check "路人落子被拒" "not_a_player" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$C\",\"position\":2}" | err_code)"

echo "== 终局 =="
VIEW=$(post "/api/games/$CODE/moves" "{\"player_id\":\"$A\",\"position\":2,\"version\":5,\"seat_token\":\"$TA\"}")
check "O 三连获胜" "o_won" "$(echo "$VIEW" | jq -r .state)"
check "胜者标记正确" "O" "$(echo "$VIEW" | jq -r .winner)"
check "落满 5 手" "5" "$(echo "$VIEW" | jq -r .plies)"
check "终局后不能继续落子" "game_over" "$(post "/api/games/$CODE/moves" "{\"player_id\":\"$B\",\"position\":5,\"seat_token\":\"$TB\"}" | err_code)"

echo "== 读取 =="
check "旁观者 you 为空" "null" "$(curl -s "$BASE/api/games/$CODE?player_id=$C" | jq -r .you)"
check "棋谱可回放" "5" "$(curl -s "$BASE/api/games/$CODE/replay" | jq -r '.moves | length')"
check "不存在的房间 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/games/ZZZZZZ")"
check "非法房间码 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/games/ABC")"

echo "== 机器人 =="
# 机器人是"另一个玩家"：它占 X 座位，落子同样进棋谱
SOLO=$(post /api/games "{\"player_id\":\"$A\"}")
SOLO_CODE=$(echo "$SOLO" | jq -r .code)
TSOLO=$(echo "$SOLO" | jq -r .seat_token)
check "非建局者不能邀请机器人" "not_host" \
  "$(post "/api/games/$SOLO_CODE/bot" "{\"player_id\":\"$B\"}" | err_code)"

BV=$(post "/api/games/$SOLO_CODE/bot" "{\"player_id\":\"$A\",\"seat_token\":\"$TSOLO\"}")
check "机器人入座后对局开始" "in_progress" "$(echo "$BV" | jq -r .state)"
check "X 座位被标记为机器人" "true" "$(echo "$BV" | jq -r .players.x.is_bot)"
check "机器人有可读名字" "机器人" "$(echo "$BV" | jq -r .players.x.handle)"
check "重复邀请机器人被拒" "game_full" "$(post "/api/games/$SOLO_CODE/bot" "{\"player_id\":\"$A\",\"seat_token\":\"$TSOLO\"}" | err_code)"

MV=$(post "/api/games/$SOLO_CODE/moves" "{\"player_id\":\"$A\",\"position\":0,\"seat_token\":\"$TSOLO\"}")
check "人类落一子后机器人立刻应招" "2" "$(echo "$MV" | jq -r .plies)"
check "机器人占了中心" "4" "$(echo "$MV" | jq -r '.moves[1].position')"
check "应招后轮次回到人类" "O" "$(echo "$MV" | jq -r .turn)"

# 一路下到终局：每手都取当前第一个空格，机器人必须挡住所有威胁
GUARD=0
while [ "$(echo "$MV" | jq -r .state)" = "in_progress" ] && [ "$GUARD" -lt 9 ]; do
  EMPTY=$(echo "$MV" | jq -r '[range(9) as $i | select(.board[$i] == null) | $i][0]')
  VER=$(echo "$MV" | jq -r .version)
  MV=$(post "/api/games/$SOLO_CODE/moves" "{\"player_id\":\"$A\",\"position\":$EMPTY,\"version\":$VER,\"seat_token\":\"$TSOLO\"}")
  GUARD=$((GUARD + 1))
done
STATE=$(echo "$MV" | jq -r .state)
check "单人对机器人能走到终局" "true" "$([ "$STATE" != "in_progress" ] && echo true || echo "$STATE")"
check "机器人没有被击败" "true" "$([ "$STATE" != "o_won" ] && echo true || echo "$STATE")"
check "人机对局也留下完整棋谱" "$(echo "$MV" | jq -r .plies)" \
  "$(curl -s "$BASE/api/games/$SOLO_CODE/replay" | jq -r '.moves | length')"

# 难度是这一局的属性：三档都能入座并回显，缺省兼容为 hard，非法值被拒
echo "== 机器人难度 =="
for DIFF in hard medium easy; do
  D=$(uuidgen | tr 'A-Z' 'a-z')
  DR=$(post /api/games "{\"player_id\":\"$D\"}")
  DC=$(echo "$DR" | jq -r .code)
  TD=$(echo "$DR" | jq -r .seat_token)
  DV=$(post "/api/games/$DC/bot" "{\"player_id\":\"$D\",\"difficulty\":\"$DIFF\",\"seat_token\":\"$TD\"}")
  check "$DIFF 档入座后回显难度" "$DIFF" "$(echo "$DV" | jq -r .bot_difficulty)"
done

DEFAULT_VIEW=$(post /api/games "{\"player_id\":\"$A\"}")
DEFAULT=$(echo "$DEFAULT_VIEW" | jq -r .code)
TDEFAULT=$(echo "$DEFAULT_VIEW" | jq -r .seat_token)
check "缺省难度兼容为 hard" "hard" \
  "$(post "/api/games/$DEFAULT/bot" "{\"player_id\":\"$A\",\"seat_token\":\"$TDEFAULT\"}" | jq -r .bot_difficulty)"

BADVIEW=$(post /api/games "{\"player_id\":\"$A\"}")
BADCODE=$(echo "$BADVIEW" | jq -r .code)
TBAD=$(echo "$BADVIEW" | jq -r .seat_token)
BAD_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/games/$BADCODE/bot" \
  -H 'content-type: application/json' -d "{\"player_id\":\"$A\",\"difficulty\":\"impossible\",\"seat_token\":\"$TBAD\"}")
check "非法难度被拒" "422" "$BAD_STATUS"

# 观战 SSE：订阅后落子，应收到 move 事件（事件里只带通知，端上回拉快照）
echo "== 观战与战绩 =="
WATCH_A=$(uuidgen | tr 'A-Z' 'a-z')
WATCH_B=$(uuidgen | tr 'A-Z' 'a-z')
WVIEW=$(post /api/games "{\"player_id\":\"$WATCH_A\"}")
WC=$(echo "$WVIEW" | jq -r .code)
TWA=$(echo "$WVIEW" | jq -r .seat_token)
post "/api/games/$WC/join" "{\"player_id\":\"$WATCH_B\"}" > /dev/null
curl -sN -m 4 "$BASE/api/games/$WC/events" > /tmp/smoke-sse.txt 2>/dev/null &
SSE_PID=$!
sleep 1
post "/api/games/$WC/moves" "{\"player_id\":\"$WATCH_A\",\"position\":4,\"seat_token\":\"$TWA\"}" > /dev/null
wait $SSE_PID 2>/dev/null
check "SSE 观战收到落子通知" "1" "$(grep -c '^event: move' /tmp/smoke-sse.txt)"

# 战绩榜：真人局进榜，人机局不进榜（防止刷简单机器人霸榜）
LB_BODY=$(curl -s "$BASE/api/leaderboard")
check "战绩榜接口可用" "array" "$([ "$(echo "$LB_BODY" | jq -r '.entries | type')" = array ] && echo array || echo bad)"
LB_A=$(uuidgen | tr 'A-Z' 'a-z')
LB_B=$(uuidgen | tr 'A-Z' 'a-z')
LB_SOLO=$(uuidgen | tr 'A-Z' 'a-z')

# 只下一局时不能上榜（门槛 5 局），下满 5 局才出现 —— 顺带验证门槛真的生效
play_one_human_game() {
  LVIEW=$(post /api/games "{\"player_id\":\"$LB_A\"}")
  LC=$(echo "$LVIEW" | jq -r .code)
  TLA=$(echo "$LVIEW" | jq -r .seat_token)
  TLB=$(post "/api/games/$LC/join" "{\"player_id\":\"$LB_B\"}" | jq -r .seat_token)
  for P in 0 3 1 4 2; do
    if [ "$P" = 0 ] || [ "$P" = 1 ] || [ "$P" = 2 ]; then WHO=$LB_A; TK=$TLA; else WHO=$LB_B; TK=$TLB; fi
    post "/api/games/$LC/moves" "{\"player_id\":\"$WHO\",\"position\":$P,\"seat_token\":\"$TK\"}" > /dev/null
  done
}
play_one_human_game
LB_ONCE=$(curl -s "$BASE/api/leaderboard")
check "只下 1 局不进榜（满 5 局才上榜）" "false" \
  "$(echo "$LB_ONCE" | jq -e --arg id "$LB_A" '.entries[] | select(.player_id==$id)' >/dev/null && echo true || echo false)"
for _ in 2 3 4 5; do play_one_human_game; done
SVIEW=$(post /api/games "{\"player_id\":\"$LB_SOLO\"}")
SC=$(echo "$SVIEW" | jq -r .code)
TSC=$(echo "$SVIEW" | jq -r .seat_token)
post "/api/games/$SC/bot" "{\"player_id\":\"$LB_SOLO\",\"difficulty\":\"easy\",\"seat_token\":\"$TSC\"}" > /dev/null
for P in 0 1 2 3 4 5; do
  RES=$(post "/api/games/$SC/moves" "{\"player_id\":\"$LB_SOLO\",\"position\":$P,\"seat_token\":\"$TSC\"}")
  [ "$(echo "$RES" | jq -r .state)" != in_progress ] && break
done
LB_FRESH=$(curl -s "$BASE/api/leaderboard")
check "满 5 局后进榜且战绩为 5 局" "5" \
  "$(echo "$LB_FRESH" | jq -r --arg id "$LB_A" '.entries[] | select(.player_id==$id) | .played')"
check "人机局不进战绩榜" "false" \
  "$(echo "$LB_FRESH" | jq -e --arg id "$LB_SOLO" '.entries[] | select(.player_id==$id)' >/dev/null && echo true || echo false)"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m全部 %d 项通过\033[0m\n' "$PASS"
else
  printf '\033[31m%d 项失败 / 共 %d 项\033[0m\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
