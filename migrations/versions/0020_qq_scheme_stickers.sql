-- QQ scheme sticker-library dedup settings (ADR0018 P4d). Additive; historical migrations
-- stay frozen. §9.3 makes both values scheme-level: they decide how often one sticker may
-- come back in a conversation, which is a property of the scheme's behaviour rather than of
-- the library's contents.
--
-- 0 is a real setting in both columns and means "no such limit": for the interval it is "no
-- minimum spacing", for the count it is "do not avoid recently used stickers". Both are
-- distinct from a default, which is why neither column is nullable — an absent value would
-- have to be guessed at read time.
ALTER TABLE qq_schemes ADD COLUMN sticker_min_repeat_minutes INTEGER NOT NULL DEFAULT 10 CHECK (sticker_min_repeat_minutes >= 0 AND sticker_min_repeat_minutes <= 1440);
ALTER TABLE qq_schemes ADD COLUMN sticker_recent_avoid_count INTEGER NOT NULL DEFAULT 5 CHECK (sticker_recent_avoid_count >= 0 AND sticker_recent_avoid_count <= 20);
