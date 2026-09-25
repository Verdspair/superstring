-- Member display names (ADR0018 P3c).
--
-- Why this exists: the timeline a judgement reads identified speakers by QQ number only, so a
-- judgement could tell that two different people spoke but not who they were, and a reply had
-- to avoid addressing anyone. The user decided (2026-09-23) to keep the nickname as a separate
-- table rather than a column on the message row.
--
-- Not scoped by assistant, deliberately. A nickname is a platform fact about a conversation,
-- not something one assistant observed about another: scoping it by `agent_id` would make two
-- assistants bound to the same group each store their own copy of the same name, and they
-- could disagree. `qq_events` carries `agent_id` because an observation belongs to whoever
-- made it; a display name belongs to the conversation.
--
-- Latest-seen semantics, not history: a rename overwrites the row, and `first_seen_at_seconds`
-- keeps only when this conversation first showed us that person. Keeping every past nickname
-- would be a second, unreviewed record of who said what under which name, which is more than
-- the feature needs and more than the retention window was designed for.
--
-- Identity and display name stay separate in both directions: the row is keyed by the stable
-- QQ number, and the timeline renderer prints the number alongside the name so a rename can
-- never make two messages from the same person look like they came from two people.
--
-- `expires_at` follows the same single retention window as message text (qq-retention.ts),
-- measured from the last time the conversation showed us that person. A nickname kept past the
-- window would outlive every message that could refer to it.

CREATE TABLE qq_members (
  account_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('group', 'private')),
  peer_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL CHECK (length(trim(nickname)) > 0 AND length(nickname) <= 64),
  first_seen_at_seconds INTEGER NOT NULL CHECK (first_seen_at_seconds >= 0),
  last_seen_at_seconds INTEGER NOT NULL CHECK (last_seen_at_seconds >= 0),
  expires_at TEXT NOT NULL CHECK (last_seen_at_seconds >= first_seen_at_seconds),
  PRIMARY KEY (account_id, conversation_kind, peer_id, user_id)
);
CREATE INDEX ix_qq_members_expiry ON qq_members (expires_at);
