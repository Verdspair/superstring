-- P5m: how long a failed addressed media read keeps waiting for a supplement.
--
-- §7.1/§7.2: a picture that was addressed to the assistant and could not be read stays silent in
-- the conversation, and one more understanding is attempted when a RELATED supplement arrives.
-- The user decided on 2026-09-24 what "related" means — the same speaker, within this window —
-- and that the window is a scheme parameter with a 10-minute default rather than a fixed number.
--
-- 0 means "do not wait": the addressed read may still happen once, but nothing wakes it again.
-- That is the same shape as §9.3's "0 = 不限" intervals, kept so an operator can turn the wait off
-- without turning the first read off.
--
-- The column lives beside the rhythm numbers because that group already carries the numeric
-- limits that the 媒体与表达 section edits (`max_sticker_count` is there for the same reason); the
-- stored value is per scheme, i.e. per bound conversation.
ALTER TABLE qq_schemes ADD COLUMN media_supplement_window_minutes INTEGER NOT NULL DEFAULT 10 CHECK (media_supplement_window_minutes >= 0 AND media_supplement_window_minutes <= 1440);

-- Whether the message that carried this segment was addressed to the assistant (§7.1/§7.2).
--
-- The supplement rule only ever wakes an addressed read, and until now "was it addressed" was a
-- fact of the delivery rather than of the row: the reader received it as an argument and nothing
-- remembered it. That is enough for the first read but not for the second one, which happens on a
-- LATER message and must not be offered to a segment whose original question nobody asked.
--
-- Nullable on purpose, like every column appended to a populated table: rows written before this
-- migration keep the weaker fact they really have (unknown), and "unknown" is read as "not
-- addressed" by the supplement lookup — the conservative direction, since the cost of the other
-- choice is retrying media nobody asked about.
ALTER TABLE qq_media_notes ADD COLUMN addressed INTEGER CHECK (addressed IN (0, 1));
