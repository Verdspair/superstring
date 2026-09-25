-- QQ transport bindings, owner identity and observation provenance (ADR0017 / ADR0018).
-- Additive migration from the unchanged business schema v4. It never rewrites an
-- existing column, default or row, and it stores no chat text: observation rows
-- keep only the dedup identity and provenance, so message retention (still
-- unscheduled) cannot expire the dedup key by accident.
--
-- Single-row tables follow the organization_settings / knowledge_settings shape.
-- qq_bindings.scheme_id has no foreign key yet: the named chat schemes are a
-- later migration, and until then the id is an opaque reference. The remaining
-- CHECK constraints restate the invariants the pure binding contract already
-- enforces, so a direct SQL write cannot create a state the contract rejects.

CREATE TABLE qq_settings (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  account_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
INSERT INTO qq_settings (id, enabled, account_id, revision) VALUES (1, 0, NULL, 1);

CREATE TABLE qq_owner_identities (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  account_id TEXT NOT NULL,
  peer_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

CREATE TABLE qq_bindings (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('group', 'private')),
  peer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  scheme_id TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  share_web_memory INTEGER NOT NULL DEFAULT 0 CHECK (share_web_memory IN (0, 1)),
  owner_identity_revision INTEGER CHECK (
    owner_identity_revision IS NULL OR owner_identity_revision >= 1
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  authority_revision INTEGER NOT NULL DEFAULT 1 CHECK (authority_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (authority_revision <= revision),
  CHECK (
    share_web_memory = 0
    OR (conversation_kind = 'private' AND owner_identity_revision IS NOT NULL)
  ),
  CHECK (share_web_memory = 1 OR owner_identity_revision IS NULL)
);
CREATE UNIQUE INDEX uq_qq_binding_conversation
  ON qq_bindings (account_id, conversation_kind, peer_id);
CREATE INDEX ix_qq_binding_agent ON qq_bindings (agent_id, conversation_kind, peer_id);

CREATE TABLE qq_events (
  event_key TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('group', 'private')),
  peer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL CHECK (length(message_id) > 0),
  occurred_at_seconds INTEGER NOT NULL CHECK (occurred_at_seconds >= 0),
  speaker_kind TEXT NOT NULL CHECK (speaker_kind IN ('member', 'anonymous', 'system')),
  speaker_id TEXT,
  recorded_at TEXT NOT NULL,
  CHECK ((speaker_kind = 'member') = (speaker_id IS NOT NULL))
);
CREATE INDEX ix_qq_event_conversation
  ON qq_events (account_id, conversation_kind, peer_id, occurred_at_seconds);
