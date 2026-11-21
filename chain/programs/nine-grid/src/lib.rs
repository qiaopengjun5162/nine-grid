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
use state::{EMPTY, Game, GameState, MARK_O};

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
        game.created_at = Clock::get()?.unix_timestamp;
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

        // 账户 → 规则状态机（含一致性校验），落子，再算出的新状态写回账户
        let mut rules: Rules = game.to_rules().map_err(NineGridError::from)?;
        rules.apply(core_mark, position).map_err(NineGridError::from)?;
        game.apply_rules(&rules);

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

    /// 收尾：关掉账户，把租金退还给创建者。
    ///
    /// 只有创建者能关自己付过租金的棋局。注意这一步会让该局棋彻底消失，
    /// 想留作「链上棋谱」的话就别调它。
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
pub struct CloseGame<'info> {
    #[account(mut, has_one = player_o, close = player_o)]
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
