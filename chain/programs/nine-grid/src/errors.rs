use anchor_lang::prelude::*;
use nine_grid_core::RuleError;

#[error_code]
pub enum NineGridError {
    #[msg("这局棋还在等对手加入")]
    GameNotStarted,
    #[msg("对局已经结束了")]
    GameAlreadyOver,
    #[msg("这一局已经有对手了")]
    GameAlreadyFull,
    #[msg("不能和自己下棋")]
    CannotPlayYourself,
    #[msg("还没轮到你落子")]
    NotYourTurn,
    #[msg("这个格子已经有棋子了")]
    CellOccupied,
    #[msg("格子位置必须是 0-8")]
    InvalidPosition,
    #[msg("你不是这局棋的玩家")]
    NotAPlayer,
    #[msg("对局数据自相矛盾")]
    InconsistentState,
    #[msg("对局还没结束，不能关闭账户")]
    GameInProgress,
}

/// 规则层错误 → 链上错误码。与服务端 error.rs 的映射一一对应，
/// 保证同一个规则违规在本地和链上拿到同一个语义。
impl From<RuleError> for NineGridError {
    fn from(err: RuleError) -> Self {
        match err {
            RuleError::NotStarted => Self::GameNotStarted,
            RuleError::GameOver => Self::GameAlreadyOver,
            RuleError::AlreadyStarted => Self::GameAlreadyFull,
            RuleError::NotYourTurn => Self::NotYourTurn,
            RuleError::CellOccupied => Self::CellOccupied,
            RuleError::OutOfRange | RuleError::InvalidCellCode => Self::InvalidPosition,
            RuleError::UnknownState | RuleError::InconsistentState => Self::InconsistentState,
        }
    }
}
