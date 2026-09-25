-- P5s: the global slot must be able to name an immediate task.
--
-- The slot was built for the queued path, where a holder always owns a candidate generation:
-- `conversation_key` referenced `qq_dispatch_candidates` and the CHECK demanded `generation >= 1`.
-- 直接回应 and 连续交谈 are deliberately NOT candidates — they must not wait behind another
-- conversation's merge window — yet they run under the same "one QQ model chain at a time" rule.
-- A holder without a candidate therefore has to be expressible.
--
-- The rebuild drops the foreign key (the real guard was always the explicit candidate lookup inside
-- the claim transaction, which the queued path still does) and drops `generation >= 1`, while
-- keeping the all-or-nothing discipline: the row is either empty or names a live owner with a token
-- and an expiry. `conversation_key` stays, because it is what lets a new claim clear the stale
-- claim marker a dead owner left on a candidate.
CREATE TABLE qq_dispatch_lease_v28 (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  token TEXT,
  conversation_key TEXT,
  generation INTEGER,
  expires_at_seconds INTEGER,
  CHECK ((token IS NULL AND conversation_key IS NULL AND generation IS NULL AND expires_at_seconds IS NULL)
      OR (token IS NOT NULL AND length(token) > 0 AND conversation_key IS NOT NULL
          AND expires_at_seconds >= 0))
);

INSERT INTO qq_dispatch_lease_v28 (id, token, conversation_key, generation, expires_at_seconds)
  SELECT id, token, conversation_key, generation, expires_at_seconds FROM qq_dispatch_lease;

DROP TABLE qq_dispatch_lease;
ALTER TABLE qq_dispatch_lease_v28 RENAME TO qq_dispatch_lease;
