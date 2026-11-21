//! 房间事件总线：给 SSE 观战用。
//!
//! 设计上刻意只广播「通知」而非「局面」：事件里只有手数和状态，
//! 观战端收到后回拉 `GET /api/games/{code}` 拿完整快照。
//! 这样判胜负、算轮次的权力始终留在服务端 —— 和"客户端只发意图"的铁律一致。
//!
//! 每个房间码一个 `broadcast` 频道，晚订阅的人拿不到历史通知（这没关系，
//! 因为他订阅前会先拉一次完整快照）。无人观战时 `send` 返回 Err，直接忽略即可。

use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

use nine_grid_core::GameState;
use serde::Serialize;
use sqlx::PgPool;
use tokio::sync::broadcast;

/// 每个频道的缓冲条数。一局最多 9 手，32 足够宽松；
/// 观战端偶尔卡一下积压几条也能追上，超出才报 Lagged（handler 里跳过）。
const CHANNEL_CAPACITY: usize = 32;

/// axum 的共享状态：数据库连接池 + 事件总线。
/// 用 `Arc` 包住总线，是因为 axum 会 clone 整个 state 给每个请求。
#[derive(Debug, Clone)]
pub struct AppState {
    pub pool: PgPool,
    bus: Arc<EventBus>,
}

impl AppState {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            bus: Arc::new(EventBus::default()),
        }
    }

    /// 广播一条落子/终局通知。没有订阅者时静默返回。
    pub fn publish(&self, event: GameEvent) {
        self.bus.publish(event);
    }

    /// 订阅某个房间的通知。订阅前请先拉一次快照，避免错过订阅之前的落子。
    pub fn subscribe(&self, code: &str) -> broadcast::Receiver<GameEvent> {
        self.bus.subscribe(code)
    }
}

#[derive(Debug, Default)]
struct EventBus {
    /// 标准 `RwLock` 而非 tokio 的：这里只做很短的 map 查找/插入，不跨 await，
    /// 持锁期间不会有异步切换，用标准锁更轻、也避免把 handler 变成 async 锁竞争。
    channels: RwLock<HashMap<String, broadcast::Sender<GameEvent>>>,
}

impl EventBus {
    fn publish(&self, event: GameEvent) {
        let sender = self.sender(&event.code);
        // 没有订阅者是常态（大多数对局没人观战），send 返回 Err 直接丢掉
        let _ = sender.send(event);
    }

    fn subscribe(&self, code: &str) -> broadcast::Receiver<GameEvent> {
        self.sender(code).subscribe()
    }

    /// 取（或建）某个房间的发送端。publish 和 subscribe 都走这里，
    /// 保证双方拿到的是同一个频道。
    fn sender(&self, code: &str) -> broadcast::Sender<GameEvent> {
        if let Some(sender) = self.channels.read().expect("事件总线锁被污染").get(code) {
            return sender.clone();
        }

        let mut channels = self.channels.write().expect("事件总线锁被污染");
        channels
            .entry(code.to_owned())
            .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0)
            .clone()
    }
}

/// 广播给观战端的轻量通知。端上收到后用 `code` 回拉完整快照。
#[derive(Debug, Clone, Serialize)]
pub struct GameEvent {
    pub code: String,
    pub plies: u8,
    pub state: GameState,
    pub version: i64,
}
