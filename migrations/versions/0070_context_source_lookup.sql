-- Derived membership index. source_refs remains the source of truth.
CREATE TABLE context_snapshot_source_refs (
  step_id TEXT NOT NULL REFERENCES context_snapshots(step_id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY(step_id,source_kind,source_id)
) WITHOUT ROWID;

CREATE TRIGGER index_context_snapshot_sources_insert AFTER INSERT ON context_snapshots
BEGIN
  INSERT OR IGNORE INTO context_snapshot_source_refs(step_id,source_kind,source_id)
  SELECT NEW.step_id,json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.kind'),json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.id')
  FROM jsonb_each(NEW.source_refs) r
  WHERE NEW.status='exact'
    AND typeof(json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.kind'))='text'
    AND typeof(json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.id'))='text'
    AND json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.kind') IN ('knowledge_document','knowledge_grant','memory','outbound_intent','qq_media','qq_observation','qq_speech','qq_sticker','web_turn');
  INSERT OR IGNORE INTO context_snapshot_source_refs(step_id,source_kind,source_id)
  SELECT NEW.step_id,'__malformed_json',''
  FROM jsonb_each(NEW.source_refs) r
  WHERE NEW.status='exact' AND r.type='text' AND NOT json_valid(r.value,6);
END;
CREATE TRIGGER index_context_snapshot_sources_update
AFTER UPDATE OF source_refs,status ON context_snapshots
BEGIN
  DELETE FROM context_snapshot_source_refs WHERE step_id=OLD.step_id;
  INSERT OR IGNORE INTO context_snapshot_source_refs(step_id,source_kind,source_id)
  SELECT NEW.step_id,json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.kind'),json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.id')
  FROM jsonb_each(NEW.source_refs) r
  WHERE NEW.status='exact'
    AND typeof(json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.kind'))='text'
    AND typeof(json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.id'))='text'
    AND json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.kind') IN ('knowledge_document','knowledge_grant','memory','outbound_intent','qq_media','qq_observation','qq_speech','qq_sticker','web_turn');
  INSERT OR IGNORE INTO context_snapshot_source_refs(step_id,source_kind,source_id)
  SELECT NEW.step_id,'__malformed_json',''
  FROM jsonb_each(NEW.source_refs) r
  WHERE NEW.status='exact' AND r.type='text' AND NOT json_valid(r.value,6);
END;

INSERT OR IGNORE INTO context_snapshot_source_refs(step_id,source_kind,source_id)
SELECT c.step_id,json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.kind'),json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.id')
FROM context_snapshots c,jsonb_each(c.source_refs) r
WHERE c.status='exact'
  AND typeof(json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.kind'))='text'
  AND typeof(json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.id'))='text'
  AND json_extract(CASE WHEN json_valid(r.value,6) THEN r.value ELSE '{}' END,'$.kind') IN ('knowledge_document','knowledge_grant','memory','outbound_intent','qq_media','qq_observation','qq_speech','qq_sticker','web_turn');

INSERT OR IGNORE INTO context_snapshot_source_refs(step_id,source_kind,source_id)
SELECT c.step_id,'__malformed_json',''
FROM context_snapshots c,jsonb_each(c.source_refs) r
WHERE c.status='exact' AND r.type='text' AND NOT json_valid(r.value,6);

CREATE INDEX ix_context_snapshot_source_lookup
  ON context_snapshot_source_refs(source_kind,source_id,step_id);

DROP TRIGGER revoke_agent_context_web_turn_delete;
DROP TRIGGER revoke_agent_context_web_turn_invalid;
DROP TRIGGER revoke_agent_context_memory_delete;
DROP TRIGGER revoke_agent_context_memory_hide;
DROP TRIGGER revoke_agent_context_document_delete;
DROP TRIGGER revoke_agent_context_document_revision;
DROP TRIGGER revoke_agent_context_grant;
DROP TRIGGER expire_agent_context_qq_text;
DROP TRIGGER expire_agent_context_qq_media;
DROP TRIGGER expire_agent_context_qq_speech;
DROP TRIGGER revoke_agent_context_qq_event;
DROP TRIGGER revoke_agent_context_qq_sticker;
DROP TRIGGER revoke_agent_context_qq_sticker_revision;
DROP TRIGGER redact_agent_context_outbound_delete;
DROP TRIGGER redact_agent_context_outbound_part_delete;
DROP TRIGGER redact_agent_context_outbound_part_change;

CREATE TRIGGER revoke_agent_context_web_turn_delete AFTER DELETE ON turns

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='web_turn' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='web_turn' AND source_id=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_web_turn_invalid AFTER UPDATE OF source_valid,context_valid ON turns
WHEN NEW.source_valid=0 OR NEW.context_valid=0
BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='web_turn' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='web_turn' AND source_id=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_memory_delete AFTER DELETE ON memory_entries

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='memory' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='memory' AND source_id=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_memory_hide AFTER UPDATE OF status ON memory_entries
WHEN NEW.status IN ('invalid','suppressed','replaced')
BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='memory' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='memory' AND source_id=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_document_delete AFTER DELETE ON knowledge_documents

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='knowledge_document' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='knowledge_document' AND source_id=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_document_revision AFTER UPDATE OF content_version ON knowledge_documents
WHEN NEW.content_version<>OLD.content_version
BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='knowledge_document' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='knowledge_document' AND source_id=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_grant AFTER DELETE ON knowledge_grants

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='knowledge_grant' AND json_extract(r.value,'$.id')=json_array(OLD.document_id,OLD.agent_id));
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='knowledge_grant' AND source_id=json_array(OLD.document_id,OLD.agent_id));
END;

CREATE TRIGGER expire_agent_context_qq_text AFTER DELETE ON qq_observation_text

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='qq_observation' AND json_extract(r.value,'$.id')=OLD.event_key);
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='qq_observation' AND source_id=OLD.event_key);
END;

