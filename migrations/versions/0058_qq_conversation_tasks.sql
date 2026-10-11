-- Durable owner for one complete QQ activation. Wake remains a short intake lease;
-- per-target reply children remain agent_runs, and this parent row retains the class cap
-- until every authorized child settles.
CREATE TABLE qq_conversation_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  task_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  binding_epoch INTEGER NOT NULL CHECK(binding_epoch > 0),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_class TEXT NOT NULL CHECK(task_class IN ('mention','ordinary')),
  cause TEXT NOT NULL CHECK(cause IN ('direct_reply','follow_up','chiming_in','idle_topic')),
  source_from_seq INTEGER NOT NULL CHECK(source_from_seq >= 0),
  source_through_seq INTEGER NOT NULL CHECK(source_through_seq >= source_from_seq),
  source_expires_at TEXT,
  origin_wake_id TEXT REFERENCES wake_signals(id) ON DELETE SET NULL,
  origin_event_key TEXT REFERENCES qq_events(event_key) ON DELETE SET NULL,
  platform_message_id TEXT,
  origin_run_id TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','no_output','failed','cancelled','expired')),
  judgement_done INTEGER NOT NULL DEFAULT 0 CHECK(judgement_done IN (0,1)),
  lease_token TEXT,
  lease_expires_at TEXT,
  cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancellation_requested IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  CHECK((task_class='mention' AND cause='direct_reply' AND platform_message_id IS NOT NULL AND origin_wake_id IS NULL) OR
        (task_class='ordinary' AND origin_event_key IS NULL AND platform_message_id IS NULL)),
  CHECK((status='running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK(cause='chiming_in' OR judgement_done=0)
);
CREATE UNIQUE INDEX uq_qq_conversation_tasks_key ON qq_conversation_tasks(task_key);
CREATE INDEX ix_qq_conversation_tasks_claim ON qq_conversation_tasks(status,created_at,id);
CREATE INDEX ix_qq_conversation_tasks_conversation ON qq_conversation_tasks(conversation_id,task_class,status);
CREATE INDEX ix_qq_conversation_tasks_source_expiry ON qq_conversation_tasks(source_expires_at);

ALTER TABLE wake_signals ADD COLUMN transferred_task_id TEXT REFERENCES qq_conversation_tasks(id) ON DELETE SET NULL;
