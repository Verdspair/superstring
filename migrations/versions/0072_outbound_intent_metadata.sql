-- Small query metadata; target remains the immutable delivery authority and provenance.
-- BLOB affinity preserves json_extract storage types without text/number coercion.
CREATE TABLE outbound_intent_metadata (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES outbound_intents(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  output_ordinal INTEGER NOT NULL,
  speech_kind TEXT NOT NULL,
  source_through_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  qq_task_id BLOB,
  account_id BLOB,
  conversation_kind BLOB,
  peer_id BLOB,
  participant_id BLOB,
  binding_id BLOB,
  binding_epoch BLOB,
  agent_id BLOB,
  authority_revision BLOB,
  observed_through_seq BLOB
) WITHOUT ROWID;
CREATE INDEX ix_outbound_metadata_task ON outbound_intent_metadata(qq_task_id,conversation_id,intent_id);
CREATE INDEX ix_outbound_metadata_conversation_time ON outbound_intent_metadata(conversation_id,created_at,output_ordinal,intent_id);

INSERT INTO outbound_intent_metadata(intent_id,run_id,conversation_id,output_ordinal,speech_kind,source_through_seq,status,created_at,expires_at,qq_task_id,account_id,conversation_kind,peer_id,participant_id,binding_id,binding_epoch,agent_id,authority_revision,observed_through_seq)
SELECT id,run_id,conversation_id,output_ordinal,speech_kind,source_through_seq,status,created_at,expires_at,json_extract(target,'$.qqTaskId'),json_extract(target,'$.accountId'),json_extract(target,'$.conversationKind'),json_extract(target,'$.peerId'),json_extract(target,'$.participantId'),json_extract(target,'$.bindingId'),json_extract(target,'$.bindingEpoch'),json_extract(target,'$.agentId'),json_extract(target,'$.authorityRevision'),json_extract(target,'$.observedThroughSeq') FROM outbound_intents;

CREATE TRIGGER project_outbound_metadata_insert AFTER INSERT ON outbound_intents
BEGIN
  INSERT INTO outbound_intent_metadata(intent_id,run_id,conversation_id,output_ordinal,speech_kind,source_through_seq,status,created_at,expires_at,qq_task_id,account_id,conversation_kind,peer_id,participant_id,binding_id,binding_epoch,agent_id,authority_revision,observed_through_seq)
  VALUES(NEW.id,NEW.run_id,NEW.conversation_id,NEW.output_ordinal,NEW.speech_kind,NEW.source_through_seq,NEW.status,NEW.created_at,NEW.expires_at,json_extract(NEW.target,'$.qqTaskId'),json_extract(NEW.target,'$.accountId'),json_extract(NEW.target,'$.conversationKind'),json_extract(NEW.target,'$.peerId'),json_extract(NEW.target,'$.participantId'),json_extract(NEW.target,'$.bindingId'),json_extract(NEW.target,'$.bindingEpoch'),json_extract(NEW.target,'$.agentId'),json_extract(NEW.target,'$.authorityRevision'),json_extract(NEW.target,'$.observedThroughSeq'));
END;

CREATE TRIGGER project_outbound_metadata_target_update
AFTER UPDATE OF target ON outbound_intents
BEGIN
  UPDATE outbound_intent_metadata SET
    qq_task_id=json_extract(NEW.target,'$.qqTaskId'),
    account_id=json_extract(NEW.target,'$.accountId'),
    conversation_kind=json_extract(NEW.target,'$.conversationKind'),
    peer_id=json_extract(NEW.target,'$.peerId'),
    participant_id=json_extract(NEW.target,'$.participantId'),
    binding_id=json_extract(NEW.target,'$.bindingId'),
    binding_epoch=json_extract(NEW.target,'$.bindingEpoch'),
    agent_id=json_extract(NEW.target,'$.agentId'),
    authority_revision=json_extract(NEW.target,'$.authorityRevision'),
    observed_through_seq=json_extract(NEW.target,'$.observedThroughSeq')
  WHERE intent_id=NEW.id;
END;

CREATE TRIGGER project_outbound_metadata_fields_update
AFTER UPDATE OF run_id,conversation_id,output_ordinal,speech_kind,source_through_seq,status,created_at,expires_at ON outbound_intents
BEGIN
  UPDATE outbound_intent_metadata SET
    run_id=NEW.run_id,
    conversation_id=NEW.conversation_id,
    output_ordinal=NEW.output_ordinal,
    speech_kind=NEW.speech_kind,
    source_through_seq=NEW.source_through_seq,
    status=NEW.status,
    created_at=NEW.created_at,
    expires_at=NEW.expires_at
  WHERE intent_id=NEW.id;
END;
