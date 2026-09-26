-- 方案两档「最近条数」的数据库上限跟契约对齐（用户 2026-09-26）。
--
-- 0016 把这两列的上限写死在 DDL 里：judgement_message_limit ≤ 200、reply_message_limit ≤ 500。今天的
-- 契约放宽到 1 万只改了 TypeScript 一侧，数据库仍卡着旧上限——界面与接口都放行、写库时才被 CHECK
-- 拒绝，用户看到的是一句原生约束错误。这里把上限抬到与契约一致的 10000。
--
-- SQLite 改不了列上的 CHECK，只能重建该列：先把它**暂存**下来（值必须原样搬回去，用户可能已经把
-- 判断条数设成 200、回复设成 300），再 DROP COLUMN + ADD COLUMN，然后把值写回。
-- 不用"整表重建"那套：`qq_scheme_sticker_collections.scheme_id` 是指向本表的外键（ON DELETE CASCADE），
-- 重建时 DROP 父表会连带删掉各方案的授权集合，而迁移跑在事务里、关不掉外键。
-- DROP COLUMN 不触发子表级联、也不动其它列（已在本地实验确认：子表行数不变、foreign_key_check 干净）。
--
-- 副作用：这两列在表里的物理位置挪到了最后（SQLite 只能追加列），所以 schema.ts 与 golden 列表里的
-- 列顺序也跟着挪到末尾——与"声明顺序 = 表的真实顺序"这条既有约定保持一致。
CREATE TABLE qq_scheme_context_caps AS
  SELECT id, judgement_message_limit, reply_message_limit FROM qq_schemes;

ALTER TABLE qq_schemes DROP COLUMN judgement_message_limit;
ALTER TABLE qq_schemes ADD COLUMN judgement_message_limit INTEGER NOT NULL DEFAULT 20 CHECK (judgement_message_limit >= 1 AND judgement_message_limit <= 10000);
ALTER TABLE qq_schemes DROP COLUMN reply_message_limit;
ALTER TABLE qq_schemes ADD COLUMN reply_message_limit INTEGER NOT NULL DEFAULT 60 CHECK (reply_message_limit >= 1 AND reply_message_limit <= 10000);

UPDATE qq_schemes
SET judgement_message_limit = (
  SELECT judgement_message_limit FROM qq_scheme_context_caps WHERE qq_scheme_context_caps.id = qq_schemes.id
);
UPDATE qq_schemes
SET reply_message_limit = (
  SELECT reply_message_limit FROM qq_scheme_context_caps WHERE qq_scheme_context_caps.id = qq_schemes.id
);

DROP TABLE qq_scheme_context_caps;
