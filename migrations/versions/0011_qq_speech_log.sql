-- The assistant's own utterances (ADR0018 P3a).
--
-- Why this table has to exist: OneBot delivers the assistant's own messages as
-- `message_sent`, which the protocol layer classifies as `self_message` and drops.
-- `qq_events` therefore contains only what OTHER people said, and there is no row
-- anywhere that says "the assistant spoke at T". The confirmed rule that an
-- initiative-taking speech which got no reply must not be followed by another one
-- ("do not keep asking") would have nothing to compare against, and would silently
-- reset on every restart.
--
-- What is stored is deliberately minimal: which conversation, which assistant, which
-- KIND of speech, and when. No text, no model output, no send result. Order alone
-- answers "did anyone speak after us", and the assistant's own words are the least
-- useful thing to keep.
--
-- `kind` covers the four independently controllable speech paths of the plan: a direct
-- reply, a continuation of the conversation, chiming in unprompted, and opening a topic
-- into silence. Only the last two take the initiative, and only those two are subject
-- to the no-reply rule (user decision 2026-09-23: a continuation is not).
--
-- `expires_at` follows the same single retention window as message text
-- (qq-retention.ts). Expiring a row can only mean that a very old initiative is
-- forgotten, which is acceptable: a conversation with no member message for that long
-- is not one the assistant will keep speaking into anyway.

CREATE TABLE qq_speech_log (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('group', 'private')),
  peer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('direct_reply', 'follow_up', 'chiming_in', 'idle_topic')),
  spoke_at_seconds INTEGER NOT NULL CHECK (spoke_at_seconds >= 0),
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX ix_qq_speech_conversation ON qq_speech_log (account_id, conversation_kind, peer_id, agent_id, spoke_at_seconds);
CREATE INDEX ix_qq_speech_expiry ON qq_speech_log (expires_at);
