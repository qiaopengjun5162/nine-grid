//! # 九宫棋 · Nine Grid
//!
//! 一个跑在 Solana 上的双人井字棋（九宫棋）。阶段 1 目标：
//! 纯粹把「建局 → 加入 → 落子 → 判胜负 → 终局」这条闭环放到链上，
//! 不发代币、不下注。棋盘状态与胜负结果全部由链上程序裁决，
//! 任何人都能查到某局棋的原始棋谱。
//!
//! 设计要点：
//! - 一盘棋 = 一个 PDA 账户，地址由 `["game", 创建者, game_id]` 派生，
//!   所以对手只要拿到创建者地址 + game_id 就能定位到同一局，无需中心化服务器。
//! - 所有规则校验（轮次、占位、胜负）都在链上做，客户端改不了结果。
//! - 胜负判定固定 8 次三格比较，不做动态遍历，计算单元可预测。

use anchor_lang::prelude::*;

pub mod errors;
pub mod state;

use errors::NineGridError;
use nine_grid_core::{Game as Rules, Mark};
use state::{EMPTY, Game, GameState, MARK_O, timeout_elapsed};

declare_id!("AtRporBXQDCnT5ibxMic5joWwj2qJ6UpoBQgw5Yu4HD6");

/// PDA 前缀
pub const GAME_SEED: &[u8] = b"game";

#[program]
pub mod nine_grid {
    use super::*;

    /// 创建一局棋。创建者执 O 先手，并支付账户租金。
    ///
    /// `game_id` 由客户端随便给（时间戳之类），同一个创建者可以有无数局，
    /// 每局地址不同。
    pub fn create_game(ctx: Context<CreateGame>, game_id: u64) -> Result<()> {
        let game = &mut ctx.accounts.game;
        game.player_o = ctx.accounts.player_o.key();
        game.player_x = Pubkey::default();
        game.board = [EMPTY; 9];
        game.turn = MARK_O;
        game.state = GameState::WaitingForOpponent;
        game.game_id = game_id;
        game.moves = 0;
        game.last_activity_at = Clock::get()?.unix_timestamp;
        game.bump = ctx.bumps.game;

        emit!(GameCreated {
            game: game.key(),
            player_o: game.player_o,
            game_id,
        });
        Ok(())
    }

    /// 加入一局正在等人的棋，加入者执 X 后手。
    pub fn join_game(ctx: Context<JoinGame>) -> Result<()> {
        let game = &mut ctx.accounts.game;

        require!(
            game.state == GameState::WaitingForOpponent,
            NineGridError::GameAlreadyFull
        );
        require_keys_neq!(
            ctx.accounts.player_x.key(),
            game.player_o,
            NineGridError::CannotPlayYourself
        );

        game.player_x = ctx.accounts.player_x.key();
        game.state = GameState::InProgress;
        game.turn = MARK_O; // 创建者先手
        // 超时从「入座」开始算，而不是从建局算：建局后可能放很久才有人来
        game.last_activity_at = Clock::get()?.unix_timestamp;

        emit!(PlayerJoined {
            game: game.key(),
            player_x: game.player_x,
        });
        Ok(())
    }

    /// 在 `position`（0-8）落子。
    ///
    /// 身份校验（是不是参与者）是链特有的，留在合约里；
    /// 轮次、占位、越界、判胜、终局冻结全部交给 core 的 `Game::apply`——
    /// 与本地版服务端走的是同一段代码，不存在第二份规则。
    pub fn play(ctx: Context<Play>, position: u8) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let player = ctx.accounts.player.key();

        // 链特有的身份校验：钱包必须是这局的 O 或 X
        let mark = game.mark_of(&player).ok_or(NineGridError::NotAPlayer)?;
        let core_mark = Mark::from_code(i16::from(mark)).ok_or(NineGridError::InconsistentState)?;

        // 终局短路：认输与超时判负产生的终局**没有三连线**，
        // 直接送进 core 会被判成「棋盘与结果自相矛盾」（core 的校验本身是对的：
        // 它只认棋盘事实）。终局本来就该拒绝落子，所以先按账户状态挡掉。
        require!(!game.state.is_over(), NineGridError::GameAlreadyOver);

