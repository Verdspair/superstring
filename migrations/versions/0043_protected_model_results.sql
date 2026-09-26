-- Model output is protected by the same source lifetime as its exact input.
ALTER TABLE context_snapshots ADD COLUMN protected_output TEXT
  CHECK (protected_output IS NULL OR json_valid(protected_output));
-- output_recorded=0 identifies historical rows whose output was never captured. A completed
-- attempt with no received response is recorded explicitly without invented text.
ALTER TABLE context_snapshots ADD COLUMN output_recorded INTEGER NOT NULL DEFAULT 0
  CHECK (output_recorded IN (0,1));
-- Existing source/owner deletion and mutation triggers redact protected_messages.
-- One cascade covers all of them, including future redaction via the same API.
CREATE TRIGGER redact_agent_context_output
AFTER UPDATE OF protected_messages,status ON context_snapshots
WHEN NEW.protected_messages IS NULL OR NEW.status<>'exact'
BEGIN
  UPDATE context_snapshots SET protected_output=NULL WHERE step_id=NEW.step_id;
END;
