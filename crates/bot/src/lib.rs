//! 九宫棋机器人。
//!
//! 它只依赖 [`nine_grid_core`]，**不复制任何规则**：
//! 每一步都通过 `Game::after()` 向规则层要"如果下在这里会怎样"。
//! 这样即使以后改判胜逻辑（比如加上禁手），机器人也会自动跟着变。
//!
//! 定位：它是**另一个玩家**，不是规则的一部分。
//! 服务端把它当成一个坐进 X 座位的普通对手，落子一样要过 `apply()` 的校验。

use nine_grid_core::{Game, GameState, Mark, winner_mark};

/// 胜负分值基数。必须远大于最大手数（9），保证"任何胜利"都强于"平局"，
/// "任何失败"都劣于"平局"。在这个前提下再去调整「早赢 / 晚输」。
const WIN: i32 = 100;

/// 给某个局面估值。只在终局调用。
///
/// - 自己赢：`WIN - plies`，同样赢，越早赢分越高；
/// - 自己输：`plies - WIN`，同样输，拖得越久分越高；
/// - 平局：0。
fn evaluate(game: &Game, me: Mark) -> i32 {
    match winner_mark(game.state()) {
        Some(winner) if winner == me => WIN - i32::from(game.plies()),
        Some(_) => i32::from(game.plies()) - WIN,
        None => 0,
    }
}

/// 相等分值时的偏好：中心 > 四角 > 四边。
///
/// 这只影响"怎么走都赢"时的手感（先占中间更像人），不参与胜负判断。
const fn tie_break_weight(position: usize) -> u8 {
    match position {
        4 => 2,
        0 | 2 | 6 | 8 => 1,
        _ => 0,
    }
}

/// 枚举所有还空着的格子，按偏好排序（先试中心，剪枝更早生效）
fn legal_moves(game: &Game) -> Vec<u8> {
    let mut moves: Vec<u8> = (0..nine_grid_core::CELLS)
        .filter(|&index| game.board().is_empty_at(index))
        .map(|index| u8::try_from(index).expect("棋盘只有 9 格"))
        .collect();
    moves.sort_by_key(|&position| std::cmp::Reverse(tie_break_weight(usize::from(position))));
    moves
}

/// 带 alpha-beta 剪枝的极小化极大搜索。
///
/// 井字棋的全部状态不到 55 万个节点，剪枝之后实际访问量在千级，
/// 所以不需要置换表 / 记忆化，保持简单更重要。
fn search(game: &Game, me: Mark, mut alpha: i32, mut beta: i32) -> i32 {
    if game.is_over() {
        return evaluate(game, me);
    }

    let turn = game.turn();
    if turn == me {
        let mut best = i32::MIN;
        for position in legal_moves(game) {
            let Ok(next) = game.after(turn, position) else {
                continue;
            };
            best = best.max(search(&next, me, alpha, beta));
            alpha = alpha.max(best);
            if alpha >= beta {
                break;
            }
        }
        best
    } else {
        let mut best = i32::MAX;
        for position in legal_moves(game) {
            let Ok(next) = game.after(turn, position) else {
                continue;
            };
            best = best.min(search(&next, me, alpha, beta));
            beta = beta.min(best);
            if alpha >= beta {
                break;
            }
        }
        best
    }
}

