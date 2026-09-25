CREATE TABLE outbound_intents (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  output_ordinal INTEGER NOT NULL CHECK(output_ordinal >= 0),
  target TEXT NOT NULL CHECK(json_valid(target)),
  speech_kind TEXT NOT NULL CHECK(speech_kind IN ('direct_reply','follow_up','chiming_in','idle_topic')),
  source_through_seq INTEGER NOT NULL CHECK(source_through_seq >= 0),
  deliver_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','delivering','confirmed','failed','unknown','stale')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  legacy_send_id TEXT,
  UNIQUE(run_id,output_ordinal)
);
CREATE INDEX ix_outbound_pending ON outbound_intents(status,created_at);
CREATE INDEX ix_outbound_conversation ON outbound_intents(conversation_id,created_at);
CREATE TABLE outbound_parts (
  id TEXT PRIMARY KEY NOT NULL,
  intent_id TEXT NOT NULL REFERENCES outbound_intents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('text','sticker')),
  payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
  status TEXT NOT NULL CHECK(status IN ('planned','sending','confirmed','failed','unknown','not_sent','stale')),
  platform_message_id TEXT,
  attempted_at TEXT,
  finished_at TEXT,
  UNIQUE(intent_id,ordinal)
);
CREATE INDEX ix_outbound_parts_status ON outbound_parts(status,intent_id,ordinal);

CREATE TRIGGER redact_agent_context_outbound_delete AFTER DELETE ON outbound_intents

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='outbound_intent' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER redact_agent_context_outbound_part_delete AFTER DELETE ON outbound_parts

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='outbound_intent' AND json_extract(r.value,'$.id')=OLD.intent_id);
END;

CREATE TRIGGER redact_agent_context_outbound_part_change AFTER UPDATE OF payload,status ON outbound_parts
WHEN NEW.payload IS NOT OLD.payload OR NEW.status IS NOT OLD.status
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM json_each(source_refs) r WHERE json_extract(r.value,'$.kind')='outbound_intent' AND json_extract(r.value,'$.id')=OLD.intent_id);
END;
