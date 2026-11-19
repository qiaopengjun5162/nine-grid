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

    let static_dir = resolve_static_dir();

    let app = api::router(pool, static_dir);
    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!("打开 http://{} 就能开始下棋", config.bind_addr);

    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

async fn shutdown_signal() {
    if let Err(err) = tokio::signal::ctrl_c().await {
        tracing::error!(error = %err, "监听退出信号失败");
    }
    tracing::info!("收到退出信号，正在关闭");
}

/// 前端文件从哪读。按优先级：
///
/// 1. `STATIC_DIR` 环境变量 —— 部署时想放哪就放哪；
/// 2. **可执行文件旁边的 `static/`** —— 发布包解压即用，不依赖编译期路径；
/// 3. 源码目录下的 `crates/server/static` —— `cargo run` 开发时用。
///
/// 第 2 条是刻意加的：`env!("CARGO_MANIFEST_DIR")` 是**编译时**的绝对路径，
/// 在 CI 机器上是 `/home/runner/work/...`，原样搬到发布包里就会指到不存在的目录。
fn resolve_static_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("STATIC_DIR") {
        return PathBuf::from(dir);
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        let beside_exe = parent.join("static");
        if beside_exe.join("index.html").is_file() {
            return beside_exe;
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("static")
}
