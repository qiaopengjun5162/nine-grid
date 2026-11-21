-- 机器人的难度是「这一局的属性」：建局者邀请机器人时选定，之后每一手应招都按它走。
-- 放在 games 表而不是 players，是因为同一个机器人身份会在很多局里以不同难度出现。
--
-- default 'hard' 让老数据（写这条迁移之前建的局）保持原来的完美防守行为，
-- 不用写数据回填，也不需要 nullable 列带来的 None 分支。
alter table games
    add column if not exists bot_difficulty text not null default 'hard'
        check (bot_difficulty in ('easy', 'medium', 'hard'));
