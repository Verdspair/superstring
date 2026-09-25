-- Unified inference records. Conversation/wake references are added in 0040.
CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  spec_id TEXT NOT NULL,
  spec_version TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  user_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('prepared','deciding','observing','generating','completed','no_output','failed','cancelled')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_code TEXT
);
CREATE INDEX ix_agent_runs_owner ON agent_runs(owner_kind, owner_id, started_at);
CREATE INDEX ix_agent_runs_user ON agent_runs(user_id, started_at);

CREATE TABLE agent_steps (
  step_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL CHECK (step_no > 0),
  model TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('leaf','next','generate','vision')),
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_code TEXT,
  decision TEXT,
  UNIQUE(run_id, step_no)
);
CREATE TABLE context_snapshots (
  step_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_steps(step_id) ON DELETE CASCADE,
  source_refs TEXT NOT NULL CHECK (json_valid(source_refs)),
  layout TEXT NOT NULL CHECK (json_valid(layout)),
  expires_at TEXT,
  protected_messages TEXT CHECK (protected_messages IS NULL OR json_valid(protected_messages)),
  status TEXT NOT NULL CHECK (status IN ('exact','expired','revoked'))
);
CREATE INDEX ix_context_snapshots_expiry ON context_snapshots(expires_at);
CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY(run_id, seq)
);

-- A source mutation removes copied diagnostic text in the same transaction.
CREATE TRIGGER revoke_agent_context_web_turn_delete AFTER DELETE ON turns

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='web_turn' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_web_turn_invalid AFTER UPDATE OF source_valid,context_valid ON turns
WHEN NEW.source_valid=0 OR NEW.context_valid=0
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='web_turn' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_memory_delete AFTER DELETE ON memory_entries

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='memory' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_memory_hide AFTER UPDATE OF status ON memory_entries
WHEN NEW.status='invalid'
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='memory' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_document_delete AFTER DELETE ON knowledge_documents

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='knowledge_document' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_document_revision AFTER UPDATE OF content_version ON knowledge_documents
WHEN NEW.content_version<>OLD.content_version
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='knowledge_document' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_grant AFTER DELETE ON knowledge_grants

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='knowledge_grant' AND json_extract(r.value,'$.id')=json_array(OLD.document_id,OLD.agent_id));
END;

CREATE TRIGGER expire_agent_context_qq_text AFTER DELETE ON qq_observation_text

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_observation' AND json_extract(r.value,'$.id')=OLD.event_key);
END;

CREATE TRIGGER expire_agent_context_qq_media AFTER DELETE ON qq_media_notes

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_media' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER expire_agent_context_qq_speech AFTER DELETE ON qq_speech_text

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_speech' AND json_extract(r.value,'$.id')=OLD.speech_id);
END;

CREATE TRIGGER revoke_agent_context_qq_event AFTER DELETE ON qq_events

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_observation' AND json_extract(r.value,'$.id')=OLD.event_key);
END;

CREATE TRIGGER revoke_agent_context_qq_sticker AFTER DELETE ON qq_sticker_assets

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_sticker' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER redact_agent_context_control AFTER UPDATE OF protected_messages ON context_snapshots
WHEN NEW.protected_messages IS NULL
BEGIN
  UPDATE agent_steps SET decision=NULL WHERE step_id=NEW.step_id;
END;
CREATE TRIGGER revoke_agent_context_owner AFTER DELETE ON agents
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (
    SELECT s.step_id FROM agent_steps s JOIN agent_runs r ON r.run_id=s.run_id WHERE r.agent_id=OLD.id
  );
END;
