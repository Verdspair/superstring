-- Cadence defer: earliest instant a deferred pending task may be claimed again.
ALTER TABLE qq_conversation_tasks ADD COLUMN ready_at TEXT;
