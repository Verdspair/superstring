-- 方案两档「输出预留」的数据库上限与契约保持一致。
--
-- 0019 的两列 CHECK 上限为 16384；这里提高到 32768。
-- 推理模型的思考 token 也可能计入 max_tokens，输出预留需要容纳这部分用量。
-- 数据库与接口使用相同的有效范围，避免接口已接受的数值在写库时被 CHECK 拒绝。
-- 列的默认值保持不变，已保存的预留值也必须原样保留。
--
-- SQLite 改不了列上的 CHECK，只能重建该列：先把它**暂存**下来（值必须原样搬回去，用户方案里
-- 可能已经各自设过值），再 DROP COLUMN + ADD COLUMN，然后把值写回。不用"整表重建"那套：
-- `qq_scheme_sticker_collections.scheme_id` 是指向本表的外键（ON DELETE CASCADE），重建时
-- DROP 父表会连带删掉各方案的授权集合，而迁移跑在事务里、关不掉外键。DROP COLUMN 不触发
-- 子表级联，也不改动其它列，保留既有方案授权关系。
--
-- 副作用：这两列在表里的物理位置挪到了最后（SQLite 只能追加列），schema.ts 与结构比对里的
-- 列顺序同步挪到末尾——与"声明顺序 = 表的真实顺序"这条既有约定保持一致。
CREATE TABLE qq_scheme_output_reserve_caps AS
  SELECT id, judgement_output_reserved, reply_output_reserved FROM qq_schemes;

ALTER TABLE qq_schemes DROP COLUMN judgement_output_reserved;
ALTER TABLE qq_schemes ADD COLUMN judgement_output_reserved INTEGER NOT NULL DEFAULT 512 CHECK (judgement_output_reserved >= 256 AND judgement_output_reserved <= 32768);
ALTER TABLE qq_schemes DROP COLUMN reply_output_reserved;
ALTER TABLE qq_schemes ADD COLUMN reply_output_reserved INTEGER NOT NULL DEFAULT 2048 CHECK (reply_output_reserved >= 256 AND reply_output_reserved <= 32768);

UPDATE qq_schemes
SET judgement_output_reserved = (
  SELECT judgement_output_reserved FROM qq_scheme_output_reserve_caps WHERE qq_scheme_output_reserve_caps.id = qq_schemes.id
);
UPDATE qq_schemes
SET reply_output_reserved = (
  SELECT reply_output_reserved FROM qq_scheme_output_reserve_caps WHERE qq_scheme_output_reserve_caps.id = qq_schemes.id
);

DROP TABLE qq_scheme_output_reserve_caps;
