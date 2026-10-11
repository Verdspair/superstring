-- QQ 媒体读取任务请求身份（规格 §5.7；ROOT-P4-REQUEST-LEDGER-SCHEMA63-DECISION）。
--
-- 0052 的 uq_qq_media_read_task_detail 是 (media_note_id, question_key) 的 partial unique：
-- 同一载体同一问题的显式请求（带宿主解析的 request_id）会与普通行冲突，onConflictDoNothing
-- 把新预算行吞掉后 taskFor 兜底返回旧行——真实新请求永远无法入账。0063 把"普通行"的身份
-- 收窄为 request_id IS NULL 的行，显式请求行由既有的 uq_qq_media_read_task_identity
-- （identity_key 已含第 8 元组 request id 的 8 元 hash）保证唯一。
--
-- 只做 DDL 三步，无任何数据行改写：旧 baseline（question_key 恒 NULL，request_id 恒 NULL）
-- 与普通 detail 行 request_id 全部为 NULL，继续落在收窄后的 partial unique 里，行为与
-- 0052 完全一致；attempts/status/note/history 原样保留。不回填、不建新表、不加缓存。
ALTER TABLE qq_media_read_tasks ADD COLUMN request_id TEXT
  CHECK (request_id IS NULL OR (purpose = 'detail' AND length(trim(request_id)) > 0));
DROP INDEX uq_qq_media_read_task_detail;
CREATE UNIQUE INDEX uq_qq_media_read_task_detail
  ON qq_media_read_tasks (media_note_id, question_key)
  WHERE question_key IS NOT NULL AND request_id IS NULL;
