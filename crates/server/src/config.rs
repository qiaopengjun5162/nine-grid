use std::{env, net::SocketAddr};

use anyhow::{Context, Result};

/// 运行期配置，全部来自环境变量（`.env` 可选）
#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: SocketAddr,
    /// 每个 IP 每分钟允许的写请求数；0 表示关闭限流
    pub rate_limit_per_min: u32,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let database_url = env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://localhost:5432/nine_grid".to_owned());
        let bind_addr = env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
            .parse()
            .context("BIND_ADDR 需要是 host:port 形式，例如 127.0.0.1:8080")?;
        // 默认 300：一局棋正常人也就几十次写请求，300 足够宽松；
        // 真被刷时这个数会把「一秒建一万局」压到「一分钟三百局」。
        let rate_limit_per_min = match env::var("RATE_LIMIT_PER_MIN") {
            Ok(raw) => raw.parse().context("RATE_LIMIT_PER_MIN 需要是非负整数，0 表示关闭限流")?,
            Err(_) => 300,
        };

        Ok(Self {
            database_url,
            bind_addr,
            rate_limit_per_min,
        })
    }
}
