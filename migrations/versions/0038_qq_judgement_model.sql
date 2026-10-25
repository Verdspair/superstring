-- QQ 全局判断模型：指定开口兴趣打分使用的模型。
--
-- QQ 全局判断模型由所有群与私聊共用，不随当前助手切换。未设置时仍跟随绑定助手的
-- 对话模型（`runtime.model_name`）。该值保存在 `qq_settings` 单行表，而不是某个方案中：
-- 它是运行时选择模型的参数；方案自己的门槛与提示词负责表达判断偏好，
-- 两者分别保存。
--
-- NULL = 跟随每间会话绑定助手的对话模型，也就是既有行为，所以**升级不回填**：老库升上来一个字都不变。
-- 列在表末尾（SQLite 的 ADD COLUMN 只能追加），`schema.ts` 的声明顺序刻意与迁移产物一致。
ALTER TABLE qq_settings ADD COLUMN judgement_model_name TEXT;
