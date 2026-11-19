mod api;
mod config;
mod db;
mod error;

use std::path::PathBuf;

use anyhow::Context;

use crate::config::Config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,nine_grid_server=debug")
            }),
        )
        .init();

    let config = Config::from_env()?;
    tracing::info!(addr = %config.bind_addr, "九宫棋服务启动中");

    let pool = db::connect(&config.database_url)
        .await
        .context("连接 Postgres 或执行 migrations 失败（检查 DATABASE_URL）")?;
    tracing::info!("数据库已就绪，migrations 已应用");

    let static_dir = std::env::var("STATIC_DIR").map_or_else(
        |_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("static"),
        PathBuf::from,
    );

    let app = api::router(pool, static_dir);
    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!("打开 http://{} 就能开始下棋", config.bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    if let Err(err) = tokio::signal::ctrl_c().await {
        tracing::error!(error = %err, "监听退出信号失败");
    }
    tracing::info!("收到退出信号，正在关闭");
}
