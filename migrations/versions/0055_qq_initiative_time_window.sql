-- 自主接话的第二维时间窗口：合格成员消息在 [A-B, A+B] 秒内同样进入同一批判定，与 0054 的
-- 计数窗口 [X-Y, X+Y] 同形（择机名额，不是随机采样或防抖），所以边界与关系也同形：B<A。
-- A/B 的缺省 60/20 与写入侧的 QQ_RHYTHM_DEFAULT 一致。
--
-- 开关的 DDL 缺省是 0 而非 QQ_RHYTHM_DEFAULT 的 1：回填只改已有行，不改它们读到的行为，
-- 存量方案因此保持 0054 的纯计数模式；新方案走写入侧，落 true/60/20。
ALTER TABLE qq_schemes ADD COLUMN initiative_time_window_enabled INTEGER NOT NULL DEFAULT 0 CHECK (initiative_time_window_enabled IN (0, 1));
ALTER TABLE qq_schemes ADD COLUMN initiative_time_target_seconds INTEGER NOT NULL DEFAULT 60 CHECK (initiative_time_target_seconds >= 10 AND initiative_time_target_seconds <= 1800);
ALTER TABLE qq_schemes ADD COLUMN initiative_time_jitter_seconds INTEGER NOT NULL DEFAULT 20 CHECK (initiative_time_jitter_seconds >= 0 AND initiative_time_jitter_seconds <= 1799 AND initiative_time_jitter_seconds < initiative_time_target_seconds);

-- 时间窗口的起算锚：上一次完整有效判定（含决定沉默）的时刻。与 chiming_in_observed_seq 同事务
-- 推进，只表示这一批已判过，不表示回复是否送达，所以判完立刻写、不等回复子任务。
-- NULL ＝ 本会话还没有过有效判定。
ALTER TABLE conversations ADD COLUMN chiming_in_judged_at TEXT;

-- 自主接话唤醒首次被认领时冻结的来源下界。pending 仍可合并 through_seq，认领后不可变：重试与
-- 恢复沿这条冻结下界重建候选，判定期间后到的消息归入下一批，因此不需要第二条已判游标。
ALTER TABLE wake_signals ADD COLUMN source_from_seq INTEGER CHECK (source_from_seq IS NULL OR source_from_seq >= 0);
