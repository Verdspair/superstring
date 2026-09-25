-- P6 后续（用户 2026-09-25 决定）：「重要的人」——每个会话一份名单，两种用法按会话可切。
--
-- 为什么是两列 JSON 而不是一张成员表：名单只属于它那一个绑定，没有跨会话复用，也不需要
-- "谁在哪些会话里被列为重要"这种反查；项目里已有同类先例（`agents.p5_config`、
-- `knowledge_drafts.document_ids` 都是 JSON 列 + `json_valid` CHECK）。放进绑定行之后，
-- 它天然跟着绑定的比较交换走，解绑即消失，不需要外键与级联。
--
-- 语义（配对规则由契约 refine 强制，SQL 只保证单列合法）：
--   * `attention_mode` 为 NULL ＝ 这个会话没有启用名单，此时成员列必须为空；
--   * 'soft' ＝ 名单内的人发言在判断/回复的上下文里被标出来，所有门槛不变；
--   * 'hard' ＝ 只有名单内的人发言才可能触发（分类入队、被@的直接回应、冷场扫描的基准
--     都按名单过滤），名单外的人照常记录与整理，但不会让它开口。
-- 模式与成员必须同时说清：契约拒绝"有模式却没有成员"和"没有模式却列了人"这两行。
ALTER TABLE qq_bindings ADD COLUMN attention_mode TEXT CHECK (
  attention_mode IS NULL OR attention_mode IN ('soft', 'hard'));
ALTER TABLE qq_bindings ADD COLUMN attention_members TEXT CHECK (
  attention_members IS NULL
  OR (json_valid(attention_members) AND json_type(attention_members) = 'array'));
