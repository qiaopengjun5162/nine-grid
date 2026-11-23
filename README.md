# 九宫棋 · Nine Grid

<!-- 仓库名如果改了，把下面 badge 里的 nine-grid 一起换掉 -->

[![CI](https://github.com/qiaopengjun5162/nine-grid/actions/workflows/ci.yml/badge.svg)](https://github.com/qiaopengjun5162/nine-grid/actions/workflows/ci.yml)
[![Pages](https://github.com/qiaopengjun5162/nine-grid/actions/workflows/pages.yml/badge.svg)](https://github.com/qiaopengjun5162/nine-grid/actions/workflows/pages.yml)
[![release](https://github.com/qiaopengjun5162/nine-grid/actions/workflows/release.yml/badge.svg)](https://github.com/qiaopengjun5162/nine-grid/actions/workflows/release.yml)
[![MSRV](https://img.shields.io/badge/MSRV-1.94-blue)](Cargo.toml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

**链上版在线试玩**：<https://qiaopengjun5162.github.io/nine-grid/> （已部署到 Solana Devnet，连 Phantom 即可玩）

公园里的九宫棋（井字棋），先用 Rust 做成一个**真能下**的网页游戏。

> 三个棋子横、竖、斜连成一条直线即获胜。规则只有一句话，正好用来练「把状态机写对」这件事。

当前状态：**本地版 + 链上版都已跑通** —— 建局 → 邀请 → 轮流落子 → 规则裁决 → 终局 → 棋谱回放，
外加「一个人也能下」的机器人（简单 / 中等 / 困难三档）。本地版端到端检查、链上版 10 项真实交易测试全过。

两个阶段共用**同一份规则代码**（`crates/core`）：本地版和 Solana 链上程序都调用它，规则只有一份。
先做本地版再上链的理由，以及迁移时哪些代码没动，见文末。

---

## 一、架构：一个引擎，三个宿主

```text
                      ┌──────────────────────────────┐
                      │  nine-grid-core（纯规则）      │
                      │  无 HTTP · 无 DB · 无链        │
                      └───▲──────────▲──────────▲────┘
                apply()   │          │          │  to_rules()/apply()
          ┌───────────────┴──┐  ┌────┴──────┐  ┌┴──────────────────┐
          │ nine-grid-server │─▶│   bot     │  │ nine-grid (Anchor)│
          │ axum + Postgres  │  │ 极小化极大 │  │ Solana 链上程序    │
          └────────┬─────────┘  └───────────┘  └─────────┬─────────┘
                   │ JSON                                │ PDA 账户
            浏览器（原生 JS）                        Phantom / 钱包
```

规则层**不知道**自己跑在哪 —— 三个宿主调用的是同一个 `Game::apply`。
链上程序负责钱包身份、PDA、签名与事件；判胜、轮次、终局冻结一律委托 core。
`core` 为此只多了几个「存储格式 ↔ 规则状态」的桥接方法（`Board::from_codes`、`Game::restore`），
没有引入任何链上依赖 —— 它依旧零 IO。

机器人和人类在结构上是**同一种东西**：一个占 X 座位的普通玩家。
它落子前先问规则层 `game.after(me, pos)`，落子后再走一遍 `apply()` 校验 —— 规则只有一份，机器人不可能"开挂"。

### 三档难度：共用一套搜索，只在"怎么挑"上分叉

难度是**这一局的属性**（存在 `games.bot_difficulty`），邀请机器人时选定，中途不能改 ——
否则同一盘棋里它忽强忽弱，棋谱就没法解释了。三档跑的是**同一个极小化极大搜索**，
区别只在面对若干候选着法时怎么选：

| 档位 | 策略 | 结果 |
|---|---|---|
| 困难 | 永远走搜索分最高的一步 | 完美防守，你最多逼平 |
| 中等 | 只在"不输"的着法里挑，65% 走最优、35% 随机换一个平局分支 | 不犯低级错，但对手失误时它未必抓得住 |
| 简单 | 有立即胜手 80% 抓住，其余大多随手下 | 人类有明显胜面 |

关键约束：**"不输"这个判断来自搜索分（≈0 是平），不是另写一套规则。**
三档都只是从 `scored_moves()` 给出的候选里挑，挑完照样走 `apply()` 校验，
所以即使简单档"放水"，它落的每一步也依然是规则允许的合法棋。
数据库默认值是 `hard`，老数据不用回填就保持原行为。

### 观战与战绩：通知归通知，裁决归裁决

**观战**（`/watch.html?room=CODE`）走 SSE：每个房间一个广播频道，落子/入座后推一条轻量
`move` 事件（`{code, plies, state, version}`）。观战端收到后**回拉完整快照**重新渲染，
自己不判胜负、不算轮次 —— 所以它和玩家端看到的是同一份服务端真相，不存在"观战端算出另一个结果"的可能。
订阅前先拉一次快照，避免漏掉订阅之前的落子；每 15 秒一条心跳，防止反向代理掐断长连接。

**战绩榜**（`/api/leaderboard`）只统计**真人对真人**的终局对局：
判定人机局的办法是看这局有没有机器人座位（机器人就是一个 `player_id = BOT_ID` 的普通玩家行），
有则整局排除。否则挂个简单机器人刷一百局就能霸榜，数字就没有意义了。
聚合用一条 CTE：终局局 → 每玩家胜负平 → group by，不新增表。

### 三条铁律

1. **本地版：棋谱是唯一真相；链上版：盘面快照 + 事件是真相。**
   数据库里没有 `board` 字段，只有 `moves` 序列，局面由 `Game::replay` 重算，天然带「回放」。
   链上因为账户空间按字节计费、且每笔落子本来就发 `MovePlayed` 事件，所以账户存 9 格盘面快照，
   棋谱由事件拼出来。两种存储走的是**同一个规则状态机**：本地用 `replay`，链上用 `restore`
   从快照还原后再 `apply`。存法不同，规则一致。

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
│   ├── core/                   # 纯规则引擎，0 IO，被三个宿主共用
│   │   └── src/lib.rs          # Board / Game / Mark / RuleError + 22 个测试
│   ├── bot/                    # 机器人：极小化极大 + alpha-beta
│   │   └── src/lib.rs          # 三档难度共用一套搜索，13 个测试（含 200 局不败验证）
│   └── server/
│       ├── src/main.rs         # 启动、日志、优雅退出
│       ├── src/api.rs          # 玩法 + SSE 观战 + 战绩榜路由
│       ├── src/db.rs           # sqlx 查询 + 事务 + 锁 + 机器人应招 + 战绩聚合
│       ├── src/events.rs       # 房间事件总线（SSE 观战用）
│       ├── src/error.rs        # 规则错误 → HTTP 状态码
│       ├── src/config.rs
│       └── static/             # index.html / watch.html / chain.html + 对应 js（无构建步骤）
│           └── chain/idl.json  # 链上 IDL，从 chain/target/idl 复制，随合约提交
├── migrations/
│   ├── 0001_init.sql
│   └── 0002_bot_difficulty.sql
├── scripts/
│   ├── smoke.sh                # 本地版 42 项端到端检查
│   └── chain-test.sh           # 链上端到端：验证器+部署+10 项测试+前端交易验证，自包含
├── chain/                      # Solana + Anchor 链上程序（已接入 core）
│   ├── programs/nine-grid/     # 指令：create/join/play/close，规则委托 core
│   │   └── src/{lib,state,errors}.rs
│   ├── Anchor.toml
│   └── tests/nine-grid.ts      # 10 项真实链上交易测试
├── .github/
│   ├── workflows/ci.yml        # fmt · clippy · test · msrv · audit · e2e
│   ├── workflows/release.yml   # tag → 三平台 tar.gz + 自动发版说明
│   ├── workflows/pages.yml     # 链上版前端 → GitHub Pages（Devnet）
│   └── dependabot.yml
├── docs/PHANTOM_TESTING.md      # Phantom 真机测试清单（沙盒无法自动验证的部分）
├── LICENSE                     # MIT
├── .cargo/audit.toml           # cargo-audit 的忽略项（每条带理由）
├── .rustfmt.toml / .taplo.toml # 格式规则（stable 可用子集）
├── cliff.toml                  # git-cliff：按 conventional commit 生成 changelog
├── Justfile                    # just check = CI；just chain-test = 链上端到端
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
| POST | `/api/games/{code}/bot` | 建局者邀请机器人坐 X，请求体带 `difficulty`（easy/medium/hard，缺省 hard） |
| GET | `/api/games/{code}?player_id=` | 全量局面（`you` 告诉你执什么子） |
| POST | `/api/games/{code}/moves` | 落子 `{player_id, position, version}` |
| GET | `/api/games/{code}/replay` | 纯棋谱，可独立重放 |
| GET | `/api/games/{code}/events` | SSE 观战流：只推 `move` 通知，端上收到后回拉快照 |
| GET | `/api/leaderboard` | 战绩榜（只统计真人对真人） |
| GET | `/healthz` | 健康检查（含 DB 探活） |

另有观战页 `/watch.html?room=CODE`：只读旁观，收到 SSE 通知后回拉完整快照，不自己判规则。

错误统一为 `{"error": {"code": "...", "message": "..."}}`：

`not_started` · `not_your_turn` · `cell_occupied` · `game_over` · `game_full` · `stale_version` · `not_a_player` · `not_host` · `out_of_range` · `game_not_found`

房间码是 6 位 Crockford 风格字母表（去掉 `I/L/O/0/1`），手输不会看错。

---

## 五、跑起来

前置：Postgres 14+、Rust 1.94+（CI 里的 `msrv` job 会守住这条）。

```bash
createdb nine_grid
cp .env.example .env        # 可选，默认就是本机 nine_grid 库
cargo run -p nine-grid-server
```

打开 <http://127.0.0.1:8080>：

1. 点「开一局新棋」→ 拿到 6 位房间码 + 邀请链接；
2. 把链接发给对手（或换一个无痕窗口打开），对方自动入座执 X；
3. 懒得找人？选好难度点「和机器人下一盘」，它执 X 跟你下：困难档每步最优（你最多逼平），中等档少犯低级错，简单档你赢得动；
4. 轮流点格子，非法操作会给出中文提示；
5. 终局后展开「棋谱」能看到每一手落在哪；
6. 杀掉服务再启动，刷新页面 —— 棋局还在（落库了）。

`migrations` 在启动时自动执行，不需要手动迁移。

---

## 六、CI/CD

`.github/workflows/` 里三个 workflow（CI、release、Pages）。CI 里每个 job 都在替一句具体的话做担保，不跑没用的检查：

| job | 担保的是什么 | 对应命令 |
|---|---|---|
| `fmt` | 代码和 TOML 都别手搓格式 | `cargo fmt --check` + `taplo fmt --check` |
| `clippy` | 没有"能编译但显然写错"的地方 | `cargo clippy --all-targets --all-features --tests --benches -- -D warnings` |
| `test` | 26 个单测（含 3⁹ 穷举）在干净环境也能过 | `cargo nextest run --all-features` |
| `msrv` | `rust-version = "1.94"` 不是一句空话 | `cargo +1.94.0 check --locked` |
| `audit` | 依赖里没有已知漏洞 | `cargo audit` |
| `e2e` | **真 Postgres + 真二进制 + 42 项冒烟** | `cargo build` → 启动 → `scripts/smoke.sh` |

本地一条命令对齐 CI：`just check`（fmt + taplo + clippy + test + audit；需要 taplo、cargo-nextest、cargo-audit）。

三个设计决定值得单独说：

1. **`e2e` 才是真正能挡住事故的那一步。** 单测证明规则对，但证明不了「服务能启动、migrations 能跑、落库是真的」——
   所以 CI 里起一个 `postgres:17` service，跑完整个 42 项冒烟。这一步的存在感比前面五个加起来还高。
2. **`msrv` 是被 `uuid` 打脸之后才补的。** 原本写的 1.88，但 `uuid 1.29` 已经要求 1.89。
   不跑这个 job，README 上那句「Rust 1.88+」就是假话 —— 后来改成 1.89 并由 CI 看着。
   再后来 `sqlx 0.9` 把门槛抬到 1.94，这个 job 又跟着升了一次。历史可以变，但「承诺必须被验证」这条没变。
3. **`audit` 的两条忽略写在 `.cargo/audit.toml` 里，每条都带理由。** 它们来自 sqlx 的 sqlite / mysql 后端
   （`cargo tree -i libsqlite3-sys` 在默认 target 下返回 `nothing to print`，根本没编译进产物），
   不是我们能升级的。用配置文件而不是 `--ignore` 参数，是为了让"为什么忽略"跟着代码一起走。

发版是 tag 驱动的：

```bash
git tag v0.1.0 && git push --tags
```

`release.yml` 会在 linux-amd64 / linux-arm64 / macos-arm64 上各打一个 tar.gz（**二进制 + static/ 一起**）+ sha256，
发版说明用 git-cliff 按 conventional commit 自动生成。解压即用：

```bash
tar xzf nine-grid-linux-amd64.tar.gz && cd nine-grid-linux-amd64
DATABASE_URL=postgres://... ./nine-grid      # 自动读同目录的 static/
```

`STATIC_DIR` 可以指到别处（见 `main.rs` 的 `resolve_static_dir`）。这个 fallback 顺序是刻意设计的：
`env!("CARGO_MANIFEST_DIR")` 是**编译时**的绝对路径，在 CI 机器上是 `/home/runner/work/...`，
原样打进发布包就会指到不存在的目录 —— 所以先找可执行文件旁边的 `static/`，再退回源码路径。

---

## 七、测试

```bash
just check                       # = fmt + taplo + clippy + test + audit（和 CI 同款）
cargo test                       # 31 个单元测试（core 22 + bot 9）
bash scripts/smoke.sh            # 本地版 42 项端到端检查（服务需先跑起来）
just chain-unit                  # 链上 Rust 单测（含 19683 棋盘一致性）
just chain-test                  # 链上端到端：验证器+部署+10 项真实交易
```

单元测试里有三个值得单说的：

- **`winner_matches_reference_on_all_19683_boards`**（core）：把 3⁹ 种棋盘全部跑一遍，
  用一份手写的独立判胜实现作为参照，抓常量数组里的索引笔误。
- **`winning_move_ends_game_and_freezes_turn`**（core）：三连之后 `turn` 不再翻转 —— 这类"看起来无所谓"的细节，
  上链后对应的是"账户还能不能被写"，必须钉死。
- **`never_loses_against_random_play`**（bot）：200 局机器人执 O 对随机对手，一局都不许输。
  这条比"能赢"更重要 —— 它证明搜索没有漏掉防守分支。
- **`hard_beats_easy_and_never_loses_to_medium`**（bot）：三档对下 200 局，
  困难档对中档不落下风、对简单档净胜 —— 证明三档确实有强弱之分，不是换个名字的同一档。

冒烟脚本覆盖了正常对局 + 全部拒绝分支（不是你的回合、格子被占、版本过期、非玩家、终局后落子、第三人加入……）。

链上还有一条关键的**一致性测试** `judge_matches_core_on_all_19683_boards`：把 3⁹ 种棋盘在链上账户编码和 core 之间反复往返，
证明「u8 盘面 → core 判胜」这条桥不丢信息。链上端到端测试 10 项跑在真实 `solana-test-validator` 上，
用部署后的 `.so` 发真实交易，覆盖完整对局 + 全部拒绝分支 + 终局冻结 + 关账户退租金。

---

## 八、前端：让棋盘站起来

棋盘参照公园里那台装置做的：锈铁框、能翻面的木方块。实现上**没有用 WebGL**，
而是 CSS 3D + 原生 JS —— 页面打开就能下，不需要下载几 MB 的渲染引擎。

拆开看是四层：

| 层 | 做法 | 效果 |
|---|---|---|
| 透视 | `.stage` 给 `perspective`，`.board` 用 `rotateX(18deg)` 躺倒 | 近大远小，棋盘像放在桌上 |
| 体积 | 每格用 6 层实色 `box-shadow` 偏移叠出侧面 | 木块有厚度，不是贴纸 |
| 交互 | 悬停时 `translateZ(26px)` 抬起 + 淡色落点提示 | 手指还没落，木头先"被拿起来" |
| 落子 | `translateZ(160px)` 坠入、轻微过冲再稳住 | 棋子是"放"下去的，不是"出现"的 |

几个容易忽略的点：

- **轮询不能重播动画。** 前端每 1.2 秒拉一次状态，如果每次都重建 DOM，棋子会反复掉落。
  所以 `renderBoard` 做的是 diff：只改 `data-mark` 变了的那一格，并且只有
  `moves.length > 已渲染手数` 的那一手才加 `.drop`。
- **声音是算出来的，不是下载的。** 木质叩击 = 一段快速衰减的噪声（木头表面摩擦）+
  一个下滑的三角波（落定的闷响），全部用 WebAudio 现场合成，零音频文件。
  三连是三个上行泛音；平局是两声下沉。可以在棋盘下方关掉。
- **`filter` 不能随便加。** 在 3D 场景里给父元素加 `filter` 会强制扁平化，
  子元素的 `translateZ` 立刻失效。所以获胜光晕做在 `::after` 上，而不是给格子加滤镜。
- **触摸设备要收掉 hover。** 手机上点过的格子会一直保持 `:hover`，
  木块会一直翘着，所以 `@media (hover: none)` 里单独把它按回去。

页面底部还加了一小段「九宫源流」，以及一块洛书九宫图 —— 这部分是纯静态内容，
但仍然遵守同一条纪律：**文化归文化，规则归规则**，不参与任何判胜。

### 两套主题：一键切换「古典 / 星穹会员」

页眉右上角有一个切换开关，两套风格共用**同一套 DOM 和同一份规则**，只是换肤：

| 主题 | 视觉 | 灵感来源 |
|---|---|---|
| 古典（默认） | 锈铁框 + 可翻面木块 + 暖色纸质标牌 | 公园里那台实体九宫棋装置（项目起点） |
| ✦ 星穹会员 | 深空夜幕 + 星点闪烁 + 洛书星盘 + 青金发光棋子 | 中国传统星象（紫微垣 / 洛书）+ 未来科技感 |

实现要点：主题写在 `<html data-theme>` 上，CSS 用 `[data-theme="cosmos"]` 覆盖配色，
**没有第二套页面**；选择存 `localStorage`，每页 `<head>` 里有防闪烁内联脚本，深色用户不会先看到一帧浅色。
会员版的棋盘仍是那套 CSS 3D（透视 / 落子坠落 / 抬起），只是把木纹换成发光能量块，
光晕做在伪元素上而非 3D 祖先，避免 `filter` 把纵深压平。三页（本地 / 观战 / 链上）都能切换，
链上页是会员风的天然主场；`prefers-reduced-motion` 下自动关掉星光闪烁。

### 为什么没有上 Bevy

[Bevy](https://docs.rs/bevy/latest/bevy/) 是真 3D 游戏引擎，我建了探针工程实际试过：

- bevy 0.20.1，MSRV 1.97.1，本机 Rust 1.100 满足；
- 用 `default-features = false` 只开 3D + winit + render，仍要拉 66 个 `bevy_*` crate
  和数百个第三方依赖；
- `cargo check --target wasm32-unknown-unknown --release` 跑了 12 分钟还停在下载阶段
  （这台机器磁盘也只剩 24GB），我把探针停了。

但真正的原因不是编译时间，而是**它解决的问题和这里不匹配**：

| | CSS 3D（现在） | Bevy |
|---|---|---|
| 首屏 | 零额外下载 | wasm 产物 + 资源，通常 10MB 量级 |
| 构建 | 无，改完刷新 | trunk / wasm-bindgen / wasm-opt |
| 表单与中文文本 | 浏览器原生 | 要自备字体、自己做输入框 |
| 擅长 | 固定视角的棋盘 | 自由镜头、材质、粒子、复杂动画 |

所以主线不换。真要做「3D 棋院」——镜头绕着桌子走、木纹材质、观战回放——Bevy 是对的工具，
但它应该是一个**独立的只读页面**：从 `/api/games/{code}/replay` 拉棋谱，只负责渲染。
规则永远留在服务端，这一点不因为换渲染器而改变。

---

## 九、九宫源流：这盘棋的文化来路

「九宫」不是游戏公司起的名字，它比井字棋古老得多。

**「井」字来自田制。** 《孟子·滕文公上》说「方里而井，井九百亩」：一里见方的土地划成九区，
中间是公田，八家各耕百亩。田埂纵横，形如「井」字 —— 九格布局从此有了名字。

**九宫来自数术。** 汉代的明堂有九室，太一有九宫；洛书把 1 到 9 填进九格，
排成「戴九履一，左三右七，二四为肩，六八为足」，纵横斜相加都是 15。
九宫于是不只是格子，也成了一套关于方位与平衡的说法。

**棋来自民间。** 九格、三子、轮流落子，规则简单到不用文字就能教会。
它在乡野、茶馆、庙会里一路传下来，各地叫法不同：三子棋、成三棋、九宫棋。

**字格来自蒙学。** 明清习字也用九宫格：把字放进九个方格里，一笔一画都要交代清楚位置，
写稳了再撤格。今天练字仍用九宫格与米字格 —— 同一个九宫，换了用途。

**电子游戏来自 1952 年。** 英国学者 Alexander S. Douglas 在 EDSAC 上写出 OXO，
用阴极射线管显示井字棋。它是最早的电子游戏之一，比「电子游戏」这个词诞生还早。

为什么这盘棋总是和？它的全部棋盘排布不到两万种，合法局面只有五千多种，穷尽之后结论很干脆：
**双方都不犯错，先手赢不了，后手也赢不了，一定是和棋。** 真正的胜负不在棋盘上，
而在谁先看漏。三条实用次序：先占中心（唯一「一处四用」的格子）、再抢角（角参与三条线，边只参与两条）、
对手已有两子成线时先堵再谈别的。

---

## 十、开发中真实踩到的三个坑

**1. 空棋谱把 `in_progress` 算回了 `waiting`。**
对手加入后、双方还没落子时，`moves` 是空的。最初 `snapshot` 直接用棋谱重放，
于是"已开局但没落子"被算成"还在等人"，导致所有落子都报 `not_started`。
修法：重放必须带上存储层的开局标志 —— `Game::replay_with(moves, started)`，
因为「开局」是加入动作触发的，它不产生落子，棋谱里看不出来。

**2. 穷举测试暴露了"双方同时三连"的优先级未定义。**
只看棋盘（不看棋谱）时，可能存在 O 和 X 都已三连的非法局面，此时谁优先返回是随意的。
真实对局里三连即终局，这种局面不可能出现，所以没有强行规定优先级，
而是把测试改成断言不变量：单方三连必须判对，双方便只能要求"识别出有人赢了"。

**3. 静态目录用的是编译期路径，打包必然失效。**
原先写的是 `PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("static")` —— 它在 `cargo run` 下完全正常，
所以本地永远不会暴露问题。但 `CARGO_MANIFEST_DIR` 是**编译那一刻**的绝对路径，
在 GitHub runner 上是 `/home/runner/work/nine-grid/...`，打进发布包后指向空气。
是准备 release workflow 时才发现"这个包解压出来一定 404"。
修法：`resolve_static_dir()` 按 `STATIC_DIR` → 可执行文件同级的 `static/` → 源码目录 依次回退。
**教训是：凡是用 `env!` 拿到的路径，都要问一句"换台机器还成立吗"。**

---

## 十一、上链：哪些换了宿主，哪些一行没动

阶段 B 已经做完并跑通。链上程序用 Anchor 0.32.1，程序 ID `AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6`，
4 个指令（create_game / join_game / play / close_game），10 项真实交易测试全过，另有前端交易构造验证。

| 本地版 | 链上版 | 规则代码要改吗 |
|---|---|---|
| 6 位房间码 | PDA `["game", 创建者, game_id]` | 否 |
| `games` 一行 + `moves` 多行 | 一个 101 字节账户 + 落子事件 | 否（存法不同，走同一个状态机） |
| `if !ok { return Err(...) }` | `require!(ok, Error)` | 否，错误由 `RuleError → NineGridError` 一一映射 |
| `FOR UPDATE` 行锁 | Solana 账户锁（天然串行） | 否 |
| `version` 乐观锁 | 每笔交易自带 recent blockhash | 客户端换实现 |
| `player_id`（localStorage UUID） | 钱包签名 + Pubkey | 新增一层鉴权 |
| `Game::apply` 判胜/轮次/终局 | **同一个 `Game::apply`** | **完全没动** |

**最关键的一点**：冻结版合约原本自己抄了一份 `judge()` 和 `WIN_LINES`，这次上链把它们全删了。
链上账户通过 `to_rules()`（内部 `Board::from_codes` + `Game::restore`）还原成 core 的状态机，
调 `apply()` 裁决后再 `apply_rules()` 写回。规则从此只有一份 —— 改 core 一处，本地和链上同时生效。

core 为适配链上只新增了几个**纯存储桥接**方法：`Board::from_codes/to_codes`、`GameState::to_code/from_code`、
`Game::restore`。它们只做「字节 ↔ 规则状态」的翻译和一致性校验（比如状态说 O 赢，棋盘就必须真有三连），
不引入 anchor / solana 依赖，所以 core 仍然是零 IO、可独立测试的那份规则。

### 两个值得记的细节

- **账户布局保持 101 字节不变**：冻结版老账户可以直接读，不需要迁移。IDL 里的 `GameState` 枚举顺序
  与 core 的 `to_code` 严格对齐（0–4），有专门的测试守着，错位就编译期红灯。
- **`InProgress` + 0 手是合法状态**：两个钱包都入座但还没落子时就是这样。本地版曾因此踩过坑
  （空棋谱被误判成 `waiting`），链上用 `restore` 时刻意不从手数反推开局与否，只校验状态与棋盘不矛盾。

链上测试环境被沙盒坑过一次：ts-node 默认在 `$HOME` 建缓存目录，受限环境里 `mkdir` 被拒，
报成费解的 `[ERROR] No such file or directory`。`scripts/chain-test.sh` 里用 `TS_NODE_CACHE=false` 绕开了。

### 链上前端：`/chain.html`，一个能连 Phantom 的页面

浏览器端的"另一半"已经补齐。打开 `/chain.html`，连 Phantom 就能建局、凭 PDA 地址入座、
点击落子、终局后关局退租金。几个实现上的取舍：

- **无构建步骤**：Anchor 和 web3.js 通过 importmap 从 esm.sh 按 ESM 加载（版本与 `chain/package.json` 对齐），
  IDL 本地托管在 `/chain/idl.json` —— 页面是纯静态文件，不需要打包器。
- **Phantom → Anchor Wallet**：Phantom 注入的 `window.solana` 已经有 `publicKey` 和签名方法，
  补一层薄适配器就能喂给 `AnchorProvider`，不用引入整套 wallet-adapter。
- **账户订阅代替轮询**：`connection.onAccountChange(pda, …)` 在账户变化时重新解码渲染，
  比本地版的 1.2 秒轮询更及时；解码用的仍是链上账户的真实数据，前端不自己算棋盘。
- **PDA 地址就是房间号**：`["game", 创建者公钥, game_id_le]` 派生出的地址可以直接当邀请链接发出去，
  没有中心化的房间表。

因为浏览器里没法自动操作 Phantom，`chain-test.sh` 的第 5 步用 Node keypair 代替钱包，
以**和 chain.js 完全相同的方式**（同一份 IDL、同样的 PDA 派生、同样的 `program.methods` 调用、
同样的账户解码）跑一局，保证前端的交易构造逻辑不跑偏。真机上仍需手动连 Phantom 验证签名流程，
逐步操作见 [`docs/PHANTOM_TESTING.md`](docs/PHANTOM_TESTING.md)。

**公网部署**：程序已用同一把 keypair 部署到 **Solana Devnet**（程序 ID 与本地一致，所以 IDL 通用），
链上版前端经 GitHub Actions 发布到 <https://qiaopengjun5162.github.io/nine-grid/>。
页面默认 Devnet，可用 `?cluster=localnet` 切回本地验证器。
devnet 上已用 Node 脚本实跑一局（建局→入座→落子→关局）全部通过。

再往后才是可选项：给观战加回放时间轴、做跨局积分。
（三档难度、SSE 观战、战绩榜、连 Phantom 的链上前端都已经落地，见下。）

机器人已经落地了，但它是**最后一个被允许进这条流水线的东西**：
它只是坐在 X 座位上的一个普通玩家、走同一条 `/moves` 路径、留下的棋谱和真人下的没有区别。
如果哪天它想自己判胜负，这个项目就毁了 —— 那意味着规则有了第二份实现。链上版同理。

---

## License

MIT
