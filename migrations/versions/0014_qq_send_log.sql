-- Send results for the assistant's own messages (ADR0018 P4c).
--
-- Why this table has to exist: the transport already classifies a receipt
-- (onebot-protocol.ts: confirmed / failed / unknown), and `qq_speech_log` (0011) already
-- records THAT the assistant spoke. Neither answers the question §8.2 asks — what the
-- platform actually accepted for one attempt, part by part. Without that row, "the
-- sticker failed but the text went through" and "nothing was ever submitted" look
-- identical, and §8.2 gives a different instruction for each.
--
-- `qq_send_log` is one attempt; `qq_send_part` is one platform request inside it. The
-- combination is not atomic at the platform: §8.1 composes what it can into a single
-- message, and a later request can fail after an earlier one was accepted. Hence a row
-- per part instead of one status column that would have to round the mixture to success
-- or failure.
--
-- `outcome` is the §8.2 row, derived from the parts by qq-output-contract.ts and stored
-- so the ledger stays readable without replaying the rule:
--   sent            every part confirmed
--   partially_sent  some confirmed, some not ("text sent, the sticker that followed was not")
--   sticker_failed  nothing confirmed, every part was a sticker
--   text_failed     nothing confirmed, words were involved (manual retry still undecided)
--   unknown         nothing confirmed, and at least one part's fate is unknown
--   not_submitted   no request reached the platform
--
-- `delivery_message_id` mirrors the first confirmed part so "which platform message
-- carries this reply" is one column away; the two CHECKs below keep it from disagreeing
-- with the parts it is derived from.
--
-- No message text is stored. §10 leaves whether full prompts and message bodies are kept
-- undecided, and a delivery record does not need the words to be useful.
--
-- `expires_at` uses the same single retention window as message text (qq-retention.ts),
-- like the speech log and the media cache. §10 also leaves the retention of *diagnostic*
-- records open; that question is not answered here by inventing a second number — when it
-- is decided it changes in that one file.

CREATE TABLE qq_send_log (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_kind TEXT NOT NULL CHECK (conversation_kind IN ('group', 'private')),
  peer_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('direct_reply', 'follow_up', 'chiming_in', 'idle_topic')),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'partially_sent', 'sticker_failed', 'text_failed', 'unknown', 'not_submitted')),
  delivery_message_id TEXT CHECK (delivery_message_id IS NULL OR length(delivery_message_id) > 0),
  sent_at_seconds INTEGER NOT NULL CHECK (sent_at_seconds >= 0),
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  CHECK (outcome <> 'sent' OR delivery_message_id IS NOT NULL),
  CHECK (delivery_message_id IS NULL OR outcome IN ('sent', 'partially_sent'))
);
CREATE INDEX ix_qq_send_conversation ON qq_send_log (account_id, conversation_kind, peer_id, agent_id, sent_at_seconds);
CREATE INDEX ix_qq_send_expiry ON qq_send_log (expires_at);

CREATE TABLE qq_send_part (
  send_id TEXT NOT NULL REFERENCES qq_send_log (id) ON DELETE CASCADE,
  part_index INTEGER NOT NULL CHECK (part_index >= 0),
  part_kind TEXT NOT NULL CHECK (part_kind IN ('text', 'sticker')),
  result TEXT NOT NULL CHECK (result IN ('confirmed', 'failed', 'unknown', 'not_sent')),
  platform_message_id TEXT CHECK (platform_message_id IS NULL OR length(platform_message_id) > 0),
  PRIMARY KEY (send_id, part_index),
  CHECK ((result = 'confirmed') = (platform_message_id IS NOT NULL))
);
