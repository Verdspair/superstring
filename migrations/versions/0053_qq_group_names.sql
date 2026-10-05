-- QQ 群显示名称：按 QQ 账号 × 群存一行，QQ 群本名与用户自定义备注各自独立。
--
-- 为什么不用绑定（qq_bindings）维度：同一个群在换绑/换助手之后仍然是同一个群，用户设过的备注
-- 不该丢失或分裂成两份，所以 key 是「登录的 QQ 账号 × 群号」，不是 binding_id、也不是 agent_id。
-- account_id / group_id 都不加外键：账号与群号都属于 QQ 平台侧，本地库里没有可引用的父行，
-- 加外键只会让导入和清理互相牵制。
--
-- 语义：
--   qq_name     —— 来自 QQ 的群本名，可能尚未取到（NULL）；本项目不改写它的取值。
--   custom_name —— 用户在本项目里设的显示备注；NULL ＝没有备注，显示侧回退 qq_name。
-- 取群本名只更新 qq_name，绝不覆盖 custom_name：备注永远优先，也不随群改名丢失。
-- 空白串不入库（与 API 的 trim→NULL 语义一致），因此显示侧只需判 NULL。
CREATE TABLE qq_group_names (
  account_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  qq_name TEXT
    CHECK (qq_name IS NULL OR length(trim(qq_name)) > 0),
  custom_name TEXT
    CHECK (custom_name IS NULL
      OR (length(trim(custom_name)) > 0 AND length(trim(custom_name)) <= 100)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, group_id)
);
