use std::{env, net::SocketAddr};

use anyhow::{Context, Result};

/// 运行期配置，全部来自环境变量（`.env` 可选）
#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: SocketAddr,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://localhost:5432/nine_grid".to_owned());
        let bind_addr = env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
            .parse()
            .context("BIND_ADDR 需要是 host:port 形式，例如 127.0.0.1:8080")?;

        Ok(Self {
            database_url,
            bind_addr,
        })
    }
}
