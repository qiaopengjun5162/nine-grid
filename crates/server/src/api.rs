use std::{convert::Infallible, path::PathBuf, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::sse::{Event, Sse},
    routing::{get, post},
};
use futures_util::Stream;
use nine_grid_bot::Difficulty;
use nine_grid_core::Mark;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::broadcast;
use tower_http::services::ServeDir;
use uuid::Uuid;

use crate::{
    db::{self, GameSnapshot},
    error::AppError,
    events::{AppState, GameEvent},
};

/// 路由表：玩法接口 + 观战 SSE + 战绩榜 + 健康检查，其余全部交给静态文件
pub fn router(state: AppState, static_dir: PathBuf) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/games", post(create_game))
        .route("/api/games/{code}", get(get_game))
        .route("/api/games/{code}/join", post(join_game))
        .route("/api/games/{code}/bot", post(seat_bot))
        .route("/api/games/{code}/moves", post(play_move))
        .route("/api/games/{code}/replay", get(replay))
        .route("/api/games/{code}/events", get(game_events))
        .route("/api/leaderboard", get(leaderboard))
        .fallback_service(ServeDir::new(static_dir).append_index_html_on_directories(true))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct CreateGameRequest {
    player_id: Uuid,
    handle: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JoinGameRequest {
    player_id: Uuid,
    handle: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SeatBotRequest {
    /// 只用来算"你是谁"，并校验你是建局者
    player_id: Uuid,
    /// 机器人难度；缺省为 hard，兼容老的前端调用
    #[serde(default)]
    difficulty: Difficulty,
    /// 这个座位的凭证；缺省时数据库会给出「缺少座位凭证」
    seat_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlayRequest {
    player_id: Uuid,
    position: u8,
    /// 客户端上次看到的版本号；带上它就能避免"抢先后落子"
    version: Option<i64>,
    /// 建局 / 入座时签发的那张凭证
    seat_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ViewQuery {
    player_id: Option<Uuid>,
}

/// 在快照外层补一个 `you` 字段，前端就不用自己算自己执什么子
#[derive(Debug, Serialize)]
struct GameView {
    you: Option<Mark>,
    /// 只在建局 / 入座时出现一次；之后由前端自己保存，丢了就只能重开一局
    #[serde(skip_serializing_if = "Option::is_none")]
    seat_token: Option<String>,
    #[serde(flatten)]
    game: GameSnapshot,
}

#[derive(Debug, Serialize)]
struct ReplayView {
    code: String,
    state: &'static str,
    moves: Vec<db::MoveView>,
}

async fn healthz(State(app): State<AppState>) -> Result<Json<Value>, AppError> {
    sqlx::query("select 1").execute(&app.pool).await?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn create_game(
    State(app): State<AppState>,
    Json(req): Json<CreateGameRequest>,
) -> Result<(StatusCode, Json<GameView>), AppError> {
    let (game, seat_token) =
        db::create_game(&app.pool, req.player_id, req.handle.as_deref()).await?;
    let you = game.mark_of(req.player_id);
    Ok((
        StatusCode::CREATED,
        Json(GameView {
            you,
            seat_token: Some(seat_token),
            game,
        }),
    ))
}

async fn join_game(
    State(app): State<AppState>,
    Path(code): Path<String>,
    Json(req): Json<JoinGameRequest>,
) -> Result<Json<GameView>, AppError> {
    let code = normalize_code(&code)?;
    let (game, seat_token) =
        db::join_game(&app.pool, &code, req.player_id, req.handle.as_deref()).await?;
    publish_move(&app, &game);
    let you = game.mark_of(req.player_id);
    Ok(Json(GameView {
        you,
        seat_token: Some(seat_token),
        game,
    }))
}

/// 建局者邀请机器人坐进对面的座位。
///
/// 机器人不是"内置模式"，而是一个占座位的普通玩家 —— 之后所有落子都走
/// `/moves` 同一条规则路径，所以它对局也会留下完整的棋谱。
async fn seat_bot(
    State(app): State<AppState>,
    Path(code): Path<String>,
    Json(req): Json<SeatBotRequest>,
) -> Result<Json<GameView>, AppError> {
    let code = normalize_code(&code)?;
    let game = db::seat_bot(
        &app.pool,
        &code,
        req.player_id,
        req.difficulty,
        req.seat_token.as_deref(),
    )
    .await?;
    publish_move(&app, &game);
    let you = game.mark_of(req.player_id);
    Ok(Json(GameView {
        you,
        seat_token: None,
        game,
    }))
}

async fn get_game(
    State(app): State<AppState>,
    Path(code): Path<String>,
    Query(query): Query<ViewQuery>,
) -> Result<Json<GameView>, AppError> {
    let code = normalize_code(&code)?;
    let game = db::snapshot(&app.pool, &code).await?;
    let you = query.player_id.and_then(|id| game.mark_of(id));
    Ok(Json(GameView {
        you,
        seat_token: None,
        game,
    }))
}

async fn play_move(
    State(app): State<AppState>,
    Path(code): Path<String>,
    Json(req): Json<PlayRequest>,
) -> Result<Json<GameView>, AppError> {
    let code = normalize_code(&code)?;
    let game = db::play(
        &app.pool,
        &code,
        req.player_id,
        req.position,
        req.version,
        req.seat_token.as_deref(),
    )
    .await?;
    publish_move(&app, &game);
    let you = game.mark_of(req.player_id);
    Ok(Json(GameView {
        you,
        seat_token: None,
        game,
    }))
}

/// 只回棋谱。这个接口是"棋谱即真相"的直接体现：
/// 任何人拿到这串落子都能独立重放出同一盘棋，不依赖服务器。
async fn replay(
    State(app): State<AppState>,
    Path(code): Path<String>,
) -> Result<Json<ReplayView>, AppError> {
    let code = normalize_code(&code)?;
    let game = db::snapshot(&app.pool, &code).await?;
    Ok(Json(ReplayView {
        code: game.code,
        state: game.state.as_str(),
        moves: game.moves,
    }))
}

/// 观战用的 SSE 流。
///
/// 只推轻量通知（手数/状态），端上收到后回拉完整快照 —— 规则裁决始终在服务端。
/// 订阅前先拉一次快照确认房间存在，顺带给端上一个初始画面；
/// 这样"订阅之前发生的落子"不会漏 —— 端上本来就是从这次快照开始画的。
async fn game_events(
    State(app): State<AppState>,
    Path(code): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let code = normalize_code(&code)?;
    // 房间不存在直接 404，而不是开一个永远没数据的流
    let _ = db::snapshot(&app.pool, &code).await?;

    let mut rx = app.subscribe(&code);
    let stream = async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    yield Ok::<Event, Infallible>(event_to_sse(event));
                }
                // 观战端落后太多：跳过积压，下一条通知会带最新手数，端上回拉即可
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::debug!(skipped, code, "观战端落后，跳过积压通知");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    // 每 15 秒一条心跳注释，防止反向代理把安静的长连接掐断
    Ok(Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    ))
}

/// 从快照里摘出观战通知并广播。三个会改变局面的 handler 都调用它。
fn publish_move(app: &AppState, game: &GameSnapshot) {
    app.publish(GameEvent {
        code: game.code.clone(),
        plies: game.plies,
        state: game.state,
        version: game.version,
    });
}

/// GameEvent → SSE 事件。data 就是事件本身的 JSON，端上 JSON.parse 即可。
fn event_to_sse(event: GameEvent) -> Event {
    Event::default()
        .event("move")
        .json_data(event)
        .unwrap_or_else(|_| Event::default().event("move").data("{}"))
}

/// 战绩榜：只统计真人对真人的对局（机器人对局不进榜，避免刷榜）。
async fn leaderboard(State(app): State<AppState>) -> Result<Json<Value>, AppError> {
    let entries = db::leaderboard(&app.pool).await?;
    Ok(Json(json!({ "entries": entries })))
}

fn normalize_code(raw: &str) -> Result<String, AppError> {
    let code = raw.trim().to_ascii_uppercase();
    let valid = code.len() == 6 && code.bytes().all(|b| b.is_ascii_alphanumeric());
    if valid {
        Ok(code)
    } else {
        Err(AppError::bad_request("房间码是 6 位字母或数字"))
    }
}