/// 给当前该落子的一方选一步。返回格子编号。
///
/// 返回 `None` 的三种情况：对局已结束、还在等人加入、棋盘已满。
#[must_use]
pub fn choose_move(game: &Game) -> Option<u8> {
    if game.state() != GameState::InProgress {
        return None;
    }

    let me = game.turn();
    let mut best: Option<(i32, u8)> = None;

    for position in legal_moves(game) {
        let Ok(next) = game.after(me, position) else {
            continue;
        };
        let score = search(&next, me, i32::MIN, i32::MAX);

        // 分数更高就换；分数相同时用"更靠近中心"的那一步
        let better = match best {
            None => true,
            Some((best_score, best_position)) => {
                score > best_score
                    || (score == best_score
                        && tie_break_weight(usize::from(position))
                            > tie_break_weight(usize::from(best_position)))
            }
        };
        if better {
            best = Some((score, position));
        }
    }

    best.map(|(_, position)| position)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nine_grid_core::RuleError;

    /// 按给定顺序摆出一个局面（O 先手，所以序列必须 O/X 交替）
    fn game_from(moves: &[(Mark, u8)]) -> Game {
        let mut game = Game::waiting();
        game.start().expect("开局");
        for &(mark, position) in moves {
            game.apply(mark, position).expect("测试用例里的落子必须合法");
        }
        game
    }

    #[test]
    fn takes_the_immediate_win() {
        // O: 0,1 → 差一个 2 就三连；X 在别处
        let game = game_from(&[(Mark::O, 0), (Mark::X, 4), (Mark::O, 1), (Mark::X, 8)]);
        assert_eq!(choose_move(&game), Some(2));
    }

    #[test]
    fn blocks_the_immediate_loss() {
        // X: 0,2 威胁 1；O 只有 4,8，没有别的杀招 → 只能挡 1
        let game = game_from(&[(Mark::O, 4), (Mark::X, 0), (Mark::O, 8), (Mark::X, 2)]);
        assert_eq!(game.turn(), Mark::O);
        assert_eq!(choose_move(&game), Some(1));
    }

    #[test]
    fn opens_in_the_middle() {
        let game = game_from(&[]);
        assert_eq!(choose_move(&game), Some(4), "空盘应该先占中心");
    }

    #[test]
    fn returns_none_when_there_is_nothing_to_do() {
        // 还没人加入
        assert_eq!(choose_move(&Game::waiting()), None);

        // 已经终局
        let won =
            game_from(&[(Mark::O, 0), (Mark::X, 3), (Mark::O, 1), (Mark::X, 4), (Mark::O, 2)]);
        assert_eq!(won.state(), GameState::OWon);
        assert_eq!(choose_move(&won), None);
    }

    #[test]
    fn perfect_play_against_itself_is_a_draw() {
        let mut game = Game::waiting();
        game.start().unwrap();

        while !game.is_over() {
            let position = choose_move(&game).expect("进行中必须有棋可下");
            let mark = game.turn();
            game.apply(mark, position).expect("机器人只能走合法棋");
        }

        assert_eq!(
            game.state(),
            GameState::Draw,
            "两个完美玩家对下，井字棋只能平局，实际棋谱: {:?}",
            game.board().cells()
        );
    }

    #[test]
    fn never_loses_against_random_play() {
        // 不引入随机数依赖：自己实现一个 32 位 LCG 当对手
        let mut seed: u32 = 0x5eed_1234;

        for _ in 0..200 {
            let mut game = Game::waiting();
            game.start().unwrap();

            while !game.is_over() {
                let position = if game.turn() == Mark::O {
                    // 机器人执 O：每一步都由它算
                    choose_move(&game).expect("进行中必须有棋可下")
                } else {
                    // X 乱下：从空格里挑一个
                    let empty: Vec<u8> = (0..9_u8)
                        .filter(|&index| game.board().is_empty_at(usize::from(index)))
                        .collect();
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    empty[usize::from((seed >> 16) as u16) % empty.len()]
                };
                let mark = game.turn();
                game.apply(mark, position).expect("只能走合法棋");
            }

            assert_ne!(
                game.state(),
                GameState::XWon,
                "完美机器人不该输给乱下的对手，棋谱: {:?}",
                game.board().cells()
            );
        }
    }

    #[test]
    fn every_suggestion_is_legal() {
        // 从开局一路让机器人下到底：每一步的返回值都必须真的能落子
        for _ in 0..50 {
            let mut game = Game::waiting();
            game.start().unwrap();

            while !game.is_over() {
                let position = choose_move(&game).expect("进行中必须有棋可下");
                assert!(
                    game.board().is_empty_at(usize::from(position)),
                    "建议了已经有棋子的格子 {position}"
                );
                assert!(
                    game.after(game.turn(), position).is_ok(),
                    "建议了规则不允许的一步 {position}"
                );

                let mark = game.turn();
                game.apply(mark, position).unwrap();
            }
        }
    }

    #[test]
    fn losing_rejects_are_surfaced_by_the_rules_layer() {
        // 机器人本身不做校验，全靠 core 兜底：给它一个越界位置也只能报错
        let game = game_from(&[]);
        assert_eq!(game.after(Mark::O, 42), Err(RuleError::OutOfRange));
    }

    #[test]
    fn evaluation_orders_win_over_draw_over_loss() {
        // 构造三种终局，确认 WIN 基数足够大，手数调整不会翻转结论
        let win =
            game_from(&[(Mark::O, 0), (Mark::X, 3), (Mark::O, 1), (Mark::X, 4), (Mark::O, 2)]);
        let draw = game_from(&[
            (Mark::O, 0),
            (Mark::X, 1),
            (Mark::O, 2),
            (Mark::X, 4),
            (Mark::O, 3),
            (Mark::X, 5),
            (Mark::O, 7),
            (Mark::X, 6),
            (Mark::O, 8),
        ]);

        assert_eq!(draw.state(), GameState::Draw);
        assert!(evaluate(&win, Mark::O) > 0);
        assert_eq!(evaluate(&draw, Mark::O), 0);
        assert!(evaluate(&win, Mark::X) < 0);
        // 最长的一局（9 手）里输掉，也要比任何平局都差
        assert!(evaluate(&draw, Mark::O) > evaluate(&win, Mark::X));
    }
}
