-- P5u: every "it stayed silent" gets a recorded reason (§11.1 / F11 原因可追踪).
--
-- The quiet-room sweep already works out, for each bound conversation, why it did or did not
-- offer an opener: the switches, the no-reply rule ("an initiative nobody answered is not
-- followed by another"), the cooldown, the hourly cap, the allowed hours and the quiet window
-- itself. Until now those reasons were returned in memory and dropped by the caller, so a user
-- who switched 「冷场发起」 on and saw nothing happen could not tell "the room has not been quiet
-- long enough" from "the trigger is off in this group" from "the whole side is switched off".
--
-- This table is that record: ONE row per conversation, the last verdict the sweep reached about
-- it, rewritten on every pass (so `decided_at_seconds` answers "how long ago did it last look").
-- It is a diagnostic, not a schedule — nothing reads it to decide anything, and it holds no
-- draft, no message body and no credential. Conversations that are no longer bound are dropped
-- from it by the same pass, so the table cannot describe a group the user has disconnected.
CREATE TABLE qq_sweep_verdicts (
  conversation_key TEXT NOT NULL PRIMARY KEY,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('group', 'private')),
  peer_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('scheduled', 'skipped')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'feature_off', 'conversation_paused', 'trigger_off', 'no_member_baseline',
    'awaiting_reply', 'not_quiet_yet', 'cooling_down', 'hourly_limit',
    'outside_active_hours', 'candidate_pending')),
  -- The newest partner message the decision was based on, when it got that far.
  observed_at_seconds INTEGER CHECK (observed_at_seconds IS NULL OR observed_at_seconds >= 0),
  -- When the blocking gate said it would lift (the cooldown and quiet-window gates name a time;
  -- the others only lift when the situation changes, so they leave this NULL).
  ready_at_seconds INTEGER CHECK (ready_at_seconds IS NULL OR ready_at_seconds >= 0),
  decided_at_seconds INTEGER NOT NULL CHECK (decided_at_seconds >= 0),
  -- A scheduled verdict is "it decided to open a topic"; a skipped one must say why.
  CHECK ((outcome = 'scheduled' AND reason IS NULL)
      OR (outcome = 'skipped' AND reason IS NOT NULL))
);
CREATE INDEX ix_qq_sweep_verdicts_decided ON qq_sweep_verdicts(decided_at_seconds, conversation_key);
