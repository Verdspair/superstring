-- 判断读数改成"每人一行"（用户 2026-09-25 第三次指示：不同人的消息分开来跑，每人各自判断一次）。
--
-- 0036 的表是**每会话一行**：一间会话最近一次判断给出的分数，两条主动路径共用。现在判断改成按发言人做
-- ——对每个人各问一次"值不值得回他"——所以读数也必须按人存，否则张三的分数会被当成李四的。
--
-- 主键从 `conversation_key` 变成 `(conversation_key, speaker_id)`，SQLite 改不了主键，只能重建（0033
-- 重建裁决表是同一处境）。**旧行不搬**：它们没有"这是谁的分数"这一位，硬塞一个 speaker_id 等于编造
-- 归属；这本来就是一份缓存（最近一次读得出的分数），丢掉只会让下一轮重新判一次。
--
-- `speaker_id` 与 `qq_events.speaker_id` 同一口径（群友的稳定 ID，也是 `@` 用的那个号）。
-- `basis_event_count` 是"判断当时**这个人**在会话里的消息条数"：0036 的"判断间隔"因此也是按人算的
-- ——张三又说了 3 条才重问一次张三，李四说话不花张三的那次判断。
CREATE TABLE qq_judgement_readings_rebuilt (
  conversation_key TEXT NOT NULL,
  speaker_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 10),
  basis_event_count INTEGER NOT NULL CHECK (basis_event_count >= 0),
  judged_at_seconds INTEGER NOT NULL CHECK (judged_at_seconds >= 0),
  PRIMARY KEY (conversation_key, speaker_id)
);
DROP TABLE qq_judgement_readings;
ALTER TABLE qq_judgement_readings_rebuilt RENAME TO qq_judgement_readings;
