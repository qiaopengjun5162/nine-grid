//! 九宫棋（井字棋）纯规则引擎。
//!
//! 这一层**故意什么都不知道**：不知道 HTTP、不知道 Postgres、不知道 Solana，
//! 只接受「当前局面 + 谁下了哪一格」，返回新局面或规则错误。
//!
//! 这样做的好处是它可以被三个宿主同时复用：
//!
//! 1. `nine-grid-server`：axum 服务端权威裁决；
//! 2. 未来的 Anchor 链上程序：把 `apply` 原样搬进去即可；
//! 3. 测试：把 19683 种棋盘全部穷举一遍，证明判胜没有遗漏。
//!
//! 棋盘编号：
//!
//! ```text
//!   0 | 1 | 2
//!  ---+---+---
//!   3 | 4 | 5
//!  ---+---+---
//!   6 | 7 | 8
//! ```

use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 棋盘格子数
pub const CELLS: usize = 9;

/// 先手方，同时是建局者
pub const FIRST_MARK: Mark = Mark::O;

/// 八条获胜线路：3 行 + 3 列 + 2 条对角线。
///
/// 写成常量数组而不是运行时扫描，链上落地时计算量是固定且可预测的。
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

/// 棋子标记
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Mark {
    /// 先手（建局者）
    O,
    /// 后手（加入者）
    X,
}

impl Mark {
    /// 数据库 / 链上账户里的编码：O = 1，X = 2，空 = 0
    #[must_use]
    pub const fn code(self) -> i16 {
        match self {
            Self::O => 1,
            Self::X => 2,
        }
    }

    /// 从编码还原，非法值返回 `None`
    #[must_use]
    pub const fn from_code(code: i16) -> Option<Self> {
        match code {
            1 => Some(Self::O),
            2 => Some(Self::X),
            _ => None,
        }
    }

    /// 对手
    #[must_use]
    pub const fn other(self) -> Self {
        match self {
            Self::O => Self::X,
            Self::X => Self::O,
        }
    }
}

impl fmt::Display for Mark {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::O => "O",
            Self::X => "X",
        })
    }
}

impl FromStr for Mark {
    type Err = RuleError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "O" | "o" => Ok(Self::O),
            "X" | "x" => Ok(Self::X),
            _ => Err(RuleError::OutOfRange),
        }
    }
}

/// 棋盘：9 个格子，`None` 表示空。
///
/// 用 `Option<Mark>` 而不是 `u8`，是为了让「空」在类型层面就不等于任何棋子，
/// 避免 0 / ' ' / 255 这类魔法值在层与层之间来回翻译出错。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Board([Option<Mark>; CELLS]);

impl Board {
    /// 空棋盘
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    /// 读一格
    #[must_use]
    pub fn get(&self, index: usize) -> Option<Mark> {
        self.0.get(index).copied().flatten()
    }

    /// 这一格是不是空的（越界视为不空）
    #[must_use]
    pub fn is_empty_at(&self, index: usize) -> bool {
        index < CELLS && self.0[index].is_none()
    }

    /// 棋盘是否下满
    #[must_use]
    pub fn is_full(&self) -> bool {
        self.0.iter().all(Option::is_some)
    }

    /// 落子；不做规则校验，只做边界校验（校验属于 [`Game::apply`]）
    fn place(&mut self, index: usize, mark: Mark) {
        if index < CELLS {
            self.0[index] = Some(mark);
        }
    }

    /// 判定胜者：最多 8 次三格比较，命中即返回。
    ///
    /// 真实对局中三连即终局，不可能出现双方同时三连；
    /// 若传入构造出来的非法棋盘，则按 [`WIN_LINES`] 的顺序返回第一条命中的线路。
    #[must_use]
    pub fn winner(&self) -> Option<Mark> {
        WIN_LINES.iter().find_map(|&[a, b, c]| {
            let mark = self.0[a]?;
            (mark == self.0[b]? && mark == self.0[c]?).then_some(mark)
        })
    }

    /// 逐格视图，给 UI / 序列化用
    #[must_use]
    pub fn cells(&self) -> &[Option<Mark>; CELLS] {
        &self.0
    }
}

