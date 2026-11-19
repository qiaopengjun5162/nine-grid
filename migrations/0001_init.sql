-- 九宫棋 · 初始 schema
--
-- 设计约定：**只存棋谱，不存棋盘。**
-- 棋盘永远由 moves 重放得出（见 nine_grid_core::Game::replay）。
-- 这样做的三个好处：
--   1. 迁移到链上时，moves 直接对应链上 event log，结构同构；
--   2. 回放功能天然存在，不需要额外设计；
--   3. 出现争议时能精确到"第几手出的问题"，而不是只知道最终局面。

create table if not exists players (
    id uuid primary key,
    handle text,
    -- 阶段 B 用：钱包地址。现在一律为空，上链时填 Pubkey。
    wallet text,
    created_at timestamptz not null default now()
);

create table if not exists games (
    id uuid primary key,
    -- 6 位房间码，去掉易混字符，玩家手输无歧义
    code text not null unique,
    -- waiting | in_progress | o_won | x_won | draw
    state text not null,
    -- 1 = O, 2 = X
    turn smallint not null,
    plies smallint not null default 0,
    -- 乐观锁版本号，每步 +1，前端带旧版本落子会被拒
    version bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists game_players (
    game_id uuid not null references games (id) on delete cascade,
    player_id uuid not null references players (id),
    mark smallint not null check (mark in (1, 2)),
    joined_at timestamptz not null default now(),
    primary key (game_id, mark),
    -- 同一个人不能在同一局里占两个座位
    unique (game_id, player_id)
);

create table if not exists moves (
    game_id uuid not null references games (id) on delete cascade,
    ply smallint not null check (ply between 1 and 9),
    mark smallint not null check (mark in (1, 2)),
    position smallint not null check (position between 0 and 8),
    player_id uuid not null references players (id),
    played_at timestamptz not null default now(),
    primary key (game_id, ply)
);

create index if not exists idx_moves_game on moves (game_id, ply);
create index if not exists idx_games_code on games (code);
