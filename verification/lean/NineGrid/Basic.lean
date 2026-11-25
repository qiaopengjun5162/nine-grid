/-
九宫棋规则层的形式化。

设计原则：
- 与 Rust `crates/core/src/lib.rs` **逐条对齐**，不是另写一套规则；
- 只依赖 Lean 4 core，不引 Mathlib，保证构建轻量、可离线复现；
- `winner` 与 Rust 的 `Board::winner` 同构：按 `WIN_LINES` 顺序取第一条命中的线；
- 这里只描述规则，不涉及存储、网络、链上，和 Rust 的分层保持一致。
-/
namespace NineGrid

/-- 棋子标记。与 Rust `Mark` 一致：`O` 先手，`X` 后手。 -/
inductive Mark : Type
  | O : Mark
  | X : Mark
  deriving DecidableEq, Repr

namespace Mark

/-- 对手。与 Rust `Mark::other` 一致。 -/
def other : Mark → Mark
  | O => X
  | X => O

end Mark

/-- 一格：空（`none`）或某方的子。对应 Rust `Option<Mark>`。 -/
abbrev Cell := Option Mark

/-- 棋盘：9 个格子的定长向量。对应 Rust `[Option<Mark>; 9]`。 -/
abbrev Board := Fin 9 → Cell

/-- 八条获胜线，顺序与 Rust `WIN_LINES` 完全一致：
三行、三列、两条对角线。 -/
def winLines : List (Fin 9 × Fin 9 × Fin 9) :=
  [ (0, 1, 2), (3, 4, 5), (6, 7, 8),
    (0, 3, 6), (1, 4, 7), (2, 5, 8),
    (0, 4, 8), (2, 4, 6) ]

/-- 一条线上三格的共同标记；只要有一格为空或不全同则 `none`。

与 Rust `Board::winner` 里 `find_map` 的闭包一致：
先取第一格，若为空直接出局；否则要求后两格与它相同。 -/
def lineMark (b : Board) (l : Fin 9 × Fin 9 × Fin 9) : Option Mark :=
  match l with
  | (a, c, d) =>
    match b a with
    | none => none
    | some m => if b c = some m ∧ b d = some m then some m else none

/-- 按顺序找第一条命中的线。 -/
def winnerFrom (b : Board) : List (Fin 9 × Fin 9 × Fin 9) → Option Mark
  | [] => none
  | l :: ls =>
    match lineMark b l with
    | some m => some m
    | none => winnerFrom b ls

/-- 判胜。与 Rust `Board::winner` 一致：先命中的线优先。 -/
def winner (b : Board) : Option Mark :=
  winnerFrom b winLines

/-- 在某一格放子，其余格不变。

Lean core 没有 `Function.update`（它在 Mathlib 里），这里自己定义，
避免为了一个赋值操作引入整库依赖。 -/
def setCell (b : Board) (p : Fin 9) (c : Cell) : Board :=
  fun i => if i = p then c else b i

@[simp] theorem setCell_same (b : Board) (p : Fin 9) (c : Cell) :
    setCell b p c p = c := by
  simp [setCell]

@[simp] theorem setCell_other {b : Board} {p q : Fin 9} {c : Cell} (hpq : q ≠ p) :
    setCell b p c q = b q := by
  simp [setCell, hpq]

/-- 空盘。 -/
def emptyBoard : Board := fun _ => none

/-- 某方是否在棋盘上连成一线。 -/
abbrev HasLine (b : Board) (m : Mark) : Prop :=
  ∃ l ∈ winLines, lineMark b l = some m

/-- 棋盘是否下满（可计算版本）。对应 Rust `Board::is_full`。 -/
def isFullB (b : Board) : Bool :=
  (List.finRange 9).all (fun i => decide (b i ≠ none))

/-- 棋盘是否下满（命题版本）。 -/
def isFull (b : Board) : Prop := isFullB b = true

end NineGrid
