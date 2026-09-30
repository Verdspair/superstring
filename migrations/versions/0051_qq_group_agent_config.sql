-- 本群 Agent 配置：按 QQ 账号 × 群 × Agent 保存本群方案差异与本群停用的系统能力。

CREATE TABLE qq_group_agent_configs (
  id TEXT PRIMARY KEY NOT NULL,
  binding_id TEXT NOT NULL REFERENCES qq_bindings(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  scheme_overrides TEXT NOT NULL
    CHECK (json_valid(scheme_overrides) AND json_type(scheme_overrides) = 'object'),
  disabled_capabilities TEXT NOT NULL
    CHECK (json_valid(disabled_capabilities) AND json_type(disabled_capabilities) = 'array'),
  -- 每项能力的单调修订映射（能力每次跟随↔停用翻转 +1）：未登记的能力＝隐式 0。
  -- 供能力来源证据（qq_group_capability）失效判定：关闭再恢复不回落，旧证据不能复活。
  capability_revisions TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(capability_revisions) AND json_type(capability_revisions) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT uq_qq_group_agent_config UNIQUE (binding_id, agent_id)
);

INSERT INTO qq_group_agent_configs
  (id, binding_id, agent_id, scheme_overrides, disabled_capabilities, capability_revisions, revision, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6))),
  b.id,
  b.agent_id,
  json_object('triggers', json(json_object(
    'direct_reply', CASE WHEN b.trigger_direct_reply IS NULL THEN NULL
      ELSE json(CASE b.trigger_direct_reply WHEN 1 THEN 'true' ELSE 'false' END) END,
    'follow_up', CASE WHEN b.trigger_follow_up IS NULL THEN NULL
      ELSE json(CASE b.trigger_follow_up WHEN 1 THEN 'true' ELSE 'false' END) END,
    'chiming_in', CASE WHEN b.trigger_chiming_in IS NULL THEN NULL
      ELSE json(CASE b.trigger_chiming_in WHEN 1 THEN 'true' ELSE 'false' END) END,
    'idle_topic', CASE WHEN b.trigger_idle_topic IS NULL THEN NULL
      ELSE json(CASE b.trigger_idle_topic WHEN 1 THEN 'true' ELSE 'false' END) END
  ))),
  '[]',
  '{}',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM qq_bindings b
WHERE b.conversation_kind = 'group'
  AND (b.trigger_direct_reply IS NOT NULL OR b.trigger_follow_up IS NOT NULL
    OR b.trigger_chiming_in IS NOT NULL OR b.trigger_idle_topic IS NOT NULL);
