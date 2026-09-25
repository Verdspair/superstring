-- Scheme rhythm parameters (ADR0018 P3b-1).
--
-- §5.2's field groups were "design labels, not frozen API fields" and every value in them
-- was pending, which is why 0010 stored no parameter at all. The user has now fixed the
-- values, so they can be written down — as columns on the scheme, the layer P5a chose for
-- the four speech switches, so a scheme describes how this assistant talks.
--
-- Units are in the column names on purpose (seconds / minutes / count): the plan mixes
-- second, minute and clock values, and a bare `window` would be read as whichever unit the
-- reader happened to assume.
--
-- Every column is NOT NULL with a default, and every range is a column-level CHECK. Two
-- consequences worth naming:
--   * an existing scheme (created before this migration) gets the defaults, which are
--     exactly the values a new scheme gets — nothing has to be backfilled by hand; and
--   * the allowed-hours bounds are NOT nullable. "Not limited" is `active_hours_enabled = 0`
--     with a placeholder window, rather than a null pair, so no cross-column CHECK is needed
--     and a direct SQL write cannot create a half-recorded window.
--
--   merge_window_seconds     0..300    how long to let consecutive messages accumulate
--                                      before judging (0 = judge each message at once)
--   reply_cooldown_seconds   1..600    minimum gap between two unprompted utterances
--   hourly_speech_limit      1..500    cap on unprompted utterances per rolling hour
--   idle_quiet_minutes       1..1000   quiet time before opening a topic into silence
--   active_hours_enabled               0 = no allowed-hours window at all (the default)
--   active_hours_*_minutes   0..1439   minutes since local midnight; 0/1439 = all day
--   max_recompute_count      0..2      §5.1: at most one recompute by default, adjustable
--   max_sticker_count        1..3      §8.1-4: stickers per reply
--
-- The three limits that only bind unprompted speech (cooldown, hourly cap, allowed hours)
-- were decided to leave direct replies alone (user decision 2026-09-23): being addressed
-- must be answerable at any hour, or the assistant looks broken in the one case where an
-- answer is unambiguously expected. Where that is applied lives in qq-rhythm-contract.ts.

ALTER TABLE qq_schemes ADD COLUMN merge_window_seconds INTEGER NOT NULL DEFAULT 30 CHECK (merge_window_seconds >= 0 AND merge_window_seconds <= 300);
ALTER TABLE qq_schemes ADD COLUMN reply_cooldown_seconds INTEGER NOT NULL DEFAULT 10 CHECK (reply_cooldown_seconds >= 1 AND reply_cooldown_seconds <= 600);
ALTER TABLE qq_schemes ADD COLUMN hourly_speech_limit INTEGER NOT NULL DEFAULT 200 CHECK (hourly_speech_limit >= 1 AND hourly_speech_limit <= 500);
ALTER TABLE qq_schemes ADD COLUMN idle_quiet_minutes INTEGER NOT NULL DEFAULT 15 CHECK (idle_quiet_minutes >= 1 AND idle_quiet_minutes <= 1000);
ALTER TABLE qq_schemes ADD COLUMN active_hours_enabled INTEGER NOT NULL DEFAULT 0 CHECK (active_hours_enabled IN (0, 1));
ALTER TABLE qq_schemes ADD COLUMN active_hours_start_minutes INTEGER NOT NULL DEFAULT 0 CHECK (active_hours_start_minutes >= 0 AND active_hours_start_minutes <= 1439);
ALTER TABLE qq_schemes ADD COLUMN active_hours_end_minutes INTEGER NOT NULL DEFAULT 1439 CHECK (active_hours_end_minutes >= 0 AND active_hours_end_minutes <= 1439);
ALTER TABLE qq_schemes ADD COLUMN max_recompute_count INTEGER NOT NULL DEFAULT 1 CHECK (max_recompute_count >= 0 AND max_recompute_count <= 2);
ALTER TABLE qq_schemes ADD COLUMN max_sticker_count INTEGER NOT NULL DEFAULT 1 CHECK (max_sticker_count >= 1 AND max_sticker_count <= 3);
