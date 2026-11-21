use nine_grid_bot::Difficulty;
use nine_grid_core::{FIRST_MARK, Game, GameState, Mark};
use rand::Rng;
use serde::Serialize;
use sqlx::{
    PgConnection, PgPool, Postgres, Row,
    postgres::{PgPoolOptions, PgRow},
};
use uuid::Uuid;

use crate::error::AppError;

/// 房间码字母表：去掉 I / L / O / 0 / 1，避免手输时看错
const ROOM_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_LEN: usize = 6;

/// 机器人的固定身份。
///
/// 它就是一个普通的 `players` 行 —— 这是有意的：机器人**不是特权角色**，
/// 它的落子同样要走规则校验、同样写进棋谱、同样占用一个座位。
/// 将来换成真人对手或链上地址，这一列代码不用动。
pub const BOT_ID: Uuid = Uuid::from_u128(0xb070);
const BOT_HANDLE: &str = "机器人";

/// 连接数据库并把 migrations 全部应用一遍
pub async fn connect(database_url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new().max_connections(8).connect(database_url).await?;
    sqlx::migrate!("../../migrations").run(&pool).await?;
    Ok(pool)
}

#[derive(Debug, Clone, Serialize)]
pub struct Seat {
    pub id: Uuid,
    pub handle: Option<String>,
    /// 这个座位是不是机器人。前端据此显示名字、隐藏「邀请对手」之类的入口。
    pub is_bot: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Seats {
    pub o: Option<Seat>,
    pub x: Option<Seat>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveView {
    pub ply: i16,
    pub mark: Mark,
    pub position: u8,
}

/// 返回给前端的完整快照。
///
/// 注意 `board` 是**算出来的**，不是存出来的 —— 它来自 `moves` 的重放结果。
#[derive(Debug, Clone, Serialize)]
pub struct GameSnapshot {
    pub code: String,
    pub state: GameState,
    pub turn: Mark,
    pub board: [Option<Mark>; 9],
    pub plies: u8,
    pub version: i64,
    pub winner: Option<Mark>,
    pub players: Seats,
    pub moves: Vec<MoveView>,
    /// 机器人难度（只有 X 座位是机器人时有意义，前端据此显示档位）
    pub bot_difficulty: Difficulty,
}

impl GameSnapshot {
    /// 某个玩家在这局里执什么子
    pub fn mark_of(&self, player_id: Uuid) -> Option<Mark> {
        if self.players.o.as_ref().is_some_and(|seat| seat.id == player_id) {
            Some(Mark::O)
        } else if self.players.x.as_ref().is_some_and(|seat| seat.id == player_id) {
            Some(Mark::X)
        } else {
            None
        }
    }
}

#[derive(Debug)]
struct GameRow {
    id: Uuid,
    state: GameState,
    version: i64,
    bot_difficulty: Difficulty,
}

/// 建局：创建者执 O 先手，等待对手加入
pub async fn create_game(
    pool: &PgPool,
    player_id: Uuid,
    handle: Option<&str>,
) -> Result<GameSnapshot, AppError> {
    upsert_player(pool, player_id, handle).await?;

    // 房间码冲突概率极低，但仍然要处理；重试 8 次仍冲突就报错
    for _ in 0..8 {
        let code = random_room_code();
        let id = Uuid::new_v4();

        let mut tx = pool.begin().await?;
        let inserted = sqlx::query(
            "insert into games (id, code, state, turn) values ($1, $2, $3, $4)
             on conflict (code) do nothing",
        )
        .bind(id)
        .bind(&code)
        .bind(GameState::Waiting.as_str())
        .bind(FIRST_MARK.code())
        .execute(&mut *tx)
        .await?;

        if inserted.rows_affected() == 0 {
            continue;
        }

        sqlx::query("insert into game_players (game_id, player_id, mark) values ($1, $2, $3)")
            .bind(id)
            .bind(player_id)
            .bind(FIRST_MARK.code())
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        return snapshot(pool, &code).await;
    }

    Err(AppError::Internal("房间号分配失败，请重试".to_owned()))
}

/// 加入一局正在等人的棋，加入者执 X
pub async fn join_game(
    pool: &PgPool,
    code: &str,
    player_id: Uuid,
    handle: Option<&str>,
) -> Result<GameSnapshot, AppError> {
    upsert_player(pool, player_id, handle).await?;

    let mut tx = pool.begin().await?;

    // FOR UPDATE 就是本地版的"账户锁"：同一局的并发请求会被串行化
    let game = lock_game(&mut tx, code).await?;

    if game.state != GameState::Waiting {
        return Err(AppError::conflict("game_full", "这一局已经有对手了"));
    }
    if seat_mark(&mut tx, game.id, player_id).await?.is_some() {
        return Err(AppError::conflict(
            "cannot_play_yourself",
            "这是你自己建的房间，等对手来吧",
        ));
    }

    sqlx::query("insert into game_players (game_id, player_id, mark) values ($1, $2, $3)")
        .bind(game.id)
        .bind(player_id)
        .bind(Mark::X.code())
        .execute(&mut *tx)
        .await?;

    // X 落座即开局（不产生落子，所以棋谱里看不出来 —— 重放时要靠库里的 state 补这个信息）
    sqlx::query(
        "update games
            set state = $2, turn = $3, version = version + 1, updated_at = now()
          where id = $1",
    )
    .bind(game.id)
    .bind(GameState::InProgress.as_str())
    .bind(FIRST_MARK.code())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    snapshot(pool, code).await
}

/// 让机器人坐进 X 座位。只有建局者（O 方）能邀请。
///
/// 走的是和真人加入完全相同的路径：占用同一个座位、让对局进入进行中。
/// 难度写在这一局上，之后机器人的每一次应招都按它走 —— 中途不能改，
/// 否则同一盘棋里机器人忽强忽弱，棋谱就没法解释了。
pub async fn seat_bot(
    pool: &PgPool,
    code: &str,
    caller: Uuid,
    difficulty: Difficulty,
) -> Result<GameSnapshot, AppError> {
    let mut tx = pool.begin().await?;
    let game = lock_game(&mut tx, code).await?;

    // 只有建局者（O 方）能邀请机器人。
    // 先判身份再判状态：别人房间里的状态对你来说无关紧要，直接说"你没这个权限"更清楚。
    if seat_mark(&mut tx, game.id, caller).await? != Some(FIRST_MARK) {
        return Err(AppError::forbidden("not_host", "只有建局者能邀请机器人"));
    }
    if game.state != GameState::Waiting {
        return Err(AppError::conflict("game_full", "这一局已经开始了"));
    }

    upsert_player(&mut *tx, BOT_ID, Some(BOT_HANDLE)).await?;

    sqlx::query("insert into game_players (game_id, player_id, mark) values ($1, $2, $3)")
        .bind(game.id)
        .bind(BOT_ID)
        .bind(Mark::X.code())
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "update games
            set state = $2, turn = $3, bot_difficulty = $4,
                version = version + 1, updated_at = now()
          where id = $1",
    )
    .bind(game.id)
    .bind(GameState::InProgress.as_str())
    .bind(FIRST_MARK.code())
    .bind(difficulty.as_str())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    snapshot(pool, code).await
}

/// 落子。规则裁决全部交给 `nine_grid_core`，数据库只负责存取。
pub async fn play(
    pool: &PgPool,
    code: &str,
    player_id: Uuid,
    position: u8,
    expected_version: Option<i64>,
) -> Result<GameSnapshot, AppError> {
    let mut tx = pool.begin().await?;
    let game_row = lock_game(&mut tx, code).await?;

    if let Some(expected) = expected_version
        && expected != game_row.version
    {
        return Err(AppError::conflict(
            "stale_version",
            "有人抢先走了一步，刷新后重试",
        ));
    }

    let moves = load_moves(&mut *tx, game_row.id).await?;
    let sequence: Vec<(Mark, u8)> = moves.iter().map(|m| (m.mark, m.position)).collect();
    let started = game_row.state != GameState::Waiting;
    let mut game = Game::replay_with(&sequence, started).map_err(AppError::from_rule)?;

    let mark = seat_mark(&mut tx, game_row.id, player_id)
        .await?
        .ok_or_else(|| AppError::forbidden("not_a_player", "你不是这局棋的玩家"))?;

    record_move(&mut tx, game_row.id, &mut game, mark, position, player_id).await?;

    // 机器人在**同一个事务**里应招。
    //
    // 为什么不丢到后台任务：同步走完只有一种可观察状态，不会出现
    // "人类下完、机器人还没动"的中间态被人读到，也就不需要额外的状态字段
    // 来表达"正在思考"。代价是这一步多花不到 1 毫秒（见 bot crate 的测试耗时）。
    let bot_mark = seat_mark(&mut tx, game_row.id, BOT_ID).await?;
    if let Some(bot_mark) = bot_mark
        && !game.is_over()
        && game.turn() == bot_mark
        && let Some(reply) = nine_grid_bot::choose_move_with(&game, game_row.bot_difficulty)
    {
        record_move(&mut tx, game_row.id, &mut game, bot_mark, reply, BOT_ID).await?;
    }

    tx.commit().await?;
    snapshot(pool, code).await
}

/// 落一步棋：先过规则校验，再把 `moves` 与 `games` 一起推进。
///
/// 两个写操作必须在同一个事务里 —— 只写棋谱不更新状态，会让下一次重放错位。
async fn record_move(
    tx: &mut PgConnection,
    game_id: Uuid,
    game: &mut Game,
    mark: Mark,
    position: u8,
    player_id: Uuid,
) -> Result<(), AppError> {
    game.apply(mark, position).map_err(AppError::from_rule)?;
    let ply = i16::from(game.plies());

    sqlx::query(
        "insert into moves (game_id, ply, mark, position, player_id) values ($1, $2, $3, $4, $5)",
    )
    .bind(game_id)
    .bind(ply)
    .bind(mark.code())
    .bind(i16::from(position))
    .bind(player_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "update games
            set state = $2, turn = $3, plies = $4, version = version + 1, updated_at = now()
          where id = $1",
    )
    .bind(game_id)
    .bind(game.state().as_str())
    .bind(game.turn().code())
    .bind(ply)
    .execute(&mut *tx)
    .await?;

    Ok(())
}

/// 战绩榜里的一行。只统计真人对真人的终局对局。
#[derive(Debug, Clone, Serialize)]
pub struct LeaderboardEntry {
    pub player_id: Uuid,
    pub handle: Option<String>,
    pub played: i64,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
    /// 胜率，0.0–1.0；前端自己乘 100 显示
    pub win_rate: f64,
}

/// 战绩榜：只统计真人对真人的终局对局。
///
/// 为什么排除人机局：否则挂个简单机器人刷一百局就能霸榜，数字就失去意义了。
/// 判定"人机局"的办法是看这局有没有机器人座位（player_id = BOT_ID）——
/// 不用加字段，机器人身份本来就是一个普通 players 行。
pub async fn leaderboard(pool: &PgPool) -> Result<Vec<LeaderboardEntry>, AppError> {
    let rows = sqlx::query(
        "with human_games as (
            select g.id, g.state
              from games g
             where g.state in ('o_won', 'x_won', 'draw')
               -- 两个座位都不是机器人
               and not exists (
                    select 1 from game_players gp
                     where gp.game_id = g.id and gp.player_id = $1
               )
         ),
         per_player as (
            select gp.player_id,
                   p.handle,
                   case
                     when hg.state = 'draw' then 'draw'
                     when (hg.state = 'o_won' and gp.mark = 1)
                       or (hg.state = 'x_won' and gp.mark = 2) then 'win'
                     else 'loss'
                   end as result
              from human_games hg
              join game_players gp on gp.game_id = hg.id
              join players p on p.id = gp.player_id
         )
         select player_id,
                max(handle) as handle,
                count(*)::bigint as played,
                count(*) filter (where result = 'win')::bigint as wins,
                count(*) filter (where result = 'loss')::bigint as losses,
                count(*) filter (where result = 'draw')::bigint as draws
           from per_player
          group by player_id
          order by wins desc, draws desc, played desc
          limit 50",
    )
    .bind(BOT_ID)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .iter()
        .map(|row| {
            let played: i64 = row.try_get("played")?;
            let wins: i64 = row.try_get("wins")?;
            Ok(LeaderboardEntry {
                player_id: row.try_get("player_id")?,
                handle: row.try_get("handle")?,
                played,
                wins,
                losses: row.try_get("losses")?,
                draws: row.try_get("draws")?,
                win_rate: if played > 0 {
                    wins as f64 / played as f64
                } else {
                    0.0
                },
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?)
}

/// 读一局的完整快照（棋盘由棋谱重放得出）
pub async fn snapshot(pool: &PgPool, code: &str) -> Result<GameSnapshot, AppError> {
    let row = sqlx::query("select * from games where code = $1")
        .bind(code)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)?;
    let game_row = row_to_game(&row)?;

    let moves = load_moves(pool, game_row.id).await?;
    let sequence: Vec<(Mark, u8)> = moves.iter().map(|m| (m.mark, m.position)).collect();
    let started = game_row.state != GameState::Waiting;
    let rules = Game::replay_with(&sequence, started)
        .map_err(|err| AppError::Internal(format!("棋谱重放失败: {err}")))?;

    if rules.state() != game_row.state {
        tracing::warn!(
            code,
            db_state = %game_row.state,
            replay_state = %rules.state(),
            "数据库状态与棋谱重放结果不一致，以棋谱为准"
        );
    }

    Ok(GameSnapshot {
        code: code.to_owned(),
        state: rules.state(),
        turn: rules.turn(),
        board: *rules.board().cells(),
        plies: rules.plies(),
        version: game_row.version,
        winner: nine_grid_core::winner_mark(rules.state()),
        players: load_seats(pool, game_row.id).await?,
        moves,
        bot_difficulty: game_row.bot_difficulty,
    })
}

fn random_room_code() -> String {
    let mut rng = rand::thread_rng();
    (0..ROOM_LEN)
        .map(|_| char::from(ROOM_ALPHABET[rng.gen_range(0..ROOM_ALPHABET.len())]))
        .collect()
}

async fn upsert_player<'e, E>(
    executor: E,
    player_id: Uuid,
    handle: Option<&str>,
) -> Result<(), AppError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query(
        "insert into players (id, handle) values ($1, $2)
         on conflict (id) do update set handle = coalesce(excluded.handle, players.handle)",
    )
    .bind(player_id)
    .bind(handle)
    .execute(executor)
    .await?;
    Ok(())
}