/// 对局状态机
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameState {
    /// 已建局，等待对手加入
    Waiting,
    /// 对局进行中
    InProgress,
    /// O 方获胜
    OWon,
    /// X 方获胜
    XWon,
    /// 九格下满无人三连
    Draw,
}

impl GameState {
    /// 是否已经结束
    #[must_use]
    pub const fn is_over(self) -> bool {
        matches!(self, Self::OWon | Self::XWon | Self::Draw)
    }

    /// 稳定的字符串编码，用于数据库与前端
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::InProgress => "in_progress",
            Self::OWon => "o_won",
            Self::XWon => "x_won",
            Self::Draw => "draw",
        }
    }
}

impl FromStr for GameState {
    type Err = RuleError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "waiting" => Ok(Self::Waiting),
            "in_progress" => Ok(Self::InProgress),
            "o_won" => Ok(Self::OWon),
            "x_won" => Ok(Self::XWon),
            "draw" => Ok(Self::Draw),
            _ => Err(RuleError::UnknownState),
        }
    }
}

impl fmt::Display for GameState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 规则错误。服务端会把它翻成 HTTP 状态码，链上会翻成 `require!`。
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RuleError {
    /// 对手还没加入就落子
    #[error("这局棋还在等对手加入")]
    NotStarted,
    /// 已经终局还想落子
    #[error("对局已经结束了")]
    GameOver,
    /// 不是当前该落子的一方
    #[error("还没轮到你落子")]
    NotYourTurn,
    /// 格子已经被占
    #[error("这个格子已经有棋子了")]
    CellOccupied,
    /// 格子编号越界
    #[error("格子编号必须在 0-8 之间")]
    OutOfRange,
    /// 重复开始
    #[error("对局已经在进行中")]
    AlreadyStarted,
    /// 数据库里读到了未知状态
    #[error("未知的对局状态")]
    UnknownState,
}

impl RuleError {
    /// 稳定的错误码，前端按它做提示
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::NotStarted => "not_started",
            Self::GameOver => "game_over",
            Self::NotYourTurn => "not_your_turn",
            Self::CellOccupied => "cell_occupied",
            Self::OutOfRange => "out_of_range",
            Self::AlreadyStarted => "already_started",
            Self::UnknownState => "unknown_state",
        }
    }
}

/// 一局棋的规则状态（不含玩家身份、不含版本号 —— 那些是服务端的事）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Game {
    board: Board,
    turn: Mark,
    state: GameState,
    plies: u8,
}

impl Game {
    /// 刚建好、还没人加入的空局
    #[must_use]
    pub fn waiting() -> Self {
        Self {
            board: Board::empty(),
            turn: FIRST_MARK,
            state: GameState::Waiting,
            plies: 0,
        }
    }

    /// 从一串落子重放出一局棋。
    ///
    /// 这是整个项目的核心约定：**棋谱是唯一真相，棋盘是投影**。
    /// 数据库只存 `(mark, position)` 序列，任何时候都能重算出局面。
    pub fn replay(moves: &[(Mark, u8)]) -> Result<Self, RuleError> {
        Self::replay_with(moves, !moves.is_empty())
    }

    /// 带「是否已经开局」标志的重放。
    ///
    /// 为什么需要这个标志：一局棋可能已经有两个玩家、却一手都没下
    /// （`waiting -> in_progress` 是加入动作触发的，不产生落子）。
    /// 只看棋谱会把这种局面误判成"还没人加入"，所以开局状态必须由存储层告知。
    pub fn replay_with(moves: &[(Mark, u8)], started: bool) -> Result<Self, RuleError> {
        let mut game = Self::waiting();
        if started {
            game.start()?;
        }
        for &(mark, position) in moves {
            game.apply(mark, position)?;
        }
        Ok(game)
    }

    /// 第二个玩家加入，开局
    pub fn start(&mut self) -> Result<(), RuleError> {
        if self.state != GameState::Waiting {
            return Err(RuleError::AlreadyStarted);
        }
        self.state = GameState::InProgress;
        self.turn = FIRST_MARK;
        Ok(())
    }