CREATE TRIGGER expire_agent_context_qq_media AFTER DELETE ON qq_media_notes

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='qq_media' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='qq_media' AND source_id=OLD.id);
END;

CREATE TRIGGER expire_agent_context_qq_speech AFTER DELETE ON qq_speech_text

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='qq_speech' AND json_extract(r.value,'$.id')=OLD.speech_id);
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='qq_speech' AND source_id=OLD.speech_id);
END;

CREATE TRIGGER revoke_agent_context_qq_event AFTER DELETE ON qq_events

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='qq_observation' AND json_extract(r.value,'$.id')=OLD.event_key);
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='qq_observation' AND source_id=OLD.event_key);
END;

CREATE TRIGGER revoke_agent_context_qq_sticker AFTER DELETE ON qq_sticker_assets

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='qq_sticker' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='qq_sticker' AND source_id=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_qq_sticker_revision AFTER UPDATE OF updated_at ON qq_sticker_assets
WHEN NEW.updated_at<>OLD.updated_at
BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='qq_sticker' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='qq_sticker' AND source_id=OLD.id);
END;

CREATE TRIGGER redact_agent_context_outbound_delete AFTER DELETE ON outbound_intents

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='outbound_intent' AND json_extract(r.value,'$.id')=OLD.id);
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='outbound_intent' AND source_id=OLD.id);
END;

CREATE TRIGGER redact_agent_context_outbound_part_delete AFTER DELETE ON outbound_parts

BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='outbound_intent' AND json_extract(r.value,'$.id')=OLD.intent_id);
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='outbound_intent' AND source_id=OLD.intent_id);
END;

CREATE TRIGGER redact_agent_context_outbound_part_change AFTER UPDATE OF payload,status ON outbound_parts
WHEN NEW.payload IS NOT OLD.payload OR NEW.status IS NOT OLD.status
BEGIN
  SELECT 1 FROM context_snapshots c
  WHERE c.status='exact' AND c.step_id IN (
    SELECT step_id FROM context_snapshot_source_refs WHERE source_kind='__malformed_json'
  ) AND EXISTS (SELECT 1 FROM jsonb_each(c.source_refs) r WHERE json_extract(r.value,'$.kind')='outbound_intent' AND json_extract(r.value,'$.id')=OLD.intent_id);
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND step_id IN (SELECT step_id FROM context_snapshot_source_refs
    WHERE source_kind='outbound_intent' AND source_id=OLD.intent_id);
END;
