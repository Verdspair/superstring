-- QQ scheme output reservations (ADR0018 P3o). Additive; historical migrations stay frozen.
-- These are whole-model-call output reserves in the project's UTF-8 estimate, not the
-- recent-message budgets in 0016. Old schemes receive the user-approved defaults.
ALTER TABLE qq_schemes ADD COLUMN judgement_output_reserved INTEGER NOT NULL DEFAULT 512 CHECK (judgement_output_reserved >= 256 AND judgement_output_reserved <= 16384);
ALTER TABLE qq_schemes ADD COLUMN reply_output_reserved INTEGER NOT NULL DEFAULT 2048 CHECK (reply_output_reserved >= 256 AND reply_output_reserved <= 16384);
