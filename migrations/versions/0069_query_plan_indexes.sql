CREATE INDEX idx_runtime_spans_wake ON runtime_spans(wake_id,id);
CREATE INDEX idx_runtime_spans_output ON runtime_spans(output_id,id);
CREATE INDEX ix_outbound_conversation_status ON outbound_intents(conversation_id,status);
CREATE INDEX ix_wake_conversation_status ON wake_signals(conversation_id,status);
