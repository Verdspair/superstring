-- P3 durable QQ dispatch: one global model lease, with the latest event per conversation.
-- No message text, platform request or send authority is stored here.
CREATE TABLE qq_dispatch_settings (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  lease_seconds INTEGER NOT NULL DEFAULT 120 CHECK (lease_seconds BETWEEN 30 AND 600),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
INSERT INTO qq_dispatch_settings (id, lease_seconds, revision) VALUES (1, 120, 1);

CREATE TABLE qq_dispatch_candidates (
  conversation_key TEXT NOT NULL PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES qq_bindings(id),
  event_key TEXT REFERENCES qq_events(event_key),
  path TEXT NOT NULL CHECK (path IN ('direct_reply', 'follow_up', 'chiming_in', 'idle_topic')),
  ready_at_seconds INTEGER NOT NULL CHECK (ready_at_seconds >= 0),
  observed_at_seconds INTEGER NOT NULL CHECK (observed_at_seconds >= 0),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  claimed_generation INTEGER,
  CHECK (claimed_generation IS NULL OR (claimed_generation >= 1 AND claimed_generation <= generation))
);
CREATE INDEX ix_qq_dispatch_ready ON qq_dispatch_candidates(ready_at_seconds, conversation_key);

CREATE TABLE qq_dispatch_lease (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  token TEXT,
  conversation_key TEXT REFERENCES qq_dispatch_candidates(conversation_key),
  generation INTEGER,
  expires_at_seconds INTEGER,
  CHECK ((token IS NULL AND conversation_key IS NULL AND generation IS NULL AND expires_at_seconds IS NULL)
      OR (token IS NOT NULL AND length(token) > 0 AND conversation_key IS NOT NULL
          AND generation >= 1 AND expires_at_seconds >= 0))
);
INSERT INTO qq_dispatch_lease (id) VALUES (1);
