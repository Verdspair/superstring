-- Local transport configuration for the QQ connection (ADR0017 / ADR0018 P2h).
--
-- `qq_settings` so far carried only the master switch and the account id, which left the
-- assembled intake runtime unable to start: it needs a WebSocket endpoint and an access
-- token, and there was nowhere to keep them. Both are added here as nullable columns, so
-- an existing install simply reads as "not configured yet".
--
-- The endpoint is the user's OWN locally listening NapCat service (by preference
-- 127.0.0.1, see the plan). This application never logs into QQ: that belongs to NapCat,
-- so no QQ account password is stored anywhere in this schema.
--
-- The token is stored as authenticated ciphertext, never in the clear. A NULL
-- `token_ciphertext` means "never configured"; a value that fails to decrypt (for
-- example after the key file is regenerated) is treated by the repository as "not
-- configured" rather than as an empty token, so a broken credential can never be used by
-- accident.

ALTER TABLE qq_settings ADD COLUMN endpoint TEXT;
ALTER TABLE qq_settings ADD COLUMN token_ciphertext TEXT;
