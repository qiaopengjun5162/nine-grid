import NineGrid

/-!
把全部 3⁹ = 19683 个棋盘上的 `winner` 结果导出成 `code,winner` 两列，
用于和 Rust `nine-grid-core` 的同名导出逐一比对。

这不是定理，是交叉验证工具：定理保证的是"规格正确"，
这个脚本保证的是"Lean 的判胜与 Rust 生产实现逐格一致"。
-/
open NineGrid

/-- 把 0..19682 按三进制铺成棋盘（低位对应 `Fin 9` 的 0 号格）。 -/
def boardOfCode (n : Nat) : Board :=
  fun i =>
    match (n / 3 ^ i.val) % 3 with
    | 0 => none
    | 1 => some .O
    | 2 => some .X
    | _ => none

/-- 判胜结果的紧凑编码：0 = 无, 1 = O, 2 = X。与 Rust 侧一致。 -/
def markCode : Option Mark → Nat
  | none => 0
  | some .O => 1
  | some .X => 2

def main : IO Unit := do
  for n in List.range 19683 do
    IO.println s!"{n},{markCode (winner (boardOfCode n))}"
