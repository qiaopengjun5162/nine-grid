//! 导出全部 3⁹ 个棋盘上的 `winner` 结果，用于和 Lean 形式化交叉比对。
//!
//! 输出格式：`code,winner`（0 = 无胜者, 1 = O, 2 = X），
//! 与 `verification/lean/Dump.lean` 完全一致。

use nine_grid_core::{Board, Mark};

/// 这是一个导出工具，输出到 stdout 正是它的职责。
#[allow(clippy::print_stdout)]
fn main() {
    for n in 0..19683u32 {
        let mut codes = [0u8; 9];
        let mut rest = n;
        for code in codes.iter_mut() {
            *code = (rest % 3) as u8;
            rest /= 3;
        }
        let board = Board::from_codes(&codes).expect("三进制铺出的棋盘一定合法");
        let winner = match board.winner() {
            None => 0,
            Some(Mark::O) => 1,
            Some(Mark::X) => 2,
        };
        println!("{n},{winner}");
    }
}
