# 审计报告：九宫棋（nine-grid）

> 立场：假设我不认识这个项目的作者，只看代码、跑测试、按「用户会不会吃亏 / 记录能不能被篡改」两条线判断。
> 版本：main @ 2026-11-27。程序 ID `AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6`（Devnet）。

## 结论先行

| 问题 | 回答 |
|---|---|
| 能不能给人玩？ | 能。链上版任何人有 Phantom + Devnet 测试币即可开局，不需要后端；本地版 `docker compose up` 一条命令。 |
| 记录可不可信？ | **链上版可信，本地版不可信**。链上棋谱由交易决定；本地版身份是座位凭证，不是密码学身份。 |
| 规则有没有第二份实现？ | 没有。三个宿主共用 `nine-grid-core`，链上只保留身份校验。 |
| 现在最大的风险？ | 缺超时/认输（A-03）：对手掉线，这局永久卡在 `InProgress`，租金也拿不回。 |
| 能不能公开运营？ | 不能。未审计、未上主网，A-03 未修，且没有 TLS / 反代 / 备份。 |

## 一、架构（从信任边界看，而不是从目录看）

```
                    nine-grid-core（纯规则，无 IO）
                   /            |            \
          本地服务端          Solana 程序        机器人
        (信服务器)          (信链，不信人)      (同一条 apply)
              |                 |
        房间码 + UUID        钱包签名 + PDA
```

三条边界值得单独说：

1. **规则边界**：`Game::apply` 是唯一状态转换入口。本地版和链上版都调它，链上没有 `judge()` 副本。
2. **身份边界**：链上由 `Signer` + `mark_of` 保证「只能替自己落子」；本地版**没有这一层**，见 A-02。
3. **记录边界**：链上账户是唯一记录，账户被 `close` 就没了；本地版只存 `moves`，棋盘永远由重放得出。

## 二、发现清单

严重度定义：**P0** = 会让用户丢记录或让安全承诺不成立；**P1** = 阻断对外可用或明显削弱可信度；**P2** = 体验与运营。

| 编号 | 级别 | 位置 | 问题 | 影响 | 状态 |
|---|---|---|---|---|---|
| A-01 | P0 | `chain/.../lib.rs` `CloseGame` | 对局进行中，创建者可以关掉账户 | 对手的棋谱、胜负、记录一起消失，且无任何救济手段。等于「快输了就掀桌」 | **已修** |
| A-02 | P0 | `static/app.js`、`server/src/api.rs` | 身份是客户端自报的 UUID（localStorage 生成，请求体直接采信） | 知道别人 UUID 就能替他落子；两个浏览器可对刷战绩 | **部分修复**：加座位凭证，冒充已挡住；自刷与榜单口径仍未解决（见第四节） |
| A-03 | P1 | 链上程序（仅 4 个指令） | 没有超时、认输、和棋协议 | 对手掉线 → 这局永远卡在 `InProgress`。A-01 修复后**连创建者也不能关**了，租金锁死 | 未修，见下方权衡 |
| A-04 | P1 | 仓库根目录 | 没有 Dockerfile / compose，`config.rs` 只读 `DATABASE_URL` 与 `BIND_ADDR` | 非开发者无法部署；「自托管」目前只是开发者选项 | **已修**：`Dockerfile` + `compose.yaml`，容器内冒烟 44/44 |
| A-05 | P1 | `server/src/api.rs` | 无速率限制 | 任何人可无限建局把库刷大；SSE 连接也无上限 | **部分修复**：写接口按 IP 限流（默认 300/分钟，可配），SSE 并发仍无上限 |
| A-06 | P1 | `static/chain.js` | 硬判断 `window.solana?.isPhantom` | 手机浏览器、Backpack、Solflare 全部进不来 | 未修 |
| A-07 | P1 | `static/chain.html` importmap | Anchor / web3.js 从 `esm.sh` 加载 | CDN 不可达或被墙时整页白屏（此前已因 `Buffer` 缺 polyfill 踩过一次） | 已知，未消除 |
| A-08 | P1 | `chain/tests/nine-grid.ts` | 原「关局」用例写成 `try { fetch; assert.fail() } catch {}`，`assert.fail` 被自己的 catch 吞掉 | 账户没被关也能通过 —— 典型假绿，等于这条断言从没生效过 | **已修** |
| A-09 | P2 | `server/src/db.rs` `leaderboard` | 按 `wins` 排序、无最小场次；`handle` 由玩家自填 | 赢一局可压过 20 场的人；昵称可重名抢注 | 未修 |
| A-10 | P2 | 链上 | `close_game` 后该局从列表消失（交易仍在链上） | 与「任何人都能查棋谱」有张力；文档已写明只承诺「未被关掉的局」 | 已注明 |
| A-11 | P2 | `verification/lean` | Lean 是对规则的**重述**，不是从 Rust 提取 | 两边可能同时走偏；靠 3⁹ 穷举比对兜底，而非证明 | 已注明 |

