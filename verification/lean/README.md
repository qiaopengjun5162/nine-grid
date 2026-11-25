# 九宫棋规则的形式化验证（Lean 4）

用 Lean 4 把 `crates/core` 的规则层重述一遍，并用机器检查的证明回答一个问题：

> **这套规则真的像它宣称的那样工作吗？**

不依赖 Mathlib，只用 Lean core；**零 `sorry`**；所有定理只依赖三条标准公理
（`propext`、`Classical.choice`、`Quot.sound`）。

## 为什么做这个

`crates/core` 已经有 35 个单元测试，其中包括 3⁹ 穷举。那已经很强了，但测试回答的是
"我试过的这些输入都对"，形式化回答的是"**对所有输入**，只要满足前提，结论就成立"。

更重要的是把规则里那些**口头承诺**变成定理：

- "三连即胜"——`winner` 不会漏判，也不会凭空判胜；
- "对局中不会出现胜者"——`inProgress` 的棋盘上没有任何三连；
- "终局后不能落子"——这保证了真实对局**永远走不到双方同时三连**。

最后一条尤其值得说：它在任意棋盘上**是假的**（见 `counterBoard` 反例），
只对**可达状态**成立。这正是当初 Rust 穷举测试抓到的那个真实 bug 的一般化。

## 文件结构

| 文件 | 内容 |
|---|---|
| `NineGrid/Basic.lean` | `Mark` / `Board` / `WIN_LINES` / `lineMark` / `winner` / `setCell` |
| `NineGrid/Winner.lean` | 判胜的可靠性、完备性、完整规格，以及"任意棋盘可双方三连"的反例 |
| `NineGrid/Game.lean` | 状态机、`apply` 的性质、可达性不变量、终局拒绝落子、互斥定理 |
| `Dump.lean` | 导出全部 19683 个棋盘的判胜结果（交叉验证用） |
| `compare.sh` | 与 Rust `nine-grid-core` 逐行比对同一批棋盘 |

## 定理清单

### 判胜层（`Winner.lean`）

| 定理 | 说的是什么 |
|---|---|
| `lineMark_eq_some_iff` | 一条线同色于 `m` ⟺ 三格都是 `some m` |
| `winner_sound` | `winner = some m` ⟹ 真有一条线三格都是 `m` |
| `winner_complete` | 存在一条三格同色的线 ⟹ `winner ≠ none` |
| `winner_ne_none_iff` | **完整规格**：有胜者 ⟺ 存在三连线 |
| `counterBoard_has_both_lines` | **反例**：任意棋盘上双方可以同时三连 |

### 状态机层（`Game.lean`）

| 定理 | 说的是什么 |
|---|---|
| `apply_spec` | 成功落子的完整前提与结果形状（进行中、轮次正确、格子为空、只改一格、步数 +1） |
| `apply_board_self` / `apply_board_other` | 落子只影响目标格 |
| `apply_winner_over` | 落子后若有胜者，状态必是终局 |
| `reachable_winner_over` | **可达状态**上：有胜者 ⟹ 终局 |
| `inProgress_no_winner` | 对局进行中的棋盘上没有任何三连 |
| `terminal_no_apply` | 终局后任何落子都被拒绝 |
| `reachable_not_both` | **双方不可能同时三连**（可达状态） |

## 与 Rust 的对应

Lean 这边是**重述**，不是从 Rust 自动翻译的，所以两者可能走偏。
`compare.sh` 就是用来兜这个底的：两边都把 `0..19682` 按三进制铺成棋盘，
各自算 `winner`，输出 `code,winner` 后逐行比对。

```bash
bash verification/lean/compare.sh
# ✓ 两侧判胜结果完全一致（19683 个棋盘）
```

截至当前，19683 个棋盘全部一致（无胜者 11125、O 胜 4279、X 胜 4279）。

## 怎么跑

前置：Lean 4（`elan`）。项目内 `lean-toolchain` 已固定 `v4.35.0`，不需要联网拉依赖。

```bash
cd verification/lean
lake build          # 编译并检查全部证明
```

如果 `lean` / `lake` 报下载失败，通常是 shell 里的代理在干扰 elan 的联网检查；
项目已 pin 工具链，清掉代理变量即可：

```bash
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy lake build
```

## 边界：没证明什么

诚实地说清楚，比夸大更有用：

- **没证明 Rust 代码本身正确**。Lean 证明的是"这份 Lean 规则"的性质；
  它与 Rust 的一致性靠 `compare.sh` 的穷举比对，不是靠证明。
- **没建模存储、网络、链上**。`Game.apply` 只覆盖规则判定；
  Rust 里的 `RuleError` 错误码、数据库事务、Anchor 账户校验都不在这一层。
- **没证明"策略最优"**。机器人（minimax/alpha-beta）不在这里，
  这里只验证规则，不验证 AI。
- **互斥定理只对可达状态成立**。任意棋盘上双方可以同时三连（`counterBoard`），
  这不是缺陷，而是为什么必须靠状态机而不是棋盘本身来保证。

## 为什么不用 Mathlib

九宫棋是有限的组合结构，`decide`、`cases`、`simp` 足够；
为几个布尔判断引入整个 Mathlib 会让构建从秒级变成分钟级，且增加网络依赖。
这里的原则是：**能自包含就自包含**。