        // 账户 → 规则状态机（含一致性校验），落子，再算出的新状态写回账户
        let mut rules: Rules = game.to_rules().map_err(NineGridError::from)?;
        rules.apply(core_mark, position).map_err(NineGridError::from)?;
        game.apply_rules(&rules);
        // 每一手都续期，超时只针对「轮到你了却一直不动」
        game.last_activity_at = Clock::get()?.unix_timestamp;

        emit!(MovePlayed {
            game: game.key(),
            player,
            mark,
            position,
            state: game.state,
            next_turn: game.turn,
        });
        Ok(())
    }

    /// 认输：放弃这一局，对手获胜。
    ///
    /// 这是**协议动作**，不是棋盘规则 —— `nine_grid_core` 里没有也不该有「认输」，
    /// 因为它不改变任何一格棋子。所以这里直接改账户状态，不走 `Game::apply`。
    ///
    /// 为什么必须有它：A-01 之后「对局中谁都不能关账户」，一旦不想下了，
    /// 这局就永久卡在 `InProgress`，双方租金都拿不回来。
    /// 认输 → 终局 → 建局者可以关局退租金，闭环才完整。
    pub fn resign(ctx: Context<Resign>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let player = ctx.accounts.player.key();
        let mark = game.mark_of(&player).ok_or(NineGridError::NotAPlayer)?;
        ensure_in_progress(game.state)?;

        let (winner, next_state) = if mark == MARK_O {
            (game.player_x, state_when_resigned(mark))
        } else {
            (game.player_o, state_when_resigned(mark))
        };
        game.state = next_state;
        game.last_activity_at = Clock::get()?.unix_timestamp;

        emit!(PlayerResigned {
            game: game.key(),
            player,
            winner,
        });
        Ok(())
    }

    /// 超时判负：轮到对方落子，但对方超过 [`TIMEOUT_SECS`] 没有任何动作，判自己胜。
    ///
    /// 只能由**等着的那一方**发起：轮到自己时不能拿超时判胜（那是耍赖），
    /// 想结束请用 `resign`。判罚只依据链上时钟与账户里的最后活动时间，
    /// 不依赖任何链下服务 —— 对手关掉浏览器也躲不过。
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let player = ctx.accounts.player.key();
        let mark = game.mark_of(&player).ok_or(NineGridError::NotAPlayer)?;
        ensure_in_progress(game.state)?;

        // 轮到自己时不能判对方超时
        require!(
            mark != game.turn,
            NineGridError::OnlyOpponentCanClaimTimeout
        );

        let now = Clock::get()?.unix_timestamp;
        require!(
            timeout_elapsed(now, game.last_activity_at),
            NineGridError::TimeoutNotReached
        );
        let idle_secs = now.saturating_sub(game.last_activity_at);

        game.state = state_when_claimer_wins(mark);
        game.last_activity_at = now;

        emit!(TimeoutClaimed {
            game: game.key(),
            claimer: player,
            idle_secs,
        });
        Ok(())
    }

    /// 收尾：关掉账户，把租金退还给创建者。
    ///
    /// 只有创建者能关自己付过租金的棋局。注意这一步会让该局棋彻底消失，
    /// 想留作「链上棋谱」的话就别调它。
    ///
    /// **对局中不许关**（`state == InProgress`）。账户就是这盘棋唯一的记录，
    /// 允许单方关闭等于允许「快输了就掀桌」—— 对手的落子、胜负、棋谱会一起消失，
    /// 而且没有任何反制手段。等待入座允许关（建错了能撤回），终局后允许关
    /// （退租金），只锁住双方都在局中的那段时间。
    pub fn close_game(_ctx: Context<CloseGame>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CreateGame<'info> {
    #[account(
        init,
        payer = player_o,
        space = 8 + Game::INIT_SPACE,
        seeds = [GAME_SEED, player_o.key().as_ref(), &game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,
    #[account(mut)]
    pub player_o: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinGame<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
    pub player_x: Signer<'info>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct Resign<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
    pub player: Signer<'info>,
}

/// 只有「双方都在局中」才谈得上认输或超时；
/// 等人入座请用 close_game 撤回，已终局则无需再结束一次。
fn ensure_in_progress(state: GameState) -> Result<()> {
    match in_progress_error(state) {
        None => Ok(()),
        Some(err) => Err(err.into()),
    }
}

/// 状态检查的纯逻辑部分，抽出来是为了能在单测里覆盖全部分支
#[must_use]
fn in_progress_error(state: GameState) -> Option<NineGridError> {
    match state {
        GameState::InProgress => None,
        GameState::WaitingForOpponent => Some(NineGridError::GameNotStarted),
        GameState::OWon | GameState::XWon | GameState::Draw => Some(NineGridError::GameAlreadyOver),
    }
}

/// 执 `mark` 的一方认输 → 终局状态（对手获胜）
#[must_use]
const fn state_when_resigned(mark: u8) -> GameState {
    if mark == MARK_O {
        GameState::XWon
    } else {
        GameState::OWon
    }
}

/// 执 `mark` 的一方超时判胜 → 终局状态（自己获胜）
#[must_use]
const fn state_when_claimer_wins(mark: u8) -> GameState {
    if mark == MARK_O {
        GameState::OWon
    } else {
        GameState::XWon
    }
}

#[derive(Accounts)]
pub struct CloseGame<'info> {
    // 先对齐 `has_one` 再判状态：拿别人的局来试，会得到「不是你的局」而不是状态错误，
    // 不泄露对局是否进行中。
    #[account(
        mut,
        has_one = player_o,
        close = player_o,
        constraint = !game.state.is_in_progress() @ NineGridError::GameInProgress
    )]
    pub game: Account<'info, Game>,
    #[account(mut)]
    pub player_o: Signer<'info>,
}