### A-03 的权衡（写清楚，不藏）

A-01 的修复是「对局中不许关」。这带来一个直接后果：**对手跑掉，这局就永久卡住，租金也拿不回来。**

- 现阶段可以接受：一局账户约 0.0016 SOL（Devnet 测试币），且创建者仍可在「等待入座」阶段撤回。
- 正式版必须补：`resign`（认输，对手获胜）或基于最后落子时间的超时裁定。两者都需要新增指令，
  并且要和 core 的终局语义对齐 —— 不是加个 `if` 就完事。

## 三、已修复：A-01（对局中可关局）

**根因**：`CloseGame` 只校验了 `has_one = player_o` 与 `close`，没有校验 `state`。
所有权校验替代不了状态校验 —— 这是 Anchor 里最常见的疏漏之一。

**修法**（`chain/programs/nine-grid/src/lib.rs`）：

```rust
#[account(
    mut,
    has_one = player_o,
    close = player_o,
    constraint = !game.state.is_in_progress() @ NineGridError::GameInProgress
)]
pub game: Account<'info, Game>,
```

三个决定：

1. **只禁 `InProgress`，不是「必须终局」**。若要求必须终局，创建者建错局就无法撤回，空局租金永久占用。
2. **先 `has_one` 再判状态**。别人拿你的局来试，得到的是「不是你的局」，不泄露对局是否进行中。
3. **错误码单独给 `GameInProgress`**，前端能给出人话，而不是一句 `ConstraintRaw`。

**测试同步**（11 项，`chain/tests/nine-grid.ts`）：

- 非建局者关局 → `ConstraintHasOne`；
- 建局者在 `InProgress` 关局 → `GameInProgress`，并断言账户原封不动；
- 等待入座可撤回；终局后可关（退租金）；
- 修掉 A-08 的空断言：改成 `closed = false; try { fetch } catch { closed = true }` 再断言 `closed`。

**前端**（`chain.html` / `chain.js`）：对局中仍隐藏按钮，但对建局者多显示一句
「对局中关不掉这个账户 —— 这条限制在链上，不是按钮藏起来了」。
藏按钮是体验，约束在链上才是规则；两者不能互相替代。

## 四、部分修复：A-02（本地版没有身份）

**现状**：`app.js` 首次进入时生成一个 UUID 存进 `localStorage`，之后每个请求把它放在 body 里；
`api.rs::play_move` 直接拿它去 `db::play`，服务端不验任何签名或令牌。

**能被怎样利用**：

1. 知道某人的 `player_id`（比如从 `GET /api/games/{code}` 的座位信息里读到）→ 可以替他落子；
2. 同一个人开两个浏览器 → 自己跟自己下，稳定刷胜场；
3. 排行榜因此只能当「这个库里有这些人下过棋」，不能当排名。

**已实施（方案 A：座位令牌）**：

- 迁移 `0003_seat_tokens.sql`：`seat_tokens(game_id, mark, token_hash)`，一局一席位一条，只存 SHA-256。
- 建局 / 入座时签发 32 字节随机凭证，明文**只在响应里出现一次**；服务端不保留明文。
- 落子与邀请机器人必须带 `seat_token`，否则 `missing_seat_token`；带了但对不上 `bad_seat_token`。
- 校验顺序：先判「是不是这个座位的人」再判凭证 —— 路人仍然得到 `not_a_player`，不会因为没凭证就变成另一类错误。
- 前端把凭证按房间号存 `localStorage`；换设备打开同一局，能看、不能下（提示「这局不是从这台设备开的」）。
- 冒烟从 42 项增到 44 项，专门有两条拒绝用例：不带凭证、凭证不对。

**残余风险（没解决，别当成解决了）**：

1. **自刷战绩**：一个人开两个浏览器，各自持有自己的凭证，仍然能稳定刷胜场。凭证只回答「你是不是这个座位」，不回答「你是谁」。
2. **凭证丢失即失座**：清掉 localStorage、换浏览器、隐私模式关窗，都会永久失去该座位（局还在，只是下不了）。
   这是有意的取舍：宁可丢座位，也不允许「凭 player_id 就能拿回凭证」——那等于没加。
3. **旧局不可下**：迁移前创建的局没有凭证行，落子会被拒。演示库可接受，生产要提前公告。

**要继续做到「战绩可信」，只有方案 B**：`challenge → signMessage → ed25519 验签`，把战绩绑到公钥上，
并且只让绑定钱包的局进榜。代价是「不用装钱包也能玩」这个卖点会打折扣，所以没在这轮做 ——
它是个产品决策，不是技术决策。

## 五、已修复：A-04（无法部署）

**修之前的实际情况**：只有 `cargo run` 一条路。要跑起来得先有 Rust 1.94、Postgres 14+、
一个建好的库，还得知道 `DATABASE_URL` 默认指向哪。「自托管」写在 README 里，但只有开发者能兑现。

