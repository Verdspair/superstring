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
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='web_turn' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_web_turn_invalid AFTER UPDATE OF source_valid,context_valid ON turns
WHEN NEW.source_valid=0 OR NEW.context_valid=0
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='web_turn' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_memory_delete AFTER DELETE ON memory_entries

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='memory' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_memory_hide AFTER UPDATE OF status ON memory_entries
WHEN NEW.status IN ('invalid','suppressed','replaced')
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='memory' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_document_delete AFTER DELETE ON knowledge_documents

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='knowledge_document' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_document_revision AFTER UPDATE OF content_version ON knowledge_documents
WHEN NEW.content_version<>OLD.content_version
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='knowledge_document' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_grant AFTER DELETE ON knowledge_grants

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='knowledge_grant' AND json_extract(r.value,'$.id')=json_array(OLD.document_id,OLD.agent_id));
END;

CREATE TRIGGER expire_agent_context_qq_text AFTER DELETE ON qq_observation_text

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_observation' AND json_extract(r.value,'$.id')=OLD.event_key);
END;

CREATE TRIGGER expire_agent_context_qq_media AFTER DELETE ON qq_media_notes

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_media' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER expire_agent_context_qq_speech AFTER DELETE ON qq_speech_text

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_speech' AND json_extract(r.value,'$.id')=OLD.speech_id);
END;

CREATE TRIGGER revoke_agent_context_qq_event AFTER DELETE ON qq_events

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_observation' AND json_extract(r.value,'$.id')=OLD.event_key);
END;

CREATE TRIGGER revoke_agent_context_qq_sticker AFTER DELETE ON qq_sticker_assets

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_sticker' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER revoke_agent_context_qq_sticker_revision AFTER UPDATE OF updated_at ON qq_sticker_assets
WHEN NEW.updated_at<>OLD.updated_at
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='revoked'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='qq_sticker' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER redact_agent_context_outbound_delete AFTER DELETE ON outbound_intents

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='outbound_intent' AND json_extract(r.value,'$.id')=OLD.id);
END;

CREATE TRIGGER redact_agent_context_outbound_part_delete AFTER DELETE ON outbound_parts

BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='outbound_intent' AND json_extract(r.value,'$.id')=OLD.intent_id);
END;

CREATE TRIGGER redact_agent_context_outbound_part_change AFTER UPDATE OF payload,status ON outbound_parts
WHEN NEW.payload IS NOT OLD.payload OR NEW.status IS NOT OLD.status
BEGIN
  UPDATE context_snapshots SET protected_messages=NULL,status='expired'
  WHERE status='exact' AND EXISTS (SELECT 1 FROM jsonb_each(source_refs) r WHERE json_extract(r.value,'$.kind')='outbound_intent' AND json_extract(r.value,'$.id')=OLD.intent_id);
END;
