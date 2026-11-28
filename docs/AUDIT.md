# 审计报告：九宫棋（nine-grid）

> 立场：假设我不认识这个项目的作者，只看代码、跑测试、按「用户会不会吃亏 / 记录能不能被篡改」两条线判断。
> 版本：main @ 2026-11-27。程序 ID `AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6`（Devnet）。

## 结论先行

| 问题 | 回答 |
|---|---|
| 能不能给人玩？ | 能。链上版任何人有 Phantom + Devnet 测试币即可开局，不需要后端；本地版 `docker compose up` 一条命令。 |
| 记录可不可信？ | **链上版可信，本地版不可信**。链上棋谱由交易决定；本地版身份是座位凭证，不是密码学身份。 |
| 规则有没有第二份实现？ | 没有。三个宿主共用 `nine-grid-core`，链上只保留身份校验。 |
| 现在最大的风险？ | 本地版身份仍可自刷（A-02 残余），以及未审计、未上主网。卡局（A-03）、钱包兼容（A-06）、CDN 依赖（A-07）都已解决。 |
| 能不能公开运营？ | 不能。未审计、未上主网，且没有 TLS / 反代 / 备份；A-02 的自刷与榜单口径也仍未解决。 |

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
| A-02 | P0 | `static/app.js`、`server/src/api.rs` | 身份是客户端自报的 UUID（localStorage 生成，请求体直接采信） | 知道别人 UUID 就能替他落子；两个浏览器可对刷战绩 | **部分修复**：加座位凭证，冒充已挡住；榜单口径已改（满 5 局按胜率），自刷仍未解决（见第四节） |
| A-03 | P1 | 链上程序（原 4 个指令） | 没有超时、认输、和棋协议 | 对手掉线 → 这局永远卡在 `InProgress`。A-01 修复后**连创建者也不能关**了，租金锁死 | **已修**：新增 `resign` + `claim_timeout`（5 分钟），见第七节 |
| A-04 | P1 | 仓库根目录 | 没有 Dockerfile / compose，`config.rs` 只读 `DATABASE_URL` 与 `BIND_ADDR` | 非开发者无法部署；「自托管」目前只是开发者选项 | **已修**：`Dockerfile` + `compose.yaml`，容器内冒烟全过（当时 44 项） |
| A-05 | P1 | `server/src/api.rs` | 无速率限制 | 任何人可无限建局把库刷大；SSE 连接也无上限 | **部分修复**：写接口按 IP 限流（默认 300/分钟，可配），SSE 并发仍无上限 |
| A-06 | P1 | `static/chain.js` | 硬判断 `window.solana?.isPhantom` | 手机浏览器、Backpack、Solflare 全部进不来 | **已修**：识别 Phantom / Solflare / Backpack / OKX，无扩展时给手机端入口，见第八节 |
| A-07 | P1 | `static/chain.html` importmap | Anchor / web3.js 从 `esm.sh` 加载 | CDN 不可达或被墙时整页白屏（此前已因 `Buffer` 缺 polyfill 踩过一次） | **已修**：依赖进 `static/vendor/`，断 CDN 实测可建局，见第八节 |
| A-08 | P1 | `chain/tests/nine-grid.ts` | 原「关局」用例写成 `try { fetch; assert.fail() } catch {}`，`assert.fail` 被自己的 catch 吞掉 | 账户没被关也能通过 —— 典型假绿，等于这条断言从没生效过 | **已修** |
| A-09 | P2 | `server/src/db.rs` `leaderboard` | 按 `wins` 排序、无最小场次；`handle` 由玩家自填 | 赢一局可压过 20 场的人；昵称可重名抢注 | **部分修复**：满 5 局才上榜、按胜率排序；昵称重名仍未解决 |
| A-10 | P2 | 链上 | `close_game` 后该局从列表消失（交易仍在链上） | 与「任何人都能查棋谱」有张力；文档已写明只承诺「未被关掉的局」 | 已注明 |
| A-11 | P2 | `verification/lean` | Lean 是对规则的**重述**，不是从 Rust 提取 | 两边可能同时走偏；靠 3⁹ 穷举比对兜底，而非证明 | 已注明 |

### A-03 的权衡（已落地，留档）

A-01 的修复是「对局中不许关」，直接后果是：**对手跑掉，这局就永久卡住，租金也拿不回来。**

当时的判断是「必须补认输或超时，并且要和 core 的终局语义对齐，不是加个 `if` 就完事」。
后来补的时候，确实在 core 的一致性校验上撞了一次（见第七节）。设计取舍与残余风险都写在那里。

