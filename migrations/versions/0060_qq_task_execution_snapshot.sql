-- Claim-time immutable task execution snapshot and its durable claim instant.
ALTER TABLE qq_conversation_tasks ADD COLUMN execution_snapshot TEXT
  CHECK (execution_snapshot IS NULL OR (json_valid(execution_snapshot) AND json_type(execution_snapshot) = 'object'));
ALTER TABLE qq_conversation_tasks ADD COLUMN claimed_at TEXT;