    /// 落子。所有规则校验都在这里，调用方没有绕过余地。
    pub fn apply(&mut self, mark: Mark, position: u8) -> Result<(), RuleError> {
        let index = usize::from(position);
        if index >= CELLS {
            return Err(RuleError::OutOfRange);
        }
        match self.state {
            GameState::Waiting => return Err(RuleError::NotStarted),
            s if s.is_over() => return Err(RuleError::GameOver),
            _ => {}
        }
        if mark != self.turn {
            return Err(RuleError::NotYourTurn);
        }
        if !self.board.is_empty_at(index) {
            return Err(RuleError::CellOccupied);
        }

        self.board.place(index, mark);
        self.plies += 1;

        match self.board.winner() {
            // 三连即终局，不再换手（终局后 `turn` 保持为获胜方）
            Some(winner) => {
                self.state = if winner == Mark::O {
                    GameState::OWon
                } else {
                    GameState::XWon
                };
            }
            None if self.board.is_full() => {
                self.state = GameState::Draw;
            }
            None => {
                self.turn = mark.other();
            }
        }
        Ok(())
    }

    /// 试算：返回「如果 `mark` 落在 `position`」之后的新局面，原局面保持不变。
    ///
    /// 存在的意义是让 AI / 前端预览**不必自己复制一份规则**：
    /// 它走的还是 [`Self::apply`] 这条唯一校验路径，所以试算结果不可能比正式落子更宽松。
    pub fn after(&self, mark: Mark, position: u8) -> Result<Self, RuleError> {
        let mut next = self.clone();
        next.apply(mark, position)?;
        Ok(next)
    }

    /// 当前棋盘
    #[must_use]
    pub const fn board(&self) -> &Board {
        &self.board
    }

    /// 当前该谁落子
    #[must_use]
    pub const fn turn(&self) -> Mark {
        self.turn
    }

    /// 对局状态
    #[must_use]
    pub const fn state(&self) -> GameState {
        self.state
    }

    /// 已落子步数
    #[must_use]
    pub const fn plies(&self) -> u8 {
        self.plies
    }

    /// 是否终局
    #[must_use]
    pub const fn is_over(&self) -> bool {
        self.state.is_over()
    }
}

