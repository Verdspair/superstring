-- References order existing source records; bodies retain their existing ownership/lifetime.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('web','onebot11')),
  topology TEXT NOT NULL CHECK(topology IN ('direct','shared')),
  source_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  binding_epoch INTEGER NOT NULL CHECK(binding_epoch > 0),
  source_watermark INTEGER NOT NULL DEFAULT 0,
  next_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_seq > 0),
  consumed_seq INTEGER NOT NULL DEFAULT 0 CHECK(consumed_seq >= 0 AND consumed_seq < next_seq),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(channel,source_id,binding_epoch)
);
CREATE INDEX ix_conversations_user_activity ON conversations(user_id,updated_at,id);
CREATE UNIQUE INDEX uq_conversations_current_source ON conversations(channel,source_id) WHERE closed_at IS NULL;
CREATE TABLE conversation_events (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK(seq > 0),
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','media_revision','wake','delivery')),
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  source_expires_at TEXT,
  sources TEXT NOT NULL CHECK(json_valid(sources)),
  participant TEXT CHECK(participant IS NULL OR json_valid(participant)),
  addressing TEXT NOT NULL CHECK(json_valid(addressing)),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  run_id TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  output_id TEXT,
  PRIMARY KEY(conversation_id,seq),
  UNIQUE(conversation_id,event_key),
  UNIQUE(conversation_id,source_kind,source_id,source_revision)
);
CREATE INDEX ix_conversation_events_source ON conversation_events(source_kind,source_id);
CREATE TABLE wake_signals (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  cause TEXT NOT NULL,
  through_seq INTEGER NOT NULL CHECK(through_seq >= 0),
  dedupe_key TEXT NOT NULL UNIQUE,
  ready_at TEXT NOT NULL,
  priority INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','leased','completed','no_output','failed')),
  lease_token TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((status = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX ix_wake_due ON wake_signals(status,ready_at,priority,created_at);
CREATE UNIQUE INDEX uq_wake_leased_conversation ON wake_signals(conversation_id) WHERE status='leased';
ALTER TABLE agent_runs ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN wake_id TEXT REFERENCES wake_signals(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN observed_seq INTEGER;
CREATE INDEX ix_agent_runs_conversation ON agent_runs(conversation_id,started_at);

-- A deleted Web session has no surviving conversation to expose in the unified list.
CREATE TRIGGER delete_web_conversation AFTER DELETE ON sessions BEGIN
  DELETE FROM conversations WHERE channel='web' AND source_id=OLD.id;
END;
