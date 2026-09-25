-- 外部模型 API（用户 2026-09-25 弹窗决定）：OpenAI 兼容的额外模型来源。
--
-- 形状：一个 provider 行 = 一个 base URL 与一把密钥；它下面有哪些模型、每个模型多大上下文，
-- 是这个 provider 自己的属性（与其他 provider 无关），所以清单作为 JSON 跟着行一起走——项目已
-- 有同类先例（`agents.p5_config`、`qq_bindings.attention_members`）。这样新增/改名一个模型
-- 就是一次普通的比较交换，不需要第二张表。
--
-- 两个刻意的选择：
--   * `api_key` 存**密文**（AES-256-GCM，本机密钥文件落在 state 目录），明文永不入库也永不回传；
--     与 QQ 传输令牌同一套做法，各自一把密钥文件（轮换一个不会影响另一个）。
--   * `models` 里每个模型都必须带**用户手填的上下文窗口**：外部服务通常不报这个数，而容量预检
--     拿不到数就一律拒绝（QQ 链路会直接停摆）。宁可要求先填一个数，也不在未知时冒险调用；
--     定义形状由契约与页面把关，SQL 这边只保证是合法 JSON 数组。
CREATE TABLE model_providers (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT,
  models TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(models) AND json_type(models) = 'array'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_model_providers_name ON model_providers(name);