#[event]
pub struct GameCreated {
    pub game: Pubkey,
    pub player_o: Pubkey,
    pub game_id: u64,
}

#[event]
pub struct PlayerJoined {
    pub game: Pubkey,
    pub player_x: Pubkey,
}

#[event]
pub struct MovePlayed {
    pub game: Pubkey,
    pub player: Pubkey,
    pub mark: u8,
    pub position: u8,
    pub state: GameState,
    pub next_turn: u8,
}

#[event]
pub struct PlayerResigned {
    pub game: Pubkey,
    pub player: Pubkey,
    pub winner: Pubkey,
}

#[event]
pub struct TimeoutClaimed {
    pub game: Pubkey,
    pub claimer: Pubkey,
    /// 对方实际多久没动（秒），用于前端/浏览器核对判罚是否合理
    pub idle_secs: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use state::MARK_X;

    /// 认输永远是「对手赢」，不能反过来
    #[test]
    fn resign_hands_the_win_to_the_opponent() {
        assert!(matches!(state_when_resigned(MARK_O), GameState::XWon));
        assert!(matches!(state_when_resigned(MARK_X), GameState::OWon));
    }

    /// 超时判负永远是「发起方赢」
    #[test]
    fn timeout_claim_hands_the_win_to_the_claimer() {
        assert!(matches!(state_when_claimer_wins(MARK_O), GameState::OWon));
        assert!(matches!(state_when_claimer_wins(MARK_X), GameState::XWon));
    }

    /// 只有 InProgress 才允许认输/超时，其余三种状态各有明确错误码
    #[test]
    fn only_in_progress_games_can_be_ended_by_protocol() {
        assert!(in_progress_error(GameState::InProgress).is_none());
        assert!(matches!(
            in_progress_error(GameState::WaitingForOpponent),
            Some(NineGridError::GameNotStarted)
        ));
        for state in [GameState::OWon, GameState::XWon, GameState::Draw] {
            assert!(
                matches!(
                    in_progress_error(state),
                    Some(NineGridError::GameAlreadyOver)
                ),
                "{state:?} 应报 GameAlreadyOver"
            );
        }
    }
}
