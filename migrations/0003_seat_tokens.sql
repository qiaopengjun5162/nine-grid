-- 座位凭证：一局一席位一个，服务端只存哈希。
--
-- 为什么需要它：`player_id` 是客户端生成的 UUID，服务端直接采信等于
-- 「知道你的 id 就能替你落子」。凭证在建局 / 入座时签发一次，之后每次落子
-- 都要带上，且只对那一个座位有效。
--
-- 它不承担身份体系：能挡住「冒充别人座位」，挡不住「自己开两个浏览器对刷」。
-- 真正的身份要钱包签名，见 docs/AUDIT.md A-02。
--
-- 注意：本迁移之前建的局没有凭证行，落子会被拒（missing_seat_token）。
-- 这是有意的 —— 给老局补一个"谁都不知道"的凭证等于永远打不开，不如直接说清楚。

create table if not exists seat_tokens (
    game_id uuid not null references games (id) on delete cascade,
    mark smallint not null check (mark in (1, 2)),
    token_hash text not null,
    issued_at timestamptz not null default now(),
    primary key (game_id, mark)
);
