//! 按来源 IP 的令牌桶，只用来挡**写接口**。
//!
//! 为什么只挡写：观战（SSE）是长连接，读接口是幂等的，给它们限流只会让正常用户
//! 看不了棋；真正会被刷的是「建局」——每建一局就往库里写一行，而且不需要任何凭证。
//!
//! 为什么不用 `governor`：这里的需求只有「每分钟 N 次、按 IP 分开算」，
//! 二十行能写清楚，也能用假时钟单测；引入一个依赖反而要多解释它的一次性语义。
//!
//! 明确不做的事：**不识别用户身份**。同一个 NAT 后面的所有人共用一个桶，
//! 换 IP 就能重来。它是「别让人一秒建一万局」的闸门，不是防刷单的武器。

use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

/// 单个 IP 的令牌桶状态
#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    last: Instant,
}

/// 桶里最多记多少个 IP。超过就顺手清理 10 分钟没动静的，避免被随机 IP 撑爆内存。
const MAX_TRACKED_IPS: usize = 4096;
/// 清理阈值：超过这么久没请求的 IP 直接忘掉
const IDLE_FORGET: Duration = Duration::from_secs(600);

#[derive(Debug)]
pub struct RateLimiter {
    /// 桶容量 = 每分钟允许的突发次数
    capacity: f64,
    /// 每秒回填多少令牌
    refill_per_sec: f64,
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
}

impl RateLimiter {
    /// `per_minute` 是每个 IP 每分钟允许的写请求数；传 0 表示不启用（返回 None）。
    #[must_use]
    pub fn per_minute(per_minute: u32) -> Option<Self> {
        if per_minute == 0 {
            return None;
        }
        let capacity = f64::from(per_minute);
        Some(Self {
            capacity,
            // 匀速回填：允许一次打满 N 次，之后只能按 N/60 每秒慢慢恢复
            refill_per_sec: capacity / 60.0,
            buckets: Mutex::new(HashMap::new()),
        })
    }

    /// 取一个令牌。成功返回 `Ok`；被挡时返回建议的等待时长。
    ///
    /// # Errors
    /// 桶里没有令牌时返回需要等待的时间。
    pub fn check(&self, ip: IpAddr) -> Result<(), Duration> {
        self.check_at(ip, Instant::now())
    }

    /// 真正的实现，时间从参数进来 —— 单测因此不需要 sleep。
    fn check_at(&self, ip: IpAddr, now: Instant) -> Result<(), Duration> {
        // 锁中毒不该让服务挂掉：限流器丢的那点状态不值得 panic。
        let mut buckets = self.buckets.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

        if buckets.len() > MAX_TRACKED_IPS {
            buckets.retain(|_, b| now.saturating_duration_since(b.last) < IDLE_FORGET);
        }

        let bucket = buckets.entry(ip).or_insert(Bucket {
            tokens: self.capacity,
            last: now,
        });

        let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        bucket.last = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait = (1.0 - bucket.tokens) / self.refill_per_sec;
            Err(Duration::from_secs_f64(wait))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ip(last: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, last))
    }

    #[test]
    fn allows_burst_then_blocks() {
        let limiter = RateLimiter::per_minute(3).expect("启用");
        let now = Instant::now();
        for i in 0..3 {
            assert!(limiter.check_at(ip(1), now).is_ok(), "第 {i} 次该放行");
        }
        assert!(limiter.check_at(ip(1), now).is_err(), "第 4 次该被挡");
    }

    #[test]
    fn refills_over_time() {
        let limiter = RateLimiter::per_minute(60).expect("启用");
        let start = Instant::now();
        for _ in 0..60 {
            assert!(limiter.check_at(ip(2), start).is_ok());
        }
        assert!(limiter.check_at(ip(2), start).is_err());

        // 60/分钟 = 每秒 1 个，等 1 秒就能再取一个
        let later = start + Duration::from_secs(1);
        assert!(limiter.check_at(ip(2), later).is_ok(), "回填后该放行");
        assert!(limiter.check_at(ip(2), later).is_err(), "只回填了一个");
    }

    #[test]
    fn separate_ips_do_not_share_buckets() {
        let limiter = RateLimiter::per_minute(1).expect("启用");
        let now = Instant::now();
        assert!(limiter.check_at(ip(3), now).is_ok());
        assert!(limiter.check_at(ip(4), now).is_ok(), "另一个 IP 有自己的桶");
        assert!(limiter.check_at(ip(3), now).is_err());
    }

    #[test]
    fn wait_time_is_sane() {
        // 每分钟 1 次 = 60 秒回填一个；第二次立刻请求，应该告诉调用方「等约一分钟」
        let limiter = RateLimiter::per_minute(1).expect("启用");
        let now = Instant::now();
        assert!(limiter.check_at(ip(5), now).is_ok());
        let wait = limiter.check_at(ip(5), now).expect_err("应被挡");
        assert!(
            wait >= Duration::from_secs(55) && wait <= Duration::from_secs(61),
            "等待时长 {wait:?} 不合理"
        );
    }

    #[test]
    fn zero_means_disabled() {
        assert!(RateLimiter::per_minute(0).is_none());
    }
}