**修法**：`Dockerfile` + `compose.yaml` 两件东西，不做别的。

- 多阶段构建：`rust:1.94-slim-bookworm` 编译，`debian:bookworm-slim` 运行；运行层只有
  二进制、静态文件和 `ca-certificates`/`curl`（后者给健康检查用），镜像 116 MB。
- 运行层非 root（uid 10001）、只读挂载静态目录、`HEALTHCHECK` 打 `/healthz`。
- `migrations` 是编译期内嵌的（`sqlx::migrate!`），所以空库起来会自己建表；
  compose 里 `db` 用 `pg_isready` 做健康检查，`app` 等它 healthy 再起。
- compose 里数据库口令是明文常量，只适合本地/内网；对外部署要换 secrets。

**实测（2026-11-27，OrbStack，Apple Silicon）**：

| 检查 | 结果 |
|---|---|
| `docker compose up -d --build` | 冷构建 15m50s（含拉基础镜像与 release LTO），两个容器 healthy |
| `docker compose exec app id` | `uid=10001(ninegrid)`，不是 root |
| 空库启动 | 日志出现「数据库已就绪，migrations 已应用」，无需手工建表 |
| `BASE_URL=… bash scripts/smoke.sh` | **44/44 通过** |
| `docker compose restart app` 后查同一局 | 棋局还在（数据在 `pgdata` 卷） |

**这没解决什么**（别说成「能对外运营了」）：

- 口令是 compose 里的明文常量，不是 secret 管理。
- 单实例、无备份策略；`pgdata` 卷坏了就是全丢。

## 六、部分修复：A-05（写接口没有速率限制）

**修之前的实际情况**：`POST /api/games` 不需要任何凭证，写一行就建一局。脚本一分钟能建几千局，
库和连接池一起被拖垮；`GET /api/games/{code}/events` 也能无限开长连接。

**修法**（`crates/server/src/ratelimit.rs` + `api.rs::limit_writes`）：

- 每个来源 IP 一个令牌桶：容量 = 每分钟额度，匀速回填；默认 300/分钟，`RATE_LIMIT_PER_MIN=0` 关闭。
- **只挂在写接口上**（建局 / 入座 / 请机器人 / 落子）。读接口与 SSE 不限 —— 观战是长连接，
  给它限流会把正常观众一起挡在门外。
- 超限返回 `429` + `Retry-After`（秒）+ `{"error":"too_many_requests"}`，前端能直接读。
- 桶表超过 4096 个 IP 时会清掉 10 分钟没动静的条目，避免被随机 IP 撑爆内存。
- 时间从参数注入（`check_at`），所以「回填」这件事能用假时钟单测，不靠 sleep。

**实测**：`RATE_LIMIT_PER_MIN=3` 启动后连发 5 次建局 → `201 201 201 429 429`，
`Retry-After: 19`；同一时刻连读 8 次 `GET /api/leaderboard` 全是 `200`；默认配置下冒烟 44/44 不受影响。

**这没解决什么**：

1. **SSE 连接数仍无上限**：开一万条长连接照样能压垮进程。按 IP 限制并发连接要做，但会和「多窗口观战」冲突，
   需要产品决策。
2. **不识别用户**：同一个 NAT 后面的人共用一个桶；换 IP 就能重来。它是闸门，不是防刷单。
3. **不读 `X-Forwarded-For`**：反代后面所有请求都来自代理 IP，会共用一个桶。
   要么让代理自己限流（nginx `limit_req`），要么以后按可信代理白名单解析真实 IP。
4. 只限频次，不限「库总量」：慢速刷一整天依然能把库撑大，需要清理策略，没做。

## 七、复核方式（任何人都能自己跑）

```bash
cargo test -p nine-grid-core -p nine-grid-bot   # 35 项
bash scripts/smoke.sh                           # 44 项（需先起服务与 Postgres）
bash scripts/chain-test.sh                      # 11 项真实交易 + 前端交易构造
just browser-e2e                                # 浏览器全链路（模拟 Phantom）
just lean-verify && just lean-compare           # 21 条定理 + 19683 棋盘逐行比对
```

链上部分的关键证据不是「测试绿了」，而是：**部署后的程序在真实验证器上拒绝了非法交易**。
A-01 的验证方式是构造一笔「对局中关局」的交易，确认返回 `GameInProgress` 且账户未被关闭。

## 八、本次审计没有做的事

- 没有做形式化验证之外的密码学审计（无自研密码学，风险低）。
- 没有审计 Anchor 0.32.1 与 `@coral-xyz/anchor` 本身的已知问题。
- 没有做前端供应链审计（`esm.sh` 的实际产物未逐行核对，只确认了加载路径）。
- 没有在真机 Phantom 上走查（自动化是注入模拟 provider，不是真实扩展）。这一条仍需要人手动过一遍。
