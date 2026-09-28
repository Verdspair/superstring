CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  origin_run_id TEXT REFERENCES agent_runs(run_id) ON DELETE SET NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_tool','waiting_approval','completed','failed','cancelled','unknown')),
  sources TEXT NOT NULL CHECK(json_valid(sources)),
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  error_code TEXT,
  CHECK((status IN ('running','waiting_tool')) = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX ix_agent_tasks_ready ON agent_tasks(status,created_at);
CREATE TABLE agent_task_calls (
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  name TEXT NOT NULL,
  revision TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('read','write')),
  arguments TEXT CHECK(arguments IS NULL OR json_valid(arguments)),
  status TEXT NOT NULL CHECK(status IN ('pending','waiting_approval','approved','running','completed','failed','unknown','cancelled')),
  approval_revision TEXT,
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  error_code TEXT,
  PRIMARY KEY(task_id,ordinal)
);
