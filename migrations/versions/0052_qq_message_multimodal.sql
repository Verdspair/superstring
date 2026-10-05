-- QQ 消息事实、对话关系与图片双模式（规格 §3–13）。
--
-- 永久 `qq_events` 只保留去重身份；可过期的双昵称快照、有序片段与引用关系放进
-- `qq_message_facts`（规格 §13.1/13.2）。text 片段可持指向既有正文的 Unicode 区间而非
-- 复制全文，正文到期则区间不可读取——这里只存 JSON，不解释区间语义。
--
-- 助手出站事实按 outbound_intent 绑定（§13.4）：`intent_id` 是真实外键；平台 part 消息 ID
-- 由原 outbound_parts 确认台账解析，这里不造 platformID。
--
-- `qq_members` 追加当前双昵称与来源状态：旧 nickname 列留着不动，它是真实的 legacy 显示
-- 证据；迁移不伪造两份历史名字（§13.5），已存在的行只标 `legacy`，新观察才写当前值。
--
-- 方案追加严格 JSON 的 `message_settings` / `media_input` 组（§6/§7）。已批准例外：迁移把
-- 全部现方案的 media_input.mode 设为 'native'（新旧方案统一默认 native，§7.1）；modules、
-- paused、triggers 一概不碰，普通动图的旧自定义帧数/尺寸保留（它们不在 media_input 里）。
--
-- 图片缓存按 §8.2/§13.6 分表：assets（字节＋scope＋内容 sha）、sources（消息媒体行 → 资产，
-- 独立到期）、variants（按策略准备的副本）、classifications（分类与证据来源）、read_tasks
-- （真实读取任务，每任务独立 attempts）。sha 去重不代替 scope 授权——唯一约束按
-- scope+sha 建，同图跨群/跨 Agent 是不同行。私人 text/blob 各带独立 expiry，不塞永久表。

