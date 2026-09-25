-- The four speech triggers a scheme carries (ADR0018 P5a).
--
-- User decision (2026-09-23): the trigger switches live in the scheme, not on the binding.
-- §5.2 already groups the four speech paths as the scheme's own field groups, and a scheme
-- that cannot say how its assistant speaks would describe only half of itself. Changing them
-- therefore follows the scheme's own discipline: edit and save as a new scheme, then rebind.
--
-- They arrive before the rest of the scheme's parameters on purpose. A switch is a decision
-- that has already been made — "turning one off stops new triggers of that kind and blocks
-- content of that kind that has not been sent yet" is confirmed behaviour — while the
-- windows, cooldowns and idle times around them are still pending. Adding the switch that
-- exists is honest; freezing four numbers that do not is not.
--
-- Every one defaults to 0. That is the same stance the project already takes for a freshly
-- bound conversation, which does not spend model calls on automatic organisation until the
-- user asks: binding a scheme must not make an assistant start talking on its own. Speaking
-- is something the user switches on, and a new scheme is quiet.

ALTER TABLE qq_schemes ADD COLUMN trigger_direct_reply INTEGER NOT NULL DEFAULT 0 CHECK (trigger_direct_reply IN (0, 1));
ALTER TABLE qq_schemes ADD COLUMN trigger_follow_up INTEGER NOT NULL DEFAULT 0 CHECK (trigger_follow_up IN (0, 1));
ALTER TABLE qq_schemes ADD COLUMN trigger_chiming_in INTEGER NOT NULL DEFAULT 0 CHECK (trigger_chiming_in IN (0, 1));
ALTER TABLE qq_schemes ADD COLUMN trigger_idle_topic INTEGER NOT NULL DEFAULT 0 CHECK (trigger_idle_topic IN (0, 1));
