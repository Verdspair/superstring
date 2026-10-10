CREATE INDEX ix_outbound_legacy_send_conversation ON outbound_intents(legacy_send_id, conversation_id) WHERE legacy_send_id IS NOT NULL;
CREATE INDEX ix_conversation_send_speech_source ON conversation_events(conversation_id, json_extract(sources, '$[1].id')) WHERE source_kind = 'qq_send' AND json_extract(sources, '$[1].kind') = 'qq_speech';
