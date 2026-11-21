use std::path::PathBuf;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use nine_grid_bot::Difficulty;
use nine_grid_core::Mark;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower_http::services::ServeDir;
use uuid::Uuid;

use crate::{
    db::{self, GameSnapshot},
    error::AppError,
};

/// 路由表：6 个玩法接口 + 1 个健康检查，其余全部交给静态文件
pub fn router(pool: PgPool, static_dir: PathBuf) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/games", post(create_game))
        .route("/api/games/{code}", get(get_game))
        .route("/api/games/{code}/join", post(join_game))
        .route("/api/games/{code}/bot", post(seat_bot))
        .route("/api/games/{code}/moves", post(play_move))
        .route("/api/games/{code}/replay", get(replay))
        .fallback_service(ServeDir::new(static_dir).append_index_html_on_directories(true))
        .with_state(pool)
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
}

#[derive(Debug, Deserialize)]
struct PlayRequest {
    player_id: Uuid,
    position: u8,
    /// 客户端上次看到的版本号；带上它就能避免"抢先后落子"
    version: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ViewQuery {
    player_id: Option<Uuid>,
}

/// 在快照外层补一个 `you` 字段，前端就不用自己算自己执什么子
#[derive(Debug, Serialize)]
struct GameView {
    you: Option<Mark>,
    #[serde(flatten)]
    game: GameSnapshot,
}

#[derive(Debug, Serialize)]
struct ReplayView {
    code: String,
    state: &'static str,
    moves: Vec<db::MoveView>,
}

async fn healthz(State(pool): State<PgPool>) -> Result<Json<Value>, AppError> {
    sqlx::query("select 1").execute(&pool).await?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn create_game(
    State(pool): State<PgPool>,
    Json(req): Json<CreateGameRequest>,
) -> Result<(StatusCode, Json<GameView>), AppError> {
    let game = db::create_game(&pool, req.player_id, req.handle.as_deref()).await?;
    let you = game.mark_of(req.player_id);
    Ok((StatusCode::CREATED, Json(GameView { you, game })))
}

async fn join_game(
    State(pool): State<PgPool>,
    Path(code): Path<String>,
    Json(req): Json<JoinGameRequest>,
) -> Result<Json<GameView>, AppError> {
    let code = normalize_code(&code)?;
    let game = db::join_game(&pool, &code, req.player_id, req.handle.as_deref()).await?;
    let you = game.mark_of(req.player_id);
    Ok(Json(GameView { you, game }))
}

/// 建局者邀请机器人坐进对面的座位。
///
/// 机器人不是"内置模式"，而是一个占座位的普通玩家 —— 之后所有落子都走
/// `/moves` 同一条规则路径，所以它对局也会留下完整的棋谱。
async fn seat_bot(
    State(pool): State<PgPool>,
    Path(code): Path<String>,
    Json(req): Json<SeatBotRequest>,
) -> Result<Json<GameView>, AppError> {
    let code = normalize_code(&code)?;
    let game = db::seat_bot(&pool, &code, req.player_id, req.difficulty).await?;
    let you = game.mark_of(req.player_id);
    Ok(Json(GameView { you, game }))
}

async fn get_game(
    State(pool): State<PgPool>,
    Path(code): Path<String>,
    Query(query): Query<ViewQuery>,
) -> Result<Json<GameView>, AppError> {
    let code = normalize_code(&code)?;
    let game = db::snapshot(&pool, &code).await?;
    let you = query.player_id.and_then(|id| game.mark_of(id));
    Ok(Json(GameView { you, game }))
}

async fn play_move(
    State(pool): State<PgPool>,
    Path(code): Path<String>,
    Json(req): Json<PlayRequest>,
) -> Result<Json<GameView>, AppError> {
    let code = normalize_code(&code)?;
    let game = db::play(&pool, &code, req.player_id, req.position, req.version).await?;
    let you = game.mark_of(req.player_id);
    Ok(Json(GameView { you, game }))
}

/// 只回棋谱。这个接口是"棋谱即真相"的直接体现：
/// 任何人拿到这串落子都能独立重放出同一盘棋，不依赖服务器。
async fn replay(
    State(pool): State<PgPool>,
    Path(code): Path<String>,
) -> Result<Json<ReplayView>, AppError> {
    let code = normalize_code(&code)?;
    let game = db::snapshot(&pool, &code).await?;
    Ok(Json(ReplayView {
        code: game.code,
        state: game.state.as_str(),
        moves: game.moves,
    }))
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
