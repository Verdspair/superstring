CREATE INDEX ix_context_snapshot_storage_metadata ON context_snapshots(step_id,status,expires_at,(protected_messages IS NOT NULL OR protected_output IS NOT NULL));
CREATE INDEX ix_runtime_storage_metadata ON runtime_spans(user_id,trace_id,conversation_id,expires_at,status);
