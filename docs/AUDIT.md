# 审计报告：九宫棋（nine-grid）

> 立场：假设我不认识这个项目的作者，只看代码、跑测试、按「用户会不会吃亏 / 记录能不能被篡改」两条线判断。
> 版本：main @ 2026-11-25。程序 ID `AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6`（Devnet）。

## 结论先行

| 问题 | 回答 |
|---|---|
| 能不能给人玩？ | 能。链上版任何人有 Phantom + Devnet 测试币即可开局，不需要后端。 |
| 记录可不可信？ | **链上版可信，本地版不可信**。链上棋谱由交易决定；本地版身份是浏览器自报的 UUID。 |
| 规则有没有第二份实现？ | 没有。三个宿主共用 `nine-grid-core`，链上只保留身份校验。 |
| 现在最大的风险？ | 本地版没有身份（A-02），以及缺超时/认输（A-03）。 |
| 能不能公开运营？ | 不能。无托管部署、未审计、未上主网，且 A-02 未解决。 |

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
| A-02 | P0 | `static/app.js`、`server/src/api.rs` | 身份是客户端自报的 UUID（localStorage 生成，请求体直接采信） | 知道别人 UUID 就能替他落子；两个浏览器可对刷战绩；排行榜不能当排名用 | 未修，需产品决策（见第四节） |
| A-03 | P1 | 链上程序（仅 4 个指令） | 没有超时、认输、和棋协议 | 对手掉线 → 这局永远卡在 `InProgress`。A-01 修复后**连创建者也不能关**了，租金锁死 | 未修，见下方权衡 |
| A-04 | P1 | 仓库根目录 | 没有 Dockerfile / compose，`config.rs` 只读 `DATABASE_URL` 与 `BIND_ADDR` | 非开发者无法部署；「自托管」目前只是开发者选项 | 未修 |
| A-05 | P1 | `server/src/api.rs` | 无速率限制 | 任何人可无限建局把库刷大；SSE 连接也无上限 | 未修 |
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

## 四、未修复：A-02（本地版没有身份）

**现状**：`app.js` 首次进入时生成一个 UUID 存进 `localStorage`，之后每个请求把它放在 body 里；
`api.rs::play_move` 直接拿它去 `db::play`，服务端不验任何签名或令牌。

**能被怎样利用**：

1. 知道某人的 `player_id`（比如从 `GET /api/games/{code}` 的座位信息里读到）→ 可以替他落子；
2. 同一个人开两个浏览器 → 自己跟自己下，稳定刷胜场；
3. 排行榜因此只能当「这个库里有这些人下过棋」，不能当排名。

**两种修法，代价差一个量级**：

| 方案 | 做法 | 挡住什么 | 挡不住什么 | 工作量 |
|---|---|---|---|---|
| A. 座位令牌 | 建局/入座时服务端签发随机 token（只存哈希），落子必须带 | 冒充他人座位 | 自己开两号对刷 | 小（1 迁移 + 3 接口 + 前端存 token） |
| B. 钱包签名身份 | `challenge → signMessage → ed25519 验签`，`players.wallet` 落库；只有绑定钱包的战绩进榜 | 冒充 + 对刷（成本变成控制两个钱包） | 女巫（多钱包仍可刷，但痕迹公开可查） | 大（迁移 + 会话 + 前端 + 榜单口径） |

**建议**：先做 A，把「无需钱包也能玩」这个卖点保住；同时在榜单页与 README 明确写「本地版战绩未做身份校验」。
只有当排行榜要对外、或要接奖励时，才值得做 B。**不要**在没做 A 的情况下把本地版战绩当宣传点。

## 五、复核方式（任何人都能自己跑）

```bash
cargo test -p nine-grid-core -p nine-grid-bot   # 35 项
bash scripts/smoke.sh                           # 42 项（需先起服务与 Postgres）
bash scripts/chain-test.sh                      # 11 项真实交易 + 前端交易构造
just browser-e2e                                # 浏览器全链路（模拟 Phantom）
just lean-verify && just lean-compare           # 21 条定理 + 19683 棋盘逐行比对
```

链上部分的关键证据不是「测试绿了」，而是：**部署后的程序在真实验证器上拒绝了非法交易**。
A-01 的验证方式是构造一笔「对局中关局」的交易，确认返回 `GameInProgress` 且账户未被关闭。

## 六、本次审计没有做的事

- 没有做形式化验证之外的密码学审计（无自研密码学，风险低）。
- 没有审计 Anchor 0.32.1 与 `@coral-xyz/anchor` 本身的已知问题。
- 没有做前端供应链审计（`esm.sh` 的实际产物未逐行核对，只确认了加载路径）。
- 没有在真机 Phantom 上走查（自动化是注入模拟 provider，不是真实扩展）。这一条仍需要人手动过一遍。