### A-09 的处理（榜单口径）

原来的榜单按 `wins` 排序、没有最小场次：一个新号赢一局就能压过下了二十场的人。
现在改成 **满 5 局才上榜、按胜率排序**（同胜率比场次），并把 `min_games` 一起返回，
前端能区分「一局都没下过」和「还没人满 5 局」。冒烟里加了两条：只下 1 局不进榜、满 5 局进榜且 `played=5`。

`handle` 重名仍然没解决：昵称是玩家自填的自由文本，抢注同名在库里是允许的。
真要修需要「昵称唯一 + 改名冷却」，属于产品决策，不是这一轮的范围。

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

**测试同步**（15 项，`chain/tests/nine-grid.ts`）：

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
- 冒烟从 42 项增到 44 项（榜单门槛用例再加 1 项，现 45 项），专门有两条拒绝用例：不带凭证、凭证不对。

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
| `BASE_URL=… bash scripts/smoke.sh` | **45/45 通过** |
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
`Retry-After: 19`；同一时刻连读 8 次 `GET /api/leaderboard` 全是 `200`；默认配置下冒烟全部通过。

**这没解决什么**：

1. **SSE 连接数仍无上限**：开一万条长连接照样能压垮进程。按 IP 限制并发连接要做，但会和「多窗口观战」冲突，
   需要产品决策。
2. **不识别用户**：同一个 NAT 后面的人共用一个桶；换 IP 就能重来。它是闸门，不是防刷单。
3. **不读 `X-Forwarded-For`**：反代后面所有请求都来自代理 IP，会共用一个桶。
   要么让代理自己限流（nginx `limit_req`），要么以后按可信代理白名单解析真实 IP。
4. 只限频次，不限「库总量」：慢速刷一整天依然能把库撑大，需要清理策略，没做。

## 七、已修复：A-03（对局卡死、租金锁死）

**问题**：A-01 禁止对局中关账户之后，只要一方掉线/不想下了，这局就永久停在 `InProgress`，
双方租金（约 0.0016 SOL/局）都拿不回来，棋谱也停在半局。

**修法**：新增两条指令，**不改 core**：

| 指令 | 谁能发 | 前置条件 | 结果 |
|---|---|---|---|
| `resign()` | 局内任一方 | 状态必须是 `InProgress` | 对手获胜，进入终局（随后建局者可关局退租金） |
| `claim_timeout()` | **等着的那一方** | `InProgress`，且距最后活动 ≥ 300 秒 | 发起方获胜 |

四个设计决定，都有代价，写在这里备查：

1. **超时看「最后活动时间」，不是「创建时间」。**
   建局、入座、落子都会刷新它，否则一局下了十分钟的正常对局会被判超时。
   实现上复用了原来的 `created_at` 字段并改名为 `last_activity_at`：**账户仍是 101 字节**，
   老账户照常反序列化，不需要 `realloc`，也不需要迁移脚本。代价是字段语义变了，
   棋谱馆的「时间」显示从「创建时间」变成「最后活动时间」。
2. **core 里不加「认输」。** 认输不改变任何一格棋子，它是协议动作而不是棋盘规则。
   把它塞进 `GameState` 会让 Lean 那 21 条定理、本地版重放、链上 `restore` 全部跟着改，
   而且会污染「状态由棋盘决定」这条不变量。
3. **因此撞到一个真实冲突（测试抓到的）**：认输产生的终局**没有三连线**，
   `Game::restore` 的校验会认为「盘面与结果自相矛盾」，落子返回 `InconsistentState` 而不是 `GameAlreadyOver`。
   修法是让 `play` 在进规则层之前先按账户状态短路；**规则层不迁就协议动作**，
   它继续只认棋盘事实。这条如果不改，认输后对手点棋盘会看到一个莫名其妙的错误码。
4. **300 秒是硬编码常量，不做成每局参数。** 一旦允许建局者自定义窗口，
   就会出现「设 1 秒逼对手超时」的攻击面；要做也只能给下限。代价是长考局可能被误判（见残余风险）。

**验证**：

- 单测 11 项（新增 3 项：认输归属、超时归属、状态门禁；超时边界覆盖 299/300/时钟回拨）；
- 链上 E2E 15 项（新增 4 项：认输成功、认输的三个拒绝分支、超时拒绝分支、活动时间随落子刷新），
  另 1 项「等满 5 分钟」的成功路径默认跳过（`LIVE_TIMEOUT=1` 才跑），避免 CI 被拖长；
