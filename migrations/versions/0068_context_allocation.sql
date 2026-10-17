-- 统一上下文分配（0068）。
-- 1) qq_schemes.allocation：方案级分配组（判断/回复两档模式）。NOT NULL + 默认两档 fixed，
--    与迁移语义一致：存量方案保持既有固定行为，读取口不依赖 NULL 兜底。
-- 2) organization_settings.auxiliary_allocation：全局辅助任务分配，NULL＝无任何辅助覆盖，
--    各用途保持调用方现行为。两列的值有效性由共享契约在读取时验证；CHECK 只保证 JSON object。
ALTER TABLE qq_schemes ADD COLUMN allocation TEXT NOT NULL
  DEFAULT '{"judgement":{"mode":"fixed"},"reply":{"mode":"fixed"}}'
  CHECK (json_valid(allocation) AND json_type(allocation) = 'object');
ALTER TABLE organization_settings ADD COLUMN auxiliary_allocation TEXT
  CHECK (auxiliary_allocation IS NULL OR (json_valid(auxiliary_allocation) AND json_type(auxiliary_allocation) = 'object'));
