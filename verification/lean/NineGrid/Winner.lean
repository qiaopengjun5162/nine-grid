import NineGrid.Basic

/-!
# 判胜逻辑的规格

这一层只谈棋盘本身，不谈对局状态机。要证明的是：
`winner` 确实等价于「按 `WIN_LINES` 顺序找第一条三格同色的线」，
既不会漏判，也不会凭空判胜。

同时给出一个反例：**任意棋盘上双方可以同时三连**。
这不是 bug，而是为什么"互斥"必须由状态机保证（见 `Game.lean`）。
-/
namespace NineGrid

/-- 一条线三格同色时，`lineMark` 恰好返回该颜色；否则返回 `none`。
这是 `lineMark` 的完整规格，后面所有判胜证明都建立在它上面。 -/
theorem lineMark_eq_some_iff {b : Board} {a c d : Fin 9} {m : Mark} :
    lineMark b (a, c, d) = some m ↔
      b a = some m ∧ b c = some m ∧ b d = some m := by
  unfold lineMark
  cases h : b a with
  | none => simp [h]
  | some m' =>
    simp only [h]
    by_cases hcd : b c = some m' ∧ b d = some m'
    · have hif :
          (if b c = some m' ∧ b d = some m' then some m' else none) = some m' := by
        simp [hcd]
      rw [hif]
      constructor
      · intro heq
        exact ⟨heq, hcd.1.trans heq, hcd.2.trans heq⟩
      · intro hh
        exact hh.1
    · have hif :
          (if b c = some m' ∧ b d = some m' then some m' else none) = none := by
        simp [hcd]
      rw [hif]
      constructor
      · intro hbad
        exact absurd hbad (by simp)
      · intro ⟨hm, hbc, hbd⟩
        exfalso
        apply hcd
        constructor
        · rw [← hm] at hbc; exact hbc
        · rw [← hm] at hbd; exact hbd

/-- 若 `winnerFrom` 返回某个标记，则列表里确实有一条线是这个标记。 -/
theorem winnerFrom_sound {b : Board} {ls : List (Fin 9 × Fin 9 × Fin 9)} {m : Mark}
    (h : winnerFrom b ls = some m) : ∃ l ∈ ls, lineMark b l = some m := by
  induction ls with
  | nil => simp [winnerFrom] at h
  | cons l ls ih =>
    simp only [winnerFrom] at h
    split at h
    · rename_i m' hm
      injection h with heq
      subst heq
      exact ⟨l, List.mem_cons_self .., hm⟩
    · rename_i hm
      obtain ⟨l', hl', hlm⟩ := ih h
      exact ⟨l', List.mem_cons_of_mem l hl', hlm⟩

/-- 若列表里有一条线是某标记，则 `winnerFrom` 不会返回 `none`。 -/
theorem winnerFrom_complete {b : Board} {ls : List (Fin 9 × Fin 9 × Fin 9)} {m : Mark}
    (h : ∃ l ∈ ls, lineMark b l = some m) : winnerFrom b ls ≠ none := by
  induction ls with
  | nil => obtain ⟨l, hl, _⟩ := h; simp at hl
  | cons l ls ih =>
    obtain ⟨l', hl', hlm⟩ := h
    simp only [winnerFrom]
    cases hl' with
    | head =>
      simp only [hlm]
      simp
    | tail _ hmem =>
      split
      · simp
      · exact ih ⟨l', hmem, hlm⟩

/-- 判胜的可靠性：`winner` 说有胜者，棋盘上就真有一条该颜色的三连线。 -/
theorem winner_sound {b : Board} {m : Mark} (h : winner b = some m) :
    ∃ l ∈ winLines, lineMark b l = some m :=
  winnerFrom_sound h

/-- 判胜的完备性：只要存在一条三连线，`winner` 就不会是 `none`。 -/
theorem winner_complete {b : Board} {m : Mark}
    (h : ∃ l ∈ winLines, lineMark b l = some m) : winner b ≠ none :=
  winnerFrom_complete h

/-- `winner` 的完整规格：有胜者 ⟺ 存在某条三连线。 -/
theorem winner_ne_none_iff {b : Board} :
    winner b ≠ none ↔ ∃ l ∈ winLines, ∃ m, lineMark b l = some m := by
  constructor
  · intro h
    cases hw : winner b with
    | none => exact absurd hw h
    | some m => obtain ⟨l, hl, hlm⟩ := winner_sound hw; exact ⟨l, hl, m, hlm⟩
  · intro ⟨l, hl, m, hlm⟩
    exact winner_complete ⟨l, hl, hlm⟩

/-! ## 反例：棋盘本身不保证互斥 -/

/-- 一个非法但可构造的棋盘：O 占第一行，X 占第二行，双方各有一条线。 -/
def counterBoard : Board :=
  fun i =>
    match i.val with
    | 0 => some .O
    | 1 => some .O
    | 2 => some .O
    | 3 => some .X
    | 4 => some .X
    | 5 => some .X
    | _ => none

/-- 双方可以在同一个棋盘上同时三连。
所以"双方不同时三连"**不能**作为棋盘的定理，只能作为可达状态的定理。 -/
theorem counterBoard_has_both_lines :
    HasLine counterBoard .O ∧ HasLine counterBoard .X := by
  constructor
  · exact ⟨(0, 1, 2), by decide, by decide⟩
  · exact ⟨(3, 4, 5), by decide, by decide⟩

end NineGrid