- Devnet 实测：两个真实钱包建局 → 入座 → O 认输 → 显示「X 方获胜」→ 建局者关局退租金，全链路无报错；
- 升级核对：`solana program dump` 与本地 `.so` 前 230608 字节 **0 差异**，尾部为扩容填充的 0。

**残余风险（没解决的，别当成解决了）**：

- 5 分钟是常量：思考很久的正规对局可能被对手判超时。正式版应做「每局可配 + 下限保护」。
- 判罚只认链上 `Clock`。本地时钟偏差只影响按钮什么时候点亮，不影响裁决结果（链上会拒绝过早的申领）。
- 没有「和棋协议」：双方都掉线的局，谁先回来谁赢。
- 认输/超时的终局在棋盘上没有三连线，棋谱馆需要靠状态文案解释，不能只画连线。

## 八、已修复：A-06（只认 Phantom）、A-07（依赖 CDN）

**A-06：钱包不再写死一家。** 浏览器钱包的注入点是各自的：

| 钱包 | 注入位置 |
|---|---|
| Phantom | `window.phantom.solana`（旧版也占 `window.solana`） |
| Solflare | `window.solflare` |
| Backpack | `window.backpack` |
| OKX | `window.okxwallet.solana` |
| 其他 | 直接占 `window.solana` |

按顺序取第一个有 `connect()` 的 provider，用同一层薄适配器喂给 `AnchorProvider` ——
它们都实现了 `publicKey / connect / signTransaction / signAllTransactions`，不需要引入整套
wallet-adapter（那会带来构建步骤和几百 KB 依赖，与「纯静态、无构建」的取舍冲突）。

手机上没有扩展时，不再只说「装 Phantom」，而是给「用 Phantom App 打开」的深链
（`phantom.app/ul/browse/<当前页>`）——手机端本来就该用钱包内置浏览器。

**A-07：依赖进仓库，不再依赖 CDN。** 从 esm.sh 取 `?bundle` 产物（子依赖已内联、
无外部 `import`），放进 `crates/server/static/vendor/`：

| 文件 | 大小 | 用途 |
|---|---|---|
| `anchor.bundle.mjs` | 583 KB | `@coral-xyz/anchor@0.32.1` |
| `web3.bundle.mjs` | 331 KB | `@solana/web3.js@1.98.4` |
| `buffer.bundle.mjs` | 28 KB | Node `Buffer` polyfill（挂在 `globalThis`） |

importmap 改为指向本地文件；`chain.html` 与 `chain-archive.html` 都换了。
GitHub Pages 的组装脚本同步复制 `vendor/`（`pages.yml` 里加了一行 `cp`，并在 `paths` 里加了
`crates/server/static/vendor/**` 触发条件）。

**验证**：Playwright 拦截并阻断所有 `esm.sh` 请求后打开链上页 —— **0 次外部请求**，
连接钱包、建局、撤回全部成功，无 console 报错。这比「打开一次让它进缓存」可靠：缓存会过期，
而文件在仓库里。

**残余风险**：

- 桌面端只验证了「注入式 provider + 模拟钱包」与真实 Devnet 交易，**没有在每个钱包扩展里逐一走查**；
- bundle 由 esm.sh 生成，不是我们自己从 npm 构建，未逐行审计；升级依赖时要重新取产物并同步
  `chain/package.json` 的版本，否则前端与测试用的 SDK 版本会漂移。

## 九、复核方式（任何人都能自己跑）

```bash
cargo test -p nine-grid-core -p nine-grid-bot   # 35 项
bash scripts/smoke.sh                           # 45 项（需先起服务与 Postgres）
bash scripts/chain-test.sh                      # 15 项真实交易 + 前端交易构造
just browser-e2e                                # 浏览器全链路（模拟 Phantom）
just lean-verify && just lean-compare           # 21 条定理 + 19683 棋盘逐行比对
```

链上部分的关键证据不是「测试绿了」，而是：**部署后的程序在真实验证器上拒绝了非法交易**。
A-01 的验证方式是构造一笔「对局中关局」的交易，确认返回 `GameInProgress` 且账户未被关闭。

## 十、本次审计没有做的事

- 没有做形式化验证之外的密码学审计（无自研密码学，风险低）。
- 没有审计 Anchor 0.32.1 与 `@coral-xyz/anchor` 本身的已知问题。
- 没有做前端供应链审计（vendored 的 esm.sh bundle 未逐行核对，只确认了它能离线工作）。
- 没有在真实手机上用 Phantom / Solflare App 走查（只验证了桌面注入式 provider 与模拟钱包）。
- 没有在真机 Phantom 上走查（自动化是注入模拟 provider，不是真实扩展）。这一条仍需要人手动过一遍。
