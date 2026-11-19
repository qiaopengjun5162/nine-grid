# 九宫棋 · Nine Grid

公园里的九宫棋（井字棋），先用 Rust 做成一个**真能下**的网页游戏。

> 三个棋子横、竖、斜连成一条直线即获胜。规则只有一句话，正好用来练「把状态机写对」这件事。

当前状态：**阶段 A1 已完成，并带了一个机器人对手** —— 建局 → 邀请 → 轮流落子 → 规则裁决 → 终局 → 棋谱回放，
外加「一个人也能下」的完美防守机器人，全链路可跑，33 项端到端检查通过。

上链（Solana + Anchor）是下一步，不是起点。原因和迁移路径见文末。

上链（Solana + Anchor）是下一步，不是起点。原因和迁移路径见文末。

---

## 一、架构：一个引擎，两个宿主

```text
                      ┌──────────────────────────────┐
                      │  nine-grid-core（纯规则）      │
                      │  无 HTTP · 无 DB · 无链        │
                      └───────▲──────────────▲───────┘
                    apply()   │              │   after()
              ┌───────────────┴────┐   ┌─────┴──────────────┐
              │ nine-grid-server   │──▶│ nine-grid-bot      │
              │ axum + Postgres    │   │ 极小化极大搜索      │
              └─────────┬──────────┘   └────────────────────┘
                        │ JSON
                 浏览器（原生 JS，无构建）
```

规则层**不知道**自己跑在哪。阶段 B 到来时，Anchor 程序只是第三个调用方，`judge` / `apply` 可以原样搬过去。

机器人和人类在结构上是**同一种东西**：一个占 X 座位的普通玩家。
它落子前先问规则层 `game.after(me, pos)`，落子后再走一遍 `apply()` 校验 —— 规则只有一份，机器人不可能"开挂"。

### 三条铁律

1. **棋谱是唯一真相，棋盘是投影。**
   数据库里没有 `board` 字段，只有 `moves` 序列。局面任何时候都由 `Game::replay` 重算。
   这不只是洁癖 —— 它跟区块链 event log 是同一个模型，迁移时不用改结构，而且天然带「回放」。

2. **服务端权威，客户端只发意图。**
   前端只发 `{position: 4}`，不自己判胜负、不自己切轮次。它连"能不能点"都来自服务端返回的 `turn`。
   这跟链上「你只能发交易、结果由程序决定」的语义完全一致。

3. **并发用锁，不靠运气。**
   每笔落子在事务里 `SELECT ... FOR UPDATE` 锁住这一局，等价于链上的账户锁；
   另外对外暴露 `version`，客户端带旧版本号落子会被 `409 stale_version` 拒绝。

---

## 二、目录

```text
nine-grid/
├── crates/
│   ├── core/                   # 纯规则引擎，0 IO
│   │   └── src/lib.rs          # Board / Game / Mark / RuleError + 17 个测试
│   ├── bot/                    # 机器人：极小化极大 + alpha-beta
│   │   └── src/lib.rs          # 只依赖 core，9 个测试（含 200 局不败验证）
│   └── server/
│       ├── src/main.rs         # 启动、日志、优雅退出
│       ├── src/api.rs          # 7 个路由
│       ├── src/db.rs           # sqlx 查询 + 事务 + 锁 + 机器人应招
│       ├── src/error.rs        # 规则错误 → HTTP 状态码
│       ├── src/config.rs
│       └── static/             # index.html / style.css / app.js（无构建步骤）
├── migrations/0001_init.sql
├── scripts/smoke.sh            # 33 项端到端检查
├── chain/                      # 阶段 B 的 Anchor 探路工程（已冻结）
├── Justfile
└── Cargo.toml                  # workspace
```

---

## 三、数据模型

```sql
players(id, handle, wallet, created_at)          -- wallet 留给阶段 B
games(id, code, state, turn, plies, version, ...)
game_players(game_id, player_id, mark)           -- 1=O 2=X
moves(game_id, ply, mark, position, player_id)   -- 唯一的真相
```

**没有 `board` 列。** 这是刻意的 —— 见上面铁律 1。

状态机：

```text
waiting ──join──▶ in_progress ──三连──▶ o_won / x_won
                              └─下满──▶ draw
```

---

## 四、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/games` | 建局，创建者执 O |
| POST | `/api/games/{code}/join` | 凭 6 位房间码加入，执 X |
| POST | `/api/games/{code}/bot` | 建局者邀请机器人坐 X（等价于一个自动加入的对手） |
| GET | `/api/games/{code}?player_id=` | 全量局面（`you` 告诉你执什么子） |
| POST | `/api/games/{code}/moves` | 落子 `{player_id, position, version}` |
| GET | `/api/games/{code}/replay` | 纯棋谱，可独立重放 |
| GET | `/healthz` | 健康检查（含 DB 探活） |

