-- The four speech triggers a scheme carries (ADR0018 P5a).
--
-- The trigger switches belong to the scheme rather than to the binding.
-- They describe the four speech paths alongside the scheme parameters.
-- A binding selects a scheme; these columns describe whether each speech path
-- is enabled for that scheme.
--
-- Turning off a speech trigger stops new triggers of that kind and blocks
-- content of that kind that has not been sent yet. These switches are stored
-- independently of windows, cooldowns and idle times: enabling a speech path
-- and limiting when it may run are different scheme settings. Each speech
-- path has its own boolean column.
--
-- Every one defaults to 0. That is the same stance the project already takes for a freshly
-- bound conversation, which does not spend model calls on automatic organisation until the
-- user asks: binding a scheme must not make an assistant start talking on its own. Speaking
-- is something the user switches on, and a new scheme is quiet.

ALTER TABLE qq_schemes ADD COLUMN trigger_direct_reply INTEGER NOT NULL DEFAULT 0 CHECK (trigger_direct_reply IN (0, 1));
ALTER TABLE qq_schemes ADD COLUMN trigger_follow_up INTEGER NOT NULL DEFAULT 0 CHECK (trigger_follow_up IN (0, 1));
ALTER TABLE qq_schemes ADD COLUMN trigger_chiming_in INTEGER NOT NULL DEFAULT 0 CHECK (trigger_chiming_in IN (0, 1));
ALTER TABLE qq_schemes ADD COLUMN trigger_idle_topic INTEGER NOT NULL DEFAULT 0 CHECK (trigger_idle_topic IN (0, 1));
