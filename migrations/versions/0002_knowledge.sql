-- Knowledge library. Additive migration from the unchanged business schema v1.
-- Original text is never replaced by a generated draft. Grants have no category inheritance.
CREATE TABLE knowledge_settings (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  auto_enabled INTEGER NOT NULL DEFAULT 1 CHECK (auto_enabled IN (0, 1)),
  model_name TEXT,
  context_budget INTEGER NOT NULL DEFAULT 4096 CHECK (context_budget >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
INSERT INTO knowledge_settings (id) VALUES (1);

CREATE TABLE knowledge_categories (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
INSERT INTO knowledge_categories (id, name) VALUES ('default', '资料');

CREATE TABLE knowledge_documents (
  id TEXT NOT NULL PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES knowledge_categories (id),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  original_text TEXT NOT NULL CHECK (length(original_text) > 0),
  import_type TEXT NOT NULL CHECK (import_type IN ('text', 'txt', 'md')),
  content_mode TEXT NOT NULL DEFAULT 'draft' CHECK (content_mode IN ('draft', 'original')),
  content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version >= 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_knowledge_documents_category ON knowledge_documents (category_id, id);

CREATE TABLE knowledge_grants (
  document_id TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, agent_id)
);
CREATE INDEX ix_knowledge_grants_agent ON knowledge_grants (agent_id, document_id);

CREATE TABLE knowledge_chunks (
  id TEXT NOT NULL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  body TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_knowledge_chunk_position ON knowledge_chunks (document_id, content_version, ordinal);

CREATE TABLE knowledge_drafts (
  id TEXT NOT NULL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  summary TEXT NOT NULL,
  tags TEXT NOT NULL,
  body TEXT NOT NULL,
  sources TEXT NOT NULL,
  model_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_knowledge_draft_version ON knowledge_drafts (document_id, content_version);

CREATE TABLE knowledge_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 1),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX ix_knowledge_job_queue ON knowledge_jobs (status, created_at, id);

-- Keep request snapshots after document/grant deletion so retries can explicitly
-- reject stale access instead of silently pretending no content was previously read.
CREATE TABLE turn_knowledge_snapshots (
  turn_id TEXT NOT NULL PRIMARY KEY REFERENCES turns (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 1),
  items TEXT NOT NULL,
  created_at TEXT NOT NULL
);
