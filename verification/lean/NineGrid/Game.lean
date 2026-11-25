import NineGrid.Basic
import NineGrid.Winner

/-!
# 对局状态机与不变量

这一层对齐 Rust `Game` / `Game::apply` / `Game::start` 的语义：

- 只有 `inProgress` 能落子（`waiting` 要先 `start`，终局一律拒绝）；
- 落子必须轮到本人、且目标格为空；
- 落子后若出现三连，立即进入对应终局，**不再换手**；
- 否则若棋盘下满进入平局；否则换手。

要证明的核心不是"任何棋盘都互斥"（`Winner.lean` 已给出反例），
而是**可达状态**上的不变量：一旦棋盘出现胜者，状态必是终局；
而终局禁止落子，所以真实对局永远走不到"双方同时三连"。
-/
namespace NineGrid

-- `apply` 的条件绑定（`if h : ...`）只用于分支前提，名字不参与计算。
set_option linter.unusedVariables false

/-- 对局状态。与 Rust `GameState` 一致。 -/
inductive GameState : Type
  | waiting
  | inProgress
  | oWon
  | xWon
  | draw
  deriving DecidableEq, Repr

namespace GameState

/-- 是否终局。与 Rust `GameState::is_over` 一致。 -/
def isOver : GameState → Bool
  | oWon | xWon | draw => true
  | waiting | inProgress => false

end GameState

/-- 对局。只建模规则相关字段（不建模 id / 玩家 id 等存储字段）。 -/
structure Game where
  board : Board
  turn : Mark
  state : GameState
  plies : Nat


/-- 已开局、空盘、`O` 先手。对应 Rust 里 `start()` 之后的初始局面。 -/
def Game.initial : Game :=
  { board := emptyBoard, turn := .O, state := .inProgress, plies := 0 }

/-- 落子。只建模成功/失败（具体错误码见 Rust `RuleError`）。

条件写成正向的 `if h : ...`，成功分支可直接拿到前提，证明更直接；
语义与 Rust 的三道 `return Err` 完全等价。 -/
def Game.apply (g : Game) (m : Mark) (p : Fin 9) : Option Game :=
  if h1 : g.state = .inProgress then
    if h2 : m = g.turn then
      if h3 : g.board p = none then
        let b := setCell g.board p (some m)
        match winner b with
        | some w =>
          some { board := b
                 turn := g.turn
                 state := if w = .O then .oWon else .xWon
                 plies := g.plies + 1 }
        | none =>
          if isFullB b then
            some { board := b, turn := g.turn, state := .draw, plies := g.plies + 1 }
          else
            some { board := b, turn := m.other, state := .inProgress, plies := g.plies + 1 }
      else none
    else none
  else none

