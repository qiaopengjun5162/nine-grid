use anchor_lang::prelude::*;

pub use nine_grid_core::{
    Board, CELLS, FIRST_MARK, GameState as CoreState, Mark, RuleError, WIN_LINES,
};

/// 格子为空
pub const EMPTY: u8 = 0;
/// 多久没有任何动静就算「弃局」（秒）。建局、入座、落子都会刷新活动时间。
///
/// 为什么是 300：一局九宫棋实际不到两分钟；给到 5 分钟是留给「想很久」的人，
/// 同时保证对手掉线时不会无限期卡住、租金也不会被永久锁死。
pub const TIMEOUT_SECS: i64 = 300;

/// 超时判定：距最后一次活动是否已经超过 [`TIMEOUT_SECS`]。
///
/// 单独抽成纯函数，是为了能在单测里覆盖边界，而不必真的等 5 分钟。
/// `now < last`（时钟回拨）时按「没超时」处理，宁可多等也不误判。
#[must_use]
pub const fn timeout_elapsed(now: i64, last_activity_at: i64) -> bool {
    now.saturating_sub(last_activity_at) >= TIMEOUT_SECS
}
/// 先手方（O 方），同时也是对局的创建者、租金的支付者
pub const MARK_O: u8 = 1;
/// 后手方（X 方）
pub const MARK_X: u8 = 2;

/// 对局状态机（链上账户的存储投影）。
///
/// 变体顺序与 [`nine_grid_core::GameState::to_code`] 严格一致：
/// Waiting=0, InProgress=1, OWon=2, XWon=3, Draw=4。
/// 这里保留 Anchor 派生是为了让 IDL 和前端能读到可读的枚举名；
/// 真正的状态转换规则住在 core，不在本文件。
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

    /// 双方已入座、棋还没下完。关局校验用这个，而不是「不是终局」——
    /// 等待入座的空局也必须允许创建者撤回。
    pub fn is_in_progress(&self) -> bool {
        matches!(self, GameState::InProgress)
    }

    /// 转成 core 的状态枚举，交给规则层判定
    #[must_use]
    pub const fn to_core(self) -> CoreState {
        match self {
            Self::WaitingForOpponent => CoreState::Waiting,
            Self::InProgress => CoreState::InProgress,
            Self::OWon => CoreState::OWon,
            Self::XWon => CoreState::XWon,
            Self::Draw => CoreState::Draw,
        }
    }

    /// 前端展示用的短标签
    pub fn label(&self) -> &'static str {
        self.to_core().as_str()
    }
}

