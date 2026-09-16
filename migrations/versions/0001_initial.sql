-- 0001_initial.sql
-- Authoritative DDL for the 16 business tables of the superstring replica.
-- Source of truth: docs/reference/data-model.md (golden). This MUST stay in
-- lock-step with src/server/db/schema.ts (drift is guarded by
-- tests/integration/db-schema.test.ts).
--
-- Design notes (data-model.md §0):
--   * All 16 tables use IF NOT EXISTS so the file is safe to re-run (idempotent).
--   * MySQL InnoDB / utf8mb4 / collate table options are intentionally dropped.
--   * String(N)/Text -> TEXT; Integer/BigInteger -> INTEGER; Float -> REAL;
--     Boolean -> INTEGER 0/1 with CHECK IN (0,1); JSON -> TEXT; DATETIME(fsp=6)
--     -> TEXT ISO8601 with microseconds (generated at the application layer;
--     SQLite has no CURRENT_TIMESTAMP(6), see risk R1).
--   * Foreign keys are enforced only when `PRAGMA foreign_keys = ON` (the
--     connection layer does this per connection). ON DELETE policies below match
--     data-model.md §2.2.
--   * The schema version is stamped by the gate (src/server/db/schema-gate.ts)
--     via `PRAGMA user_version`; this file does NOT set user_version.

CREATE TABLE IF NOT EXISTS users (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  description TEXT NOT NULL,
  additional_instructions TEXT NOT NULL,
  p5_config TEXT NOT NULL,
  model_name TEXT NOT NULL,
  temperature REAL NOT NULL DEFAULT 0.7,
  memory_consolidation_model_name TEXT,
  memory_consolidation_prompt TEXT NOT NULL,
  memory_consolidation_additional_instructions TEXT NOT NULL,
  memory_retrieval_model_name TEXT,
  memory_retrieval_prompt TEXT NOT NULL,
  context_compression_model_name TEXT,
  persona_intensity INTEGER NOT NULL DEFAULT 60,
  is_active INTEGER NOT NULL DEFAULT 1,
  config_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (temperature >= 0 AND temperature <= 2),
  CHECK (config_version >= 1),
  CHECK (persona_intensity >= 0 AND persona_intensity <= 100),
  CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS agent_personas (
  id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  core_identity TEXT NOT NULL DEFAULT '',
  communication_style TEXT NOT NULL DEFAULT '',
  interaction_boundaries TEXT NOT NULL DEFAULT '',
  example_dialogues TEXT NOT NULL DEFAULT '',
  advanced_instructions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_persona_agent ON agent_personas (agent_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  client_request_id TEXT NOT NULL,
  agent_config_snapshot TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1,
  next_sequence_no INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (mode IN ('chat', 'work')),
  CHECK (config_version >= 1),
  CHECK (next_sequence_no >= 1),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION,
  FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_user_request ON sessions (user_id, client_request_id);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  runtime_config_snapshot TEXT NOT NULL,
  context_valid INTEGER NOT NULL DEFAULT 1,
  source_valid INTEGER NOT NULL DEFAULT 1,
  generation_token TEXT,
  generation_status TEXT NOT NULL DEFAULT 'completed',
  lease_expires_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (context_valid IN (0, 1)),
  CHECK (source_valid IN (0, 1)),
  CHECK (generation_status IN ('active', 'completed', 'failed', 'cancelled')),
  CHECK (cancel_requested IN (0, 1)),
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_turn_session_request ON turns (session_id, client_request_id);
CREATE INDEX IF NOT EXISTS ix_turns_session_created ON turns (session_id, created_at, id);
CREATE INDEX IF NOT EXISTS ix_turns_session_generation ON turns (session_id, generation_status, lease_expires_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (role IN ('user', 'assistant', 'system')),
  CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  CHECK (sequence_no >= 1),
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_message_session_sequence ON messages (session_id, sequence_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_turn_role ON messages (turn_id, role);
CREATE INDEX IF NOT EXISTS ix_messages_session_order ON messages (session_id, sequence_no);

CREATE TABLE IF NOT EXISTS message_deletion_events (
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  original_message_id TEXT NOT NULL,
  original_sequence_no INTEGER NOT NULL,
  role TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  CHECK (role IN ('user', 'assistant')),
  CHECK (original_sequence_no >= 1),
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_deletion_event_session_message
  ON message_deletion_events (session_id, original_message_id);
CREATE INDEX IF NOT EXISTS ix_message_deletion_events_session_sequence
  ON message_deletion_events (session_id, original_sequence_no);

CREATE TABLE IF NOT EXISTS memory_policies (
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  auto_enabled INTEGER NOT NULL DEFAULT 0,
  every_turns INTEGER NOT NULL DEFAULT 20,
  target_chars INTEGER NOT NULL DEFAULT 300,
  version INTEGER NOT NULL DEFAULT 1,
  governance_epoch INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id),
  CHECK (every_turns >= 1 AND every_turns <= 200),
  CHECK (target_chars >= 50 AND target_chars <= 4000),
  CHECK (auto_enabled IN (0, 1)),
  FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS memory_session_states (
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'reality_user',
  PRIMARY KEY (session_id),
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL,
  kinds TEXT NOT NULL,
  body TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  config_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (status IN ('active', 'suppressed', 'replaced', 'invalid')),
  FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS ix_memory_owner_status ON memory_entries (user_id, agent_id, status);

CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  PRIMARY KEY (memory_id, turn_id),
  FOREIGN KEY (memory_id) REFERENCES memory_entries (id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_links (
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  PRIMARY KEY (parent_id, child_id),
  FOREIGN KEY (parent_id) REFERENCES memory_entries (id) ON DELETE CASCADE,
  FOREIGN KEY (child_id) REFERENCES memory_entries (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_processed_turns (
  turn_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (turn_id),
  FOREIGN KEY (turn_id) REFERENCES turns (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT,
  turn_ids TEXT NOT NULL,
  memory_ids TEXT NOT NULL,
  config_snapshot TEXT NOT NULL,
  governance_epoch INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  token TEXT,
  lease_expires_at TEXT,
  result_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE SET NULL,
  FOREIGN KEY (result_id) REFERENCES memory_entries (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_job_request ON memory_jobs (agent_id, user_id, request_key);
CREATE INDEX IF NOT EXISTS ix_memory_job_queue ON memory_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS session_summaries (
  id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  start_sequence_no INTEGER NOT NULL,
  end_sequence_no INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  content TEXT NOT NULL,
  model_name TEXT NOT NULL,
  config_snapshot TEXT NOT NULL,
  template_version TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  is_valid INTEGER NOT NULL DEFAULT 1,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (is_valid IN (0, 1)),
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS ix_summary_session_active
  ON session_summaries (session_id, is_valid, start_sequence_no);

CREATE TABLE IF NOT EXISTS summary_sources (
  summary_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  PRIMARY KEY (summary_id, turn_id),
  FOREIGN KEY (summary_id) REFERENCES session_summaries (id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES turns (id) ON DELETE CASCADE
);
