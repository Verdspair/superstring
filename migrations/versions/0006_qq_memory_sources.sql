-- Observation-backed memory sources (ADR0018 P2b).
--
-- Web memory keeps using `memory_sources` (a paired user/assistant turn). A QQ
-- conversation has messages that are observations, not turns, so those memories
-- need their own provenance table: it cannot reuse `memory_sources`, whose
-- composite primary key is (memory_id, turn_id) with a NOT NULL foreign key into
-- `turns`, and `turn_id` never exists for a group member's message.
--
-- The row points at a `qq_events` dedup key instead of a turn, and that reference
-- is deliberately NOT cascading: expiring observations must never silently orphan a
-- memory's provenance, so a retention pass has to deal with referenced keys
-- explicitly rather than deleting the evidence a memory still depends on.

CREATE TABLE qq_memory_sources (
  memory_id TEXT NOT NULL REFERENCES memory_entries (id) ON DELETE CASCADE,
  event_key TEXT NOT NULL REFERENCES qq_events (event_key),
  scope_key TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  message_id TEXT NOT NULL CHECK (length(message_id) > 0),
  occurred_at_seconds INTEGER NOT NULL CHECK (occurred_at_seconds >= 0),
  speaker_kind TEXT NOT NULL CHECK (speaker_kind IN ('member', 'anonymous', 'system')),
  speaker_id TEXT,
  PRIMARY KEY (memory_id, event_key),
  CHECK ((speaker_kind = 'member') = (speaker_id IS NOT NULL))
);
CREATE INDEX ix_qq_memory_source_event ON qq_memory_sources (event_key);