/// 一局九宫棋的完整链上状态。
///
/// 所有字段都是定长的，所以空间可以在编译期算出来（`Game::INIT_SPACE`），
/// 不需要 `realloc`。账户布局 101 字节，与冻结版完全一致 —— 老账户可直接读。
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
    /// 最后一次活动时间（链上时钟，秒）：建局、入座、落子都会刷新。
    ///
    /// 这个字段原本叫 `created_at`（只在建局时写一次）。为了在不改账户布局、
    /// 不迁移老账户的前提下支持超时判定，改成「最后活动时间」语义 ——
    /// 字节位置和类型都没变，老账户仍能正确反序列化（值是创建时间，
    /// 对超时而言只会更早触发，不会漏判）。
    pub last_activity_at: i64,
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

    /// 把账户字段还原成 core 的规则状态机，供指令里调用 `apply`。
    ///
    /// 规则判定只有 core 一份；这里只负责「链上存储格式 → 规则层」的翻译和一致性校验。
    pub fn to_rules(&self) -> std::result::Result<nine_grid_core::Game, RuleError> {
        let board = Board::from_codes(&self.board)?;
        let turn = Mark::from_code(i16::from(self.turn)).ok_or(RuleError::InconsistentState)?;
        nine_grid_core::Game::restore(board, turn, self.state.to_core(), self.moves)
    }

    /// 把 core 规则状态机算出的结果写回账户字段
    pub fn apply_rules(&mut self, rules: &nine_grid_core::Game) {
        self.board = rules.board().to_codes();
        self.turn = rules.turn().code() as u8;
        self.state = match rules.state() {
            CoreState::Waiting => GameState::WaitingForOpponent,
            CoreState::InProgress => GameState::InProgress,
            CoreState::OWon => GameState::OWon,
            CoreState::XWon => GameState::XWon,
            CoreState::Draw => GameState::Draw,
        };
        self.moves = rules.plies();
    }

    /// 判胜：委托 core，账户这边不再自己遍历 WIN_LINES
    pub fn judge(&self) -> Option<u8> {
        Board::from_codes(&self.board)
            .ok()
            .and_then(|board| board.winner())
            .map(|mark| mark.code() as u8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 账户布局变化时，这个测试会第一时间炸掉，提醒同步改前端解码
    #[test]
    fn game_space_layout_is_stable() {
        assert_eq!(8 + Game::INIT_SPACE, 101);
    }

    /// 链上枚举顺序必须与 core 的 to_code 一致，否则 to_rules / apply_rules 会错位
    #[test]
    fn state_enum_matches_core_codes() {
        assert_eq!(GameState::WaitingForOpponent.to_core().to_code(), 0);
        assert_eq!(GameState::InProgress.to_core().to_code(), 1);
        assert_eq!(GameState::OWon.to_core().to_code(), 2);
        assert_eq!(GameState::XWon.to_core().to_code(), 3);
        assert_eq!(GameState::Draw.to_core().to_code(), 4);
    }

    /// 链上 judge 与 core 判胜在全部 3^9 棋盘上一致。
    /// 因为 judge 直接委托 core，这条测试实际在守「编码往返不丢信息」。
    #[test]
    fn judge_matches_core_on_all_19683_boards() {
        for mask in 0..3_usize.pow(CELLS as u32) {
            let mut codes = [EMPTY; CELLS];
            let mut rest = mask;
            for code in &mut codes {
                *code = (rest % 3) as u8;
                rest /= 3;
            }
            let expected = Board::from_codes(&codes).unwrap().winner().map(|m| m.code() as u8);

            let game = Game {
                player_o: Pubkey::default(),
                player_x: Pubkey::default(),
                board: codes,
                turn: MARK_O,
                state: GameState::InProgress,
                game_id: 0,
                moves: codes.iter().filter(|&&c| c != EMPTY).count() as u8,
                last_activity_at: 0,
                bump: 0,
            };
            assert_eq!(game.judge(), expected, "第 {mask} 种棋盘判胜不一致");
        }
    }

    #[test]
    fn empty_and_full_boards_have_no_winner() {
        let mut g = Game {
            player_o: Pubkey::default(),
            player_x: Pubkey::default(),
            board: [EMPTY; 9],
            turn: MARK_O,
            state: GameState::WaitingForOpponent,
            game_id: 0,
            moves: 0,
            last_activity_at: 0,
            bump: 0,
        };
        assert_eq!(g.judge(), None);
        // 经典平局局面
        g.board = [MARK_X, MARK_O, MARK_X, MARK_X, MARK_O, MARK_O, MARK_O, MARK_X, MARK_X];
        assert_eq!(g.judge(), None);
    }

    #[test]
    fn state_over_flags() {
        assert!(!GameState::WaitingForOpponent.is_over());
        assert!(!GameState::InProgress.is_over());
        assert!(GameState::OWon.is_over());
        assert!(GameState::XWon.is_over());
        assert!(GameState::Draw.is_over());
    }

    /// 超时边界：差一秒不算、满一秒算、时钟回拨不误判。
    #[test]
    fn timeout_boundary() {
        let t0 = 1_700_000_000;
        assert!(!timeout_elapsed(t0, t0), "刚活动过不该判超时");
        assert!(
            !timeout_elapsed(t0 + TIMEOUT_SECS - 1, t0),
            "差 1 秒不该判超时"
        );
        assert!(
            timeout_elapsed(t0 + TIMEOUT_SECS, t0),
            "刚好满 {} 秒应判超时",
            TIMEOUT_SECS
        );
        assert!(
            timeout_elapsed(t0 + TIMEOUT_SECS * 10, t0),
            "远超时应判超时"
        );
        assert!(
            !timeout_elapsed(t0 - 60, t0),
            "时钟回拨时按未超时处理，宁可不判"
        );
    }

    /// 加字段会让账户长度变化；这条测试守着「布局仍是 101 字节」，
    /// 因为改了长度，链上老账户就无法反序列化了。
    #[test]
    fn last_activity_shares_bytes_with_created_at() {
        assert_eq!(Game::INIT_SPACE, 93);
        assert_eq!(8 + Game::INIT_SPACE, 101);
    }
}