-- 1. 入站消息事实（event_key 关联永久身份）。
CREATE TABLE qq_message_facts (
  event_key TEXT NOT NULL PRIMARY KEY REFERENCES qq_events (event_key) ON DELETE CASCADE,
  group_card TEXT CHECK (group_card IS NULL OR length(trim(group_card)) > 0),
  -- F4（§3.1）：逐字段姓名证据来源。'wire'＝本次入站原值（含显式清空——值 NULL 但来源
  -- 'wire' 与"字段缺省、无证据"是两个不同事实），'local'＝本次借本地目录有效值，NULL＝
  -- 历史无证据（不伪造成 wire 或 local）。来源只随本表快照存，不进 qq_members。
  group_card_source TEXT CHECK (group_card_source IS NULL OR group_card_source IN ('wire', 'local')),
  personal_nickname TEXT CHECK (personal_nickname IS NULL OR length(trim(personal_nickname)) > 0),
  personal_nickname_source TEXT
    CHECK (personal_nickname_source IS NULL OR personal_nickname_source IN ('wire', 'local')),
  legacy_display_name TEXT CHECK (legacy_display_name IS NULL OR length(trim(legacy_display_name)) > 0),
  name_state TEXT NOT NULL CHECK (name_state IN ('known', 'unknown', 'legacy')),
  parts TEXT NOT NULL CHECK (json_valid(parts) AND json_type(parts) = 'array'),
  reply_to_message_id TEXT CHECK (reply_to_message_id IS NULL OR length(reply_to_message_id) > 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX ix_qq_message_facts_expiry ON qq_message_facts (expires_at);
CREATE INDEX ix_qq_message_facts_reply ON qq_message_facts (reply_to_message_id);

-- 2. 助手出站消息事实（按出站意图绑定，整条多部件输出的身份快照）。
CREATE TABLE qq_outbound_message_facts (
  intent_id TEXT NOT NULL PRIMARY KEY REFERENCES outbound_intents (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  group_card TEXT CHECK (group_card IS NULL OR length(trim(group_card)) > 0),
  personal_nickname TEXT CHECK (personal_nickname IS NULL OR length(trim(personal_nickname)) > 0),
  legacy_display_name TEXT CHECK (legacy_display_name IS NULL OR length(trim(legacy_display_name)) > 0),
  parts TEXT NOT NULL CHECK (json_valid(parts) AND json_type(parts) = 'array'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  expires_at TEXT NOT NULL
);
CREATE INDEX ix_qq_outbound_message_facts_expiry ON qq_outbound_message_facts (expires_at);

-- 3. 成员目录的当前双昵称。旧 nickname 列（0018）不动。
ALTER TABLE qq_members ADD COLUMN group_card TEXT CHECK (group_card IS NULL OR length(trim(group_card)) > 0);
ALTER TABLE qq_members ADD COLUMN personal_nickname TEXT CHECK (personal_nickname IS NULL OR length(trim(personal_nickname)) > 0);
ALTER TABLE qq_members ADD COLUMN name_state TEXT NOT NULL DEFAULT 'legacy' CHECK (name_state IN ('known', 'unknown', 'legacy'));

-- 4. 方案的两组严格 JSON 设置（规格 §6/§7）。迁移按批准的例外把现方案统一设为 native；
--    message_settings 按已批准默认组（§5：按需引用、2 层、混合时间、上海时区）。
ALTER TABLE qq_schemes ADD COLUMN message_settings TEXT
  CHECK (message_settings IS NULL OR (json_valid(message_settings) AND json_type(message_settings) = 'object'));
ALTER TABLE qq_schemes ADD COLUMN media_input TEXT
  CHECK (media_input IS NULL OR (json_valid(media_input) AND json_type(media_input) = 'object'));
UPDATE qq_schemes SET message_settings = '{"reply_depth":2,"reply_mode":"one_then_on_demand","time_display":"hybrid","timezone":"Asia/Shanghai"}';
UPDATE qq_schemes SET media_input = '{"expression_frame_count":3,"expression_frame_max_dimension":512,"expression_max_dimension":512,"max_images":8,"mode":"native","ordinary_still_max_dimension":null,"stages":{"decision":true,"evaluation":true,"generation":true}}';

-- 5. 图片资产：字节缓存的去重身份在 scope 内（§12：同 sha 不同群/Agent 是不同行）。
CREATE TABLE qq_media_assets (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('group', 'private')),
  peer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  bytes BLOB NOT NULL CHECK (length(bytes) > 0),
  mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (account_id, conversation_kind, peer_id, agent_id, content_sha256)
);
CREATE INDEX ix_qq_media_assets_expiry ON qq_media_assets (expires_at);

-- 6. 资产来源：哪条消息媒体行带来这块字节；每来源独立 expiry（§8.2）。
CREATE TABLE qq_media_asset_sources (
  id TEXT NOT NULL PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES qq_media_assets (id) ON DELETE CASCADE,
  media_note_id TEXT NOT NULL UNIQUE REFERENCES qq_media_notes (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX ix_qq_media_asset_sources_expiry ON qq_media_asset_sources (expires_at);

-- 7. 准备副本：按策略/形状准备好的 PNG/JPEG 及尺寸/帧元数据（§7.4）。
CREATE TABLE qq_media_variants (
  id TEXT NOT NULL PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES qq_media_assets (id) ON DELETE CASCADE,
  policy TEXT NOT NULL CHECK (length(trim(policy)) > 0),
  bytes BLOB NOT NULL CHECK (length(bytes) > 0),
  mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) > 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  frame_count INTEGER CHECK (frame_count IS NULL OR frame_count >= 1),
  frames TEXT CHECK (frames IS NULL OR (json_valid(frames) AND json_type(frames) = 'array')),
  recorded_at TEXT NOT NULL,
  UNIQUE (asset_id, policy)
);

-- 8. 分类缓存：按资产＋模型/策略版本（§7.2）。evidence 说明类别证据来自哪里。
CREATE TABLE qq_media_classifications (
  id TEXT NOT NULL PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES qq_media_assets (id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('ordinary', 'expression', 'unknown')),
  evidence TEXT NOT NULL CHECK (evidence IN ('platform', 'model', 'unknown')),
  model_name TEXT CHECK (model_name IS NULL OR length(trim(model_name)) > 0),
  policy TEXT NOT NULL CHECK (length(trim(policy)) > 0),
  recorded_at TEXT NOT NULL,
  UNIQUE (asset_id, policy)
);

-- 9. 读取任务：真实描述结果的归属；attempts 是每任务自己的计数（§8.1）。
--    baseline 无问题键，detail 必须带；succeeded 必须留 note 与模型。
CREATE TABLE qq_media_read_tasks (
  id TEXT NOT NULL PRIMARY KEY,
  -- 载体列可空（ON DELETE SET NULL）：载体被 purge 只去私文/字节，任务账本（identity、
  -- attempts、status）必须存活——预算不能随载体清理消失（§8.1 稳定任务身份）。
  media_note_id TEXT REFERENCES qq_media_notes (id) ON DELETE SET NULL,
  asset_source_id TEXT REFERENCES qq_media_asset_sources (id) ON DELETE SET NULL,
  -- 账本自身的 scope 归属：载体 SET NULL 后管理面/诊断仍可按这四列归属（导入取 event）。
  account_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('group', 'private')),
  peer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  -- 稳定身份键：sha256(scope 四维 + segmentKind + purpose + question + "\n" + 内容 sha)。
  -- 同 scope 同字节同问题＝同一账本行（预算沿用）；换 URL/载体行/重启不派新键；
  -- NULL＝尚未以受控字节确认内容身份（历史不可识别行），绝不伪造。
  identity_key TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('baseline', 'detail')),
  question_key TEXT CHECK ((purpose = 'detail') = (question_key IS NOT NULL)),
  model_name TEXT,
  policy TEXT NOT NULL CHECK (length(trim(policy)) > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 2),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  -- 真实"第 N 次尝试被消耗"的时刻：只在 claim 的 CAS 写入里打点（NULL＝还没花过尝试），
  -- result/fail 复写会移动"补充必须晚于尝试"的比较边界，绝不回写。legacy 导入取媒体行
  -- 自己的 updated_at（它才是旧账本真实最后一次尝试的时刻），迁移时钟不伪造。
  last_attempt_at TEXT,
  note TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  -- 一次"已读"必须可归属：成功任务要留 note，模型输出必须点名模型（沿 0012 的纪律）。
  CHECK (status <> 'succeeded' OR (note IS NOT NULL AND model_name IS NOT NULL))
);
-- 任务身份按 purpose 拆成两个 partial unique index：SQLite 的 UNIQUE 把 NULL 视为互异，
-- 普通约束对 baseline（question_key 恒 NULL）形同虚设——同一 media_note_id 能插任意多条
-- baseline 行。baseline 靠 WHERE question_key IS NULL 兜住，detail 靠 WHERE question_key
-- IS NOT NULL 保持 (media_note_id, purpose, question_key) 的原身份语义。
CREATE UNIQUE INDEX uq_qq_media_read_task_baseline
  ON qq_media_read_tasks (media_note_id) WHERE question_key IS NULL;
CREATE UNIQUE INDEX uq_qq_media_read_task_detail
  ON qq_media_read_tasks (media_note_id, question_key) WHERE question_key IS NOT NULL;
-- 内容身份唯一槽：同 scope 同字节同问题的账本只许一行（并发下也防重）。NULL 不进索引。
CREATE UNIQUE INDEX uq_qq_media_read_task_identity
  ON qq_media_read_tasks (identity_key) WHERE identity_key IS NOT NULL;

-- 10. legacy 导入（规格 §8.1）：旧成功 note 成 baseline 任务（保 model/期限/attempts），
--     旧失败 attempts 导入 legacy task 且不归零；没有记录的行不造任务。不移植跨 Agent
--     cached 正文，也不延长 expiry——expires_at 原样取自媒体行。
INSERT INTO qq_media_read_tasks
  (id, media_note_id, asset_source_id, account_id, conversation_kind, peer_id, agent_id,
   identity_key, purpose, question_key, model_name, policy, attempts,
   status, note, revision, expires_at, recorded_at, last_attempt_at)
SELECT
  'legacy-' || m.id,
  m.id,
  NULL,
  e.account_id,
  e.conversation_kind,
  e.peer_id,
  e.agent_id,
  -- 不回填内容身份：迁移不 fetch 任何网络字节，identity_key 保持 NULL（真实历史行）。
  NULL,
  'baseline',
  NULL,
  m.note_model,
  'legacy',
  m.attempts,
  CASE WHEN m.note IS NOT NULL THEN 'succeeded' ELSE 'failed' END,
  m.note,
  1,
  m.expires_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  CASE WHEN m.attempts > 0 THEN m.updated_at ELSE NULL END
FROM qq_media_notes m
JOIN qq_events e ON e.event_key = m.event_key
WHERE m.attempts > 0;

-- 11. 事实投影按平台消息 ID 取一条消息的全部观测（T03/T04 的 load 路径）。
CREATE INDEX ix_qq_event_message ON qq_events (account_id, conversation_kind, agent_id, message_id);