/// 终局时谁赢了；平局或未结束返回 `None`
#[must_use]
pub fn winner_mark(state: GameState) -> Option<Mark> {
    match state {
        GameState::OWon => Some(Mark::O),
        GameState::XWon => Some(Mark::X),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board_from(cells: [Option<Mark>; CELLS]) -> Board {
        let mut board = Board::empty();
        for (index, mark) in cells.iter().enumerate() {
            if let Some(mark) = mark {
                board.place(index, *mark);
            }
        }
        board
    }

    /// 独立的判胜实现：手写 8 条线，不复用 `WIN_LINES`。
    /// 用它去比对正式实现，能抓出常量数组里的索引笔误。
    /// 返回 `(O 是否三连, X 是否三连)`。
    fn reference_lines(b: &Board) -> (bool, bool) {
        let c = b.cells();
        let has = |m: Mark| {
            (c[0] == Some(m) && c[1] == Some(m) && c[2] == Some(m))
                || (c[3] == Some(m) && c[4] == Some(m) && c[5] == Some(m))
                || (c[6] == Some(m) && c[7] == Some(m) && c[8] == Some(m))
                || (c[0] == Some(m) && c[3] == Some(m) && c[6] == Some(m))
                || (c[1] == Some(m) && c[4] == Some(m) && c[7] == Some(m))
                || (c[2] == Some(m) && c[5] == Some(m) && c[8] == Some(m))
                || (c[0] == Some(m) && c[4] == Some(m) && c[8] == Some(m))
                || (c[2] == Some(m) && c[4] == Some(m) && c[6] == Some(m))
        };
        (has(Mark::O), has(Mark::X))
    }

    #[test]
    fn winner_matches_reference_on_all_19683_boards() {
        let mut contradictory = 0_u32;

        for mask in 0..3_usize.pow(CELLS as u32) {
            let mut board = Board::empty();
            let mut rest = mask;
            for index in 0..CELLS {
                match rest % 3 {
                    1 => board.place(index, Mark::O),
                    2 => board.place(index, Mark::X),
                    _ => {}
                }
                rest /= 3;
            }

            let (o_line, x_line) = reference_lines(&board);
            match (o_line, x_line) {
                // 双方都三连：真实对局里不可能出现（终局即停止落子），
                // 此时只要求实现能识别出"有人赢了"，不规定谁优先。
                (true, true) => {
                    contradictory += 1;
                    assert!(board.winner().is_some(), "第 {mask} 种棋盘漏判双赢局面");
                }
                (true, false) => assert_eq!(
                    board.winner(),
                    Some(Mark::O),
                    "第 {mask} 种棋盘应判 O 赢: {:?}",
                    board.cells()
                ),
                (false, true) => assert_eq!(
                    board.winner(),
                    Some(Mark::X),
                    "第 {mask} 种棋盘应判 X 赢: {:?}",
                    board.cells()
                ),
                (false, false) => assert_eq!(
                    board.winner(),
                    None,
                    "第 {mask} 种棋盘不该有胜者: {:?}",
                    board.cells()
                ),
            }
        }

        // 确认穷举真的覆盖到了双赢的退化情形，而不是一条都没碰到
        assert!(contradictory > 0, "双赢棋盘数量应大于 0");
    }

    #[test]
    fn detects_every_win_line() {
        for line in WIN_LINES {
            for mark in [Mark::O, Mark::X] {
                let mut board = Board::empty();
                for index in line {
                    board.place(index, mark);
                }
                assert_eq!(board.winner(), Some(mark), "漏判 {mark} 的 {line:?}");
            }
        }
    }

    #[test]
    fn empty_board_has_no_winner() {
        assert_eq!(Board::empty().winner(), None);
        assert!(!Board::empty().is_full());
    }

    #[test]
    fn full_draw_board_has_no_winner() {
        //  O X O
        //  O X X
        //  X O O
        let board = board_from([
            Some(Mark::O),
            Some(Mark::X),
            Some(Mark::O),
            Some(Mark::O),
            Some(Mark::X),
            Some(Mark::X),
            Some(Mark::X),
            Some(Mark::O),
            Some(Mark::O),
        ]);
        assert!(board.is_full());
        assert_eq!(board.winner(), None);
    }

    #[test]
    fn fresh_game_waits_for_opponent() {
        let game = Game::waiting();
        assert_eq!(game.state(), GameState::Waiting);
        assert_eq!(game.turn(), Mark::O);
        assert_eq!(game.plies(), 0);
    }

    #[test]
    fn cannot_move_before_opponent_joins() {
        let mut game = Game::waiting();
        assert_eq!(game.apply(Mark::O, 4), Err(RuleError::NotStarted));
    }

    #[test]
    fn rejects_illegal_moves() {
        let mut game = Game::waiting();
        game.start().unwrap();

        // 越界
        assert_eq!(game.apply(Mark::O, 9), Err(RuleError::OutOfRange));
        // 不该 X 先走
        assert_eq!(game.apply(Mark::X, 0), Err(RuleError::NotYourTurn));

        game.apply(Mark::O, 4).unwrap();
        // 同一格重复落子
        assert_eq!(game.apply(Mark::X, 4), Err(RuleError::CellOccupied));
        // 又轮到 O 以外的人了
        assert_eq!(game.apply(Mark::O, 0), Err(RuleError::NotYourTurn));
    }

    #[test]
    fn winning_move_ends_game_and_freezes_turn() {
        let mut game = Game::waiting();
        game.start().unwrap();
        // O: 0,1,2 / X: 3,4
        for (mark, pos) in [(Mark::O, 0), (Mark::X, 3), (Mark::O, 1), (Mark::X, 4)] {
            game.apply(mark, pos).unwrap();
        }
        game.apply(Mark::O, 2).unwrap();

        assert_eq!(game.state(), GameState::OWon);
        assert_eq!(game.plies(), 5);
        assert_eq!(game.turn(), Mark::O, "终局后不再换手");
        assert_eq!(game.apply(Mark::X, 5), Err(RuleError::GameOver));
        assert_eq!(winner_mark(game.state()), Some(Mark::O));
    }

    #[test]
    fn ninth_move_without_line_is_draw() {
        let mut game = Game::waiting();
        game.start().unwrap();
        //  O X O
        //  O X X
        //  X O O
        let sequence = [
            (Mark::O, 0),
            (Mark::X, 1),
            (Mark::O, 2),
            (Mark::X, 4),
            (Mark::O, 3),
            (Mark::X, 5),
            (Mark::O, 7),
            (Mark::X, 6),
            (Mark::O, 8),
        ];
        for (mark, pos) in sequence {
            game.apply(mark, pos).unwrap();
        }
        assert_eq!(game.state(), GameState::Draw);
        assert_eq!(game.plies(), 9);
        assert!(game.is_over());
        assert_eq!(winner_mark(game.state()), None);
    }

    #[test]
    fn replay_rebuilds_the_same_game() {
        let sequence = [
            (Mark::O, 4),
            (Mark::X, 0),
            (Mark::O, 3),
            (Mark::X, 1),
            (Mark::O, 5),
        ];
        let replayed = Game::replay(&sequence).unwrap();

        let mut incremental = Game::waiting();
        incremental.start().unwrap();
        for (mark, pos) in sequence {
            incremental.apply(mark, pos).unwrap();
        }

        assert_eq!(replayed, incremental);
        assert_eq!(replayed.state(), GameState::OWon);
    }

    #[test]
    fn replaying_an_illegal_sequence_fails() {
        // 同一格下两次
        let bad = [(Mark::O, 4), (Mark::X, 4)];
        assert_eq!(Game::replay(&bad), Err(RuleError::CellOccupied));
        // 顺序错乱
        let bad_turn = [(Mark::X, 0)];
        assert_eq!(Game::replay(&bad_turn), Err(RuleError::NotYourTurn));
    }

    #[test]
    fn replay_of_empty_moves_is_a_waiting_game() {
        let game = Game::replay(&[]).unwrap();
        assert_eq!(game.state(), GameState::Waiting);
        assert_eq!(game, Game::waiting());
    }

    #[test]
    fn replay_with_started_flag_keeps_empty_game_in_progress() {
        // 对手已加入、但双方都还没落子：棋谱是空的，局面却不是 waiting
        let replayed = Game::replay_with(&[], true).unwrap();
        let mut started = Game::waiting();
        started.start().unwrap();
        assert_eq!(replayed, started);
        assert_eq!(replayed.state(), GameState::InProgress);
    }

    #[test]
    fn replay_without_start_rejects_moves() {
        let moves = [(Mark::O, 0)];
        assert_eq!(Game::replay_with(&moves, false), Err(RuleError::NotStarted));
    }

    #[test]
    fn after_does_not_mutate_the_original() {
        let mut game = Game::waiting();
        game.start().unwrap();

        let next = game.after(Mark::O, 4).unwrap();
        assert_eq!(game.plies(), 0, "试算不能改动原局面");
        assert_eq!(next.plies(), 1);
        assert_eq!(next.board().get(4), Some(Mark::O));

        // 试算同样受规则约束，非法落子照样报错
        assert_eq!(game.after(Mark::X, 0), Err(RuleError::NotYourTurn));
        assert_eq!(game.after(Mark::O, 9), Err(RuleError::OutOfRange));
    }

    #[test]
    fn mark_codes_round_trip() {
        for mark in [Mark::O, Mark::X] {
            assert_eq!(Mark::from_code(mark.code()), Some(mark));
            assert_eq!(mark.to_string().parse::<Mark>(), Ok(mark));
            assert_eq!(mark.other().other(), mark);
        }
        assert_eq!(Mark::from_code(0), None);
        assert_eq!(Mark::from_code(3), None);
    }

    #[test]
    fn state_codes_round_trip() {
        for state in [
            GameState::Waiting,
            GameState::InProgress,
            GameState::OWon,
            GameState::XWon,
            GameState::Draw,
        ] {
            assert_eq!(state.as_str().parse::<GameState>(), Ok(state));
        }
        assert_eq!("bogus".parse::<GameState>(), Err(RuleError::UnknownState));
    }
}
