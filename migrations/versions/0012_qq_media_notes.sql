-- Media attachments: what a picture or a voice message was read as (ADR0018 P4b).
--
-- A message can carry several media segments, so the attachment is keyed by the message's
-- permanent dedup identity plus the segment's position in it. The identity is the same
-- `qq_events.event_key` a memory's provenance points at, which is why this is a child of
-- that table rather than of the text: losing the text does not lose the reading.
--
-- What is NOT stored: the bytes. `source_ref` keeps only the reference OneBot gave (the
-- `file` value or its URL), so the media cache stays a cache and can follow the retention
-- window; nothing here needs the file to stay valid, because the note is already written.
--
-- The description is model output and is labelled as such: a row with a note must name the
-- model that produced it. That CHECK is the schema-level half of "never masquerade a
-- generated description as the member's own words"; the other half is that the note never
-- becomes a message body.
--
-- `attempts` is capped at 2 because the plan fixes that count (first read, then one more
-- after a related supplement, then silence). It is this media's own counter and is never
-- shared with the reply-regeneration budget, so the two cannot loop each other.

CREATE TABLE qq_media_notes (
  id TEXT NOT NULL PRIMARY KEY,
  event_key TEXT NOT NULL REFERENCES qq_events (event_key) ON DELETE CASCADE,
  segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
  segment_kind TEXT NOT NULL CHECK (segment_kind IN ('image', 'record', 'video', 'file')),
  source_ref TEXT NOT NULL CHECK (length(trim(source_ref)) > 0),
  note TEXT,
  note_model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 2),
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (note IS NULL OR note_model IS NOT NULL)
);
CREATE UNIQUE INDEX uq_qq_media_segment ON qq_media_notes (event_key, segment_index);
CREATE INDEX ix_qq_media_expiry ON qq_media_notes (expires_at);