async fn lock_game(tx: &mut PgConnection, code: &str) -> Result<GameRow, AppError> {
    let row = sqlx::query("select * from games where code = $1 for update")
        .bind(code)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound)?;
    row_to_game(&row)
}

async fn load_moves<'e, E>(executor: E, game_id: Uuid) -> Result<Vec<MoveView>, AppError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let rows = sqlx::query("select ply, mark, position from moves where game_id = $1 order by ply")
        .bind(game_id)
        .fetch_all(executor)
        .await?;

    rows.iter()
        .map(|row| {
            let mark_code: i16 = row.try_get("mark")?;
            let position: i16 = row.try_get("position")?;
            let mark = Mark::from_code(mark_code)
                .ok_or_else(|| AppError::Internal(format!("非法的棋子编码 {mark_code}")))?;
            Ok(MoveView {
                ply: row.try_get("ply")?,
                mark,
                position: u8::try_from(position)
                    .map_err(|_| AppError::Internal(format!("非法的格子编号 {position}")))?,
            })
        })
        .collect()
}

async fn load_seats<'e, E>(executor: E, game_id: Uuid) -> Result<Seats, AppError>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let rows = sqlx::query(
        "select gp.mark, p.id, p.handle
           from game_players gp
           join players p on p.id = gp.player_id
          where gp.game_id = $1",
    )
    .bind(game_id)
    .fetch_all(executor)
    .await?;

    let mut seats = Seats { o: None, x: None };
    for row in &rows {
        let mark_code: i16 = row.try_get("mark")?;
        let id: Uuid = row.try_get("id")?;
        let seat = Seat {
            id,
            handle: row.try_get("handle")?,
            is_bot: id == BOT_ID,
        };
        match Mark::from_code(mark_code) {
            Some(Mark::O) => seats.o = Some(seat),
            Some(Mark::X) => seats.x = Some(seat),
            None => return Err(AppError::Internal(format!("非法的座位编码 {mark_code}"))),
        }
    }
    Ok(seats)
}

async fn seat_mark(
    tx: &mut PgConnection,
    game_id: Uuid,
    player_id: Uuid,
) -> Result<Option<Mark>, AppError> {
    let code: Option<i16> =
        sqlx::query_scalar("select mark from game_players where game_id = $1 and player_id = $2")
            .bind(game_id)
            .bind(player_id)
            .fetch_optional(&mut *tx)
            .await?;

    code.map(|value| {
        Mark::from_code(value).ok_or_else(|| AppError::Internal(format!("非法的座位编码 {value}")))
    })
    .transpose()
}

fn row_to_game(row: &PgRow) -> Result<GameRow, AppError> {
    let state_text: String = row.try_get("state")?;
    let state = state_text
        .parse::<GameState>()
        .map_err(|_| AppError::Internal(format!("数据库里存在未知状态 {state_text}")))?;
    let difficulty_text: String = row.try_get("bot_difficulty")?;
    let bot_difficulty = difficulty_text
        .parse::<Difficulty>()
        .map_err(|err| AppError::Internal(format!("数据库里存在未知机器人难度: {err}")))?;
    Ok(GameRow {
        id: row.try_get("id")?,
        state,
        version: row.try_get("version")?,
        bot_difficulty,
    })
}
