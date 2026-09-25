-- 冷场判断的"上次判过"记忆（用户 2026-09-25 报告的真实回路）。
--
-- 问题：冷场扫描是定时的，而"不说话"这个结论此前只存在于内存里。判断结果是沉默时，既没有发言
-- 记录（`qq_speech_log` 只记送达的发言）也没有候选（判断完成即消费），于是下一轮扫描拿着**同一个
-- 基准**（最近一条群友消息）再判一次——每一轮都花一次模型调用，一直循环到群里有人说话为止。
-- 现有那道"上次开口没人回"（awaiting_reply）只在**真的开过口**之后才生效，对"判过但没说"无能为力。
--
-- 这张表就是那段缺失的记忆：每个会话一行，"上一轮安静判到哪个基准、什么时候判的"。扫描看到
-- 基准没有更新就直接跳过（原因 `already_judged`），不再调用模型；群里出现更新的群友消息时基准
-- 前进，判断自然恢复。行随绑定收敛（解绑即消失），与裁决表同一条纪律。
CREATE TABLE qq_idle_judgements (
  conversation_key TEXT NOT NULL PRIMARY KEY,
  -- 判断所依据的"最近一条有效群友消息"（秒）；它是这一轮安静的身份证。
  basis_seconds INTEGER NOT NULL CHECK (basis_seconds >= 0),
  judged_at_seconds INTEGER NOT NULL CHECK (judged_at_seconds >= 0)
);

-- 新原因 `already_judged` 也要进裁决表的白名单。SQLite 改不了 CHECK，只能重建：这张表很小、
-- 内容是每轮重写的诊断缓存（没有正文、没有凭据），重建的代价就是一次复制。
CREATE TABLE qq_sweep_verdicts_rebuilt (
  conversation_key TEXT NOT NULL PRIMARY KEY,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('group', 'private')),
  peer_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('scheduled', 'skipped')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'feature_off', 'conversation_paused', 'trigger_off', 'no_member_baseline',
    'awaiting_reply', 'not_quiet_yet', 'cooling_down', 'hourly_limit',
    'outside_active_hours', 'candidate_pending', 'already_judged')),
  observed_at_seconds INTEGER CHECK (observed_at_seconds IS NULL OR observed_at_seconds >= 0),
  ready_at_seconds INTEGER CHECK (ready_at_seconds IS NULL OR ready_at_seconds >= 0),
  decided_at_seconds INTEGER NOT NULL CHECK (decided_at_seconds >= 0),
  CHECK ((outcome = 'scheduled' AND reason IS NULL)
      OR (outcome = 'skipped' AND reason IS NOT NULL))
);
INSERT INTO qq_sweep_verdicts_rebuilt
  SELECT conversation_key, conversation_kind, peer_id, outcome, reason,
         observed_at_seconds, ready_at_seconds, decided_at_seconds
  FROM qq_sweep_verdicts;
DROP TABLE qq_sweep_verdicts;
ALTER TABLE qq_sweep_verdicts_rebuilt RENAME TO qq_sweep_verdicts;
CREATE INDEX ix_qq_sweep_verdicts_decided ON qq_sweep_verdicts(decided_at_seconds, conversation_key);