/-- 从初始局面出发、经任意合法落子序列可达的状态。 -/
inductive Reachable : Game → Prop
  | init : Reachable Game.initial
  | step {g g' : Game} {m : Mark} {p : Fin 9} :
      Reachable g → g.apply m p = some g' → Reachable g'

/-- 成功落子的完整前提与结果形状。所有后续证明都从这条引理出发。 -/
theorem apply_spec {g g' : Game} {m : Mark} {p : Fin 9}
    (h : g.apply m p = some g') :
    g.state = .inProgress ∧ m = g.turn ∧ g.board p = none ∧
      g'.board = setCell g.board p (some m) ∧ g'.plies = g.plies + 1 := by
  unfold Game.apply at h
  dsimp only at h
  split at h
  · rename_i h1
    split at h
    · rename_i h2
      split at h
      · rename_i h3
        split at h
        · rename_i w hw
          injection h with heq
          subst heq
          exact ⟨h1, h2, h3, rfl, rfl⟩
        · split at h
          · rename_i hf
            injection h with heq
            subst heq
            exact ⟨h1, h2, h3, rfl, rfl⟩
          · rename_i hf
            injection h with heq
            subst heq
            exact ⟨h1, h2, h3, rfl, rfl⟩
      · simp at h
    · simp at h
  · simp at h

/-- 成功落子必然发生在对局中。 -/
theorem apply_state {g g' : Game} {m : Mark} {p : Fin 9}
    (h : g.apply m p = some g') : g.state = .inProgress :=
  (apply_spec h).1

/-- 成功落子后步数恰好加一。 -/
theorem apply_plies {g g' : Game} {m : Mark} {p : Fin 9}
    (h : g.apply m p = some g') : g'.plies = g.plies + 1 :=
  (apply_spec h).2.2.2.2

/-- 成功落子后，落子格恰好是该方的子。 -/
theorem apply_board_self {g g' : Game} {m : Mark} {p : Fin 9}
    (h : g.apply m p = some g') : g'.board p = some m := by
  obtain ⟨_, _, _, hb, _⟩ := apply_spec h
  rw [hb]
  exact setCell_same g.board p (some m)

/-- 成功落子后，其他格保持原样。 -/
theorem apply_board_other {g g' : Game} {m : Mark} {p q : Fin 9}
    (h : g.apply m p = some g') (hpq : q ≠ p) : g'.board q = g.board q := by
  obtain ⟨_, _, _, hb, _⟩ := apply_spec h
  rw [hb]
  exact setCell_other hpq

/-- 核心不变量：成功落子后，若新棋盘已有胜者，则新状态必是终局。

证明直接来自 `apply` 的构造：`winner` 为 `some` 时状态被设成 `oWon`/`xWon`；
为 `none` 时状态是 `draw` 或 `inProgress`，前提不成立。 -/
theorem apply_winner_over {g g' : Game} {m : Mark} {p : Fin 9}
    (h : g.apply m p = some g') :
    winner g'.board ≠ none → g'.state.isOver = true := by
  unfold Game.apply at h
  dsimp only at h
  intro hw
  split at h
  · rename_i h1
    split at h
    · rename_i h2
      split at h
      · rename_i h3
        split at h
        · rename_i w hw'
          injection h with heq
          subst heq
          -- g'.board 的 winner 就是 some w
          have : winner (setCell g.board p (some m)) = some w := hw'
          rw [this] at hw
          cases w <;> rfl
        · rename_i hwn
          split at h
          · rename_i hf
            injection h with heq
            subst heq
            exact absurd hwn hw
          · rename_i hf
            injection h with heq
            subst heq
            exact absurd hwn hw
      · simp at h
    · simp at h
  · simp at h

/-- 可达状态的不变量：棋盘上出现胜者时，状态必是终局。
等价说法：`inProgress` 的棋盘上不可能已有三连线。 -/
theorem reachable_winner_over : ∀ {g : Game}, Reachable g →
    winner g.board ≠ none → g.state.isOver = true
  | _, .init, hw => by
    have hwin : winner emptyBoard = none := by decide
    exact absurd hwin hw
  | _, .step _ happly, hw => apply_winner_over happly hw

/-- 推论：对局进行中（`inProgress`）的棋盘上没有三连线。 -/
theorem inProgress_no_winner {g : Game} (hr : Reachable g)
    (hs : g.state = .inProgress) : winner g.board = none := by
  apply Classical.byContradiction
  intro hw
  have hover := reachable_winner_over hr hw
  rw [hs] at hover
  have hfalse : GameState.inProgress.isOver = false := rfl
  rw [hfalse] at hover
  cases hover

/-- 终局状态下任何落子都被拒绝。与 Rust 里 `is_over` 时返回 `GameOver` 一致。 -/
theorem terminal_no_apply {g : Game} {m : Mark} {p : Fin 9}
    (hs : g.state.isOver = true) : g.apply m p = none := by
  have hne : g.state ≠ .inProgress := by
    intro h
    rw [h] at hs
    exact absurd hs (by decide)
  unfold Game.apply
  simp [hne]

/-- 单格引理：若某格被改成 `some m` 后读出来是 `some c`，且该格没被改，
则原棋盘上它本来就是 `some c`；若被改了，则 `m = c`，与 `c ≠ m` 矛盾。 -/
theorem lineMark_setCell_of_ne {g : Board} {p : Fin 9} {m c : Mark}
    {l : Fin 9 × Fin 9 × Fin 9} (hmc : c ≠ m)
    (h : lineMark (setCell g p (some m)) l = some c) :
    lineMark g l = some c := by
  obtain ⟨a, b, d⟩ := l
  rw [lineMark_eq_some_iff] at h ⊢
  obtain ⟨ha, hb, hd⟩ := h
  have cell : ∀ q, setCell g p (some m) q = some c → g q = some c := by
    intro q hq
    by_cases hqp : q = p
    · subst hqp
      rw [setCell_same] at hq
      injection hq with hEq
      exact absurd hEq (Ne.symm hmc)
    · rwa [setCell_other hqp] at hq
  exact ⟨cell a ha, cell b hb, cell d hd⟩

/-- 换子只会影响落子方自己的线：若新子颜色不是 `c`，
则 `c` 在落子后仍有线，说明它在落子前就已经有线。 -/
theorem hasLine_setCell_of_ne {g : Board} {p : Fin 9} {m c : Mark} (hmc : c ≠ m)
    (h : HasLine (setCell g p (some m)) c) : HasLine g c := by
  obtain ⟨l, hl, hlm⟩ := h
  exact ⟨l, hl, lineMark_setCell_of_ne hmc hlm⟩

/-- 可达状态下双方不可能同时三连。

这是当初 Rust 穷举测试抓到的真实不变量：终局由一次落子产生；
若那一手之后另一方也有线，则它在落子前就已存在，
而落子前对局还在进行、棋盘上不该有任何三连。 -/
theorem reachable_not_both : ∀ {g : Game}, Reachable g →
    ¬ (HasLine g.board .O ∧ HasLine g.board .X) := by
  intro g hr
  induction hr with
  | init =>
    intro ⟨ho, _⟩
    have hnone : winner Game.initial.board = none := by decide
    exact winner_complete ho hnone
  | step hrg happly ih =>
    rename_i g0 g1 m0 p0
    intro ⟨ho, hx⟩
    obtain ⟨hst, _, _, hboard, _⟩ := apply_spec happly
    rw [hboard] at ho hx
    cases hm : m0
    · -- 新子是 O：X 若仍成线，说明它落子前就成线了
      rw [hm] at ho hx
      have hxg : HasLine g0.board .X :=
        hasLine_setCell_of_ne (m := .O) (c := .X) (p := p0) (by decide) hx
      have hnone : winner g0.board = none := inProgress_no_winner hrg hst
      exact winner_complete hxg hnone
    · -- 新子是 X：O 若仍成线，说明它落子前就成线了
      rw [hm] at ho hx
      have hog : HasLine g0.board .O :=
        hasLine_setCell_of_ne (m := .X) (c := .O) (p := p0) (by decide) ho
      have hnone : winner g0.board = none := inProgress_no_winner hrg hst
      exact winner_complete hog hnone

end NineGrid
