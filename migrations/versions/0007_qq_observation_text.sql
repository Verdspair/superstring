-- QQ observation text and processed markers (ADR0018 P2d).
--
-- Retention decision (user, 2026-09-22): QQ message text is kept for two weeks by
-- default, and the received media cache is cleaned on the same clock.
--
-- Message text lives in its own table on purpose. `qq_events.event_key` is the
-- permanent dedup identity and the target of `qq_memory_sources`, so expiring a
-- body must NOT touch it: after expiry a message simply stops being re-readable,
-- while a memory keeps its provenance and stays valid. Deleting the text row is
-- therefore never a source-invalidating event.
--
-- `qq_processed_events` mirrors `memory_processed_turns`: it records that a batch of
-- observations has been offered to consolidation, so the same messages are not
-- re-submitted forever. It is deliberately NOT part of the text table, because it
-- has to outlive the two-week window.

CREATE TABLE qq_observation_text (
  event_key TEXT NOT NULL PRIMARY KEY REFERENCES qq_events (event_key) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  occurred_at_seconds INTEGER NOT NULL CHECK (occurred_at_seconds >= 0),
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX ix_qq_observation_expiry ON qq_observation_text (expires_at);

CREATE TABLE qq_processed_events (
  event_key TEXT NOT NULL PRIMARY KEY REFERENCES qq_events (event_key) ON DELETE CASCADE,
  processed_at TEXT NOT NULL
);
