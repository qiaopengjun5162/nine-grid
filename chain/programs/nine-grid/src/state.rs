use anchor_lang::prelude::*;

/// 格子为空
pub const EMPTY: u8 = 0;
/// 先手方（O 方），同时也是对局的创建者、租金的支付者
pub const MARK_O: u8 = 1;
/// 后手方（X 方）
pub const MARK_X: u8 = 2;

/// 九宫棋的 8 条获胜线路（3 行 + 3 列 + 2 条对角线）。
///
/// 索引与棋盘一一对应：
/// ```text
///   0 | 1 | 2
///  ---+---+---
///   3 | 4 | 5
///  ---+---+---
///   6 | 7 | 8
/// ```
/// 故意写成常量数组 + 固定 8 次比较，而不是"遍历所有格子找连续三个"，
/// 这样链上计算量是固定的、可预测的（见 README「计算单元」一节）。
pub const WIN_LINES: [[usize; 3]; 8] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

/// 对局状态机
///
/// ```text
/// WaitingForOpponent --join_game--> InProgress --play(获胜)--> OWon / XWon
///                                              --play(下满)--> Draw
/// ```
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum GameState {
    /// 已创建，等待对手加入
    WaitingForOpponent,
    /// 对局进行中
    InProgress,
    /// O 方三连获胜
    OWon,
    /// X 方三连获胜
    XWon,
    /// 棋盘下满且无人三连
    Draw,
}

impl GameState {
    pub fn is_over(&self) -> bool {
        matches!(self, GameState::OWon | GameState::XWon | GameState::Draw)
    }

    /// 前端展示用的短标签
    pub fn label(&self) -> &'static str {
        match self {
            GameState::WaitingForOpponent => "等待对手",
            GameState::InProgress => "进行中",
            GameState::OWon => "O 方获胜",
            GameState::XWon => "X 方获胜",
            GameState::Draw => "平局",
        }
    }
}

/// 一局九宫棋的完整链上状态。
///
/// 所有字段都是定长的，所以空间可以在编译期算出来（`Game::INIT_SPACE`），
/// 不需要 `realloc`，也不会因为字符串之类的变长字段产生额外租金。
#[account]
#[derive(InitSpace)]
pub struct Game {
    /// 创建者 / O 方，租金由它支付
    pub player_o: Pubkey,
    /// X 方，加入前是 `Pubkey::default()`
    pub player_x: Pubkey,
    /// 9 个格子：0 空 / 1 O / 2 X
    pub board: [u8; 9],
    /// 当前该谁落子（MARK_O / MARK_X）
    pub turn: u8,
    /// 对局状态
    pub state: GameState,
    /// 客户端传入的对局编号，配合 player_o 派生出唯一地址
    pub game_id: u64,
    /// 已落子数量，等于 9 且无胜者即为平局
    pub moves: u8,
    /// 创建时间（链上时钟，秒）
    pub created_at: i64,
    /// PDA bump，保存下来省掉后续重复计算
    pub bump: u8,
}

impl Game {
    /// 判断某个钱包在这场对局里执什么子；不是参与者返回 None
    pub fn mark_of(&self, player: &Pubkey) -> Option<u8> {
        if player == &self.player_o {
            Some(MARK_O)
        } else if self.player_x != Pubkey::default() && player == &self.player_x {
            Some(MARK_X)
        } else {
            None
        }
    }

    /// 判断胜负：固定 8 次比较，命中即返回获胜方的棋子标记
    pub fn judge(&self) -> Option<u8> {
        judge(&self.board)
    }
}

/// 纯函数版胜负判定，方便单独做单元测试。
/// 没有动态遍历，最多 8 次三格比较。
pub fn judge(board: &[u8; 9]) -> Option<u8> {
    let mut i = 0;
    while i < WIN_LINES.len() {
        let [a, b, c] = WIN_LINES[i];
        let mark = board[a];
        if mark != EMPTY && mark == board[b] && mark == board[c] {
            return Some(mark);
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 账户布局变化时，这个测试会第一时间炸掉，提醒同步改前端解码
    #[test]
    fn game_space_layout_is_stable() {
        // 8 (discriminator) + 32 + 32 + 9 + 1 + 1 + 8 + 1 + 8 + 1
        assert_eq!(8 + Game::INIT_SPACE, 101);
    }

    fn board(cells: [u8; 9]) -> [u8; 9] {
        cells
    }

    #[test]
    fn detects_all_eight_win_lines() {
        for line in WIN_LINES {
            let mut b = board([EMPTY; 9]);
            for cell in line {
                b[cell] = MARK_X;
            }
            assert_eq!(judge(&b), Some(MARK_X), "漏判了 {:?}", line);
        }
    }

    #[test]
    fn empty_and_full_boards_have_no_winner() {
        assert_eq!(judge(&board([EMPTY; 9])), None);
        // 经典平局局面：
        //   X O X
        //   X O O
        //   O X X
        let draw = board([MARK_X, MARK_O, MARK_X, MARK_X, MARK_O, MARK_O, MARK_O, MARK_X, MARK_X]);
        assert_eq!(judge(&draw), None);
    }

    #[test]
    fn mixed_marks_do_not_win() {
        let b = board([MARK_O, MARK_O, MARK_X, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);
        assert_eq!(judge(&b), None);
    }

    #[test]
    fn state_over_flags() {
        assert!(!GameState::WaitingForOpponent.is_over());
        assert!(!GameState::InProgress.is_over());
        assert!(GameState::OWon.is_over());
        assert!(GameState::XWon.is_over());
        assert!(GameState::Draw.is_over());
    }
}
