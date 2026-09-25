-- Judgement/reply context budgets and the assistant's own words (ADR0018 P3b-2).
--
-- Two gaps closed together, because the second is what makes the first useful.
--
-- 1. §6.1 requires the judgement and the reply to be configured separately: judging only
--    needs to know what the conversation is about right now, while a reply has to actually
--    join in. Three knobs each (recent message count, time window, token budget), decided by
--    the user on 2026-09-23. They live on the scheme like the rhythm parameters, so a scheme
--    describes how this assistant reads a conversation as well as how it talks in one.
--
-- 2. The assistant's own utterances had no body anywhere. OneBot delivers them as
--    `message_sent`, the protocol layer drops them as `self_message`, and 0011's speech log
--    deliberately stored order only (which kind, when). Judging "should I say something now"
--    without being able to see what this assistant just said means repeating itself or
--    losing its own thread, so the user asked for the text to be kept.
--
-- Text goes in its own table, keyed by the speech row, for the same reason observation text
-- (0007) is separate from `qq_events`: the two have different useful lifetimes. The speech
-- log can keep answering "did the assistant speak after us" for as long as the window lasts,
-- while the body may expire without touching that answer. A sticker-only utterance writes no
-- text row at all — that is honest rather than convenient, and `qq_send_log` already records
-- that a sticker was sent.
--
-- Units are in the column names: `*_message_limit` counts messages, `*_window_minutes` is a
-- time window, `*_token_budget` is in the project's existing estimator unit (UTF-8 bytes,
-- see token-estimate.ts) — the same yardstick the web context budgets use, so the two halves
-- of the product cannot disagree about what a budget means.
--
-- The window may not exceed 14 days: observation text is deleted after that, so a longer
-- window could only select messages whose bodies are gone.

ALTER TABLE qq_schemes ADD COLUMN judgement_message_limit INTEGER NOT NULL DEFAULT 20 CHECK (judgement_message_limit >= 1 AND judgement_message_limit <= 200);
ALTER TABLE qq_schemes ADD COLUMN judgement_window_minutes INTEGER NOT NULL DEFAULT 60 CHECK (judgement_window_minutes >= 1 AND judgement_window_minutes <= 20160);
ALTER TABLE qq_schemes ADD COLUMN judgement_token_budget INTEGER NOT NULL DEFAULT 2000 CHECK (judgement_token_budget >= 256 AND judgement_token_budget <= 16384);
ALTER TABLE qq_schemes ADD COLUMN reply_message_limit INTEGER NOT NULL DEFAULT 60 CHECK (reply_message_limit >= 1 AND reply_message_limit <= 500);
ALTER TABLE qq_schemes ADD COLUMN reply_window_minutes INTEGER NOT NULL DEFAULT 360 CHECK (reply_window_minutes >= 1 AND reply_window_minutes <= 20160);
ALTER TABLE qq_schemes ADD COLUMN reply_token_budget INTEGER NOT NULL DEFAULT 6000 CHECK (reply_token_budget >= 256 AND reply_token_budget <= 16384);

CREATE TABLE qq_speech_text (
  speech_id TEXT NOT NULL PRIMARY KEY REFERENCES qq_speech_log (id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  spoke_at_seconds INTEGER NOT NULL CHECK (spoke_at_seconds >= 0),
  expires_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX ix_qq_speech_text_expiry ON qq_speech_text (expires_at);