错误统一为 `{"error": {"code": "...", "message": "..."}}`：

`not_started` · `not_your_turn` · `cell_occupied` · `game_over` · `game_full` · `stale_version` · `not_a_player` · `not_host` · `out_of_range` · `game_not_found`

房间码是 6 位 Crockford 风格字母表（去掉 `I/L/O/0/1`），手输不会看错。

---

## 五、跑起来

前置：Postgres 14+、Rust 1.88+。

```bash
createdb nine_grid
cp .env.example .env        # 可选，默认就是本机 nine_grid 库
cargo run -p nine-grid-server
```

打开 <http://127.0.0.1:8080>：

1. 点「开一局新棋」→ 拿到 6 位房间码 + 邀请链接；
2. 把链接发给对手（或换一个无痕窗口打开），对方自动入座执 X；
3. 懒得找人？点「和机器人下一盘」，它执 X 跟你下，**每步都最优**（你最多逼平）；
4. 轮流点格子，非法操作会给出中文提示；
5. 终局后展开「棋谱」能看到每一手落在哪；
6. 杀掉服务再启动，刷新页面 —— 棋局还在（落库了）。

`migrations` 在启动时自动执行，不需要手动迁移。

---

## 六、测试

```bash
cargo test                       # 26 个单元测试（core 17 + bot 9）
bash scripts/smoke.sh            # 33 项端到端检查（服务需先跑起来）
```

单元测试里有三个值得单说的：

- **`winner_matches_reference_on_all_19683_boards`**（core）：把 3⁹ 种棋盘全部跑一遍，
  用一份手写的独立判胜实现作为参照，抓常量数组里的索引笔误。
- **`winning_move_ends_game_and_freezes_turn`**（core）：三连之后 `turn` 不再翻转 —— 这类"看起来无所谓"的细节，
  上链后对应的是"账户还能不能被写"，必须钉死。
- **`never_loses_against_random_play`**（bot）：200 局机器人执 O 对随机对手，一局都不许输。
  这条比"能赢"更重要 —— 它证明搜索没有漏掉防守分支。

冒烟脚本覆盖了正常对局 + 全部拒绝分支（不是你的回合、格子被占、版本过期、非玩家、终局后落子、第三人加入……）。

---

## 七、开发中真实踩到的两个坑

**1. 空棋谱把 `in_progress` 算回了 `waiting`。**
对手加入后、双方还没落子时，`moves` 是空的。最初 `snapshot` 直接用棋谱重放，
于是"已开局但没落子"被算成"还在等人"，导致所有落子都报 `not_started`。
修法：重放必须带上存储层的开局标志 —— `Game::replay_with(moves, started)`，
因为「开局」是加入动作触发的，它不产生落子，棋谱里看不出来。

**2. 穷举测试暴露了"双方同时三连"的优先级未定义。**
只看棋盘（不看棋谱）时，可能存在 O 和 X 都已三连的非法局面，此时谁优先返回是随意的。
真实对局里三连即终局，这种局面不可能出现，所以没有强行规定优先级，
而是把测试改成断言不变量：单方三连必须判对，双方便只能要求"识别出有人赢了"。

---

## 八、下一步：上链要改什么

| 现在 | 上链后 | 规则代码要改吗 |
|---|---|---|
| 6 位房间码 | PDA `["game", 创建者, game_id]` | 否 |
| `games` 一行 + `moves` 多行 | 一个约 100 字节的账户 | 否 |
| `if !ok { return Err(...) }` | `require!(ok, Error)` | 只改报错写法 |
| `FOR UPDATE` 行锁 | Solana 账户锁（天然串行） | 否 |
| `version` 乐观锁 | 每笔交易自带 recent blockhash | 客户端换实现 |
| `player_id`（localStorage UUID） | Phantom 签名 + Pubkey | 新增一层鉴权 |

`chain/` 里留着一个已经过编译的 Anchor 探路工程（程序 ID `AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6`，6 个单测通过），
它证明了两件事：判胜逻辑确实很短，SBF 编译没问题。但它**没有**接入这个服务，先冻着，等玩法验证完再动。

再往后才是可选项：战绩与排行榜、观战实时化（SSE）、多种难度的机器人（现在是满分，只会让你平）。

机器人已经落地了，但它是**最后一个被允许进这条流水线的东西**：
它只是坐在 X 座位上的一个普通玩家、走同一条 `/moves` 路径、留下的棋谱和真人下的没有区别。
如果哪天它想自己判胜负，这个项目就毁了 —— 那意味着规则有了第二份实现。

---

## License

MIT
