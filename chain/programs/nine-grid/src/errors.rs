use anchor_lang::prelude::*;

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
}
