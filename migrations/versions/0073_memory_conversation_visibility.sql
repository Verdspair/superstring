ALTER TABLE conversations ADD COLUMN memory_read_mode TEXT NOT NULL DEFAULT 'current_conversation' CHECK (memory_read_mode IN ('current_conversation', 'agent_shared'));
ALTER TABLE conversations ADD COLUMN memory_config_revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(memory_config_revision) = 'integer' AND memory_config_revision >= 1);
ALTER TABLE memory_entries ADD COLUMN visibility TEXT CHECK (visibility IS NULL OR visibility IN ('session_private', 'agent_shared', 'public'));
ALTER TABLE memory_entries ADD COLUMN visibility_revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(visibility_revision) = 'integer' AND visibility_revision >= 1);
ALTER TABLE memory_entries ADD COLUMN publication_source_revision TEXT CHECK (publication_source_revision IS NULL OR length(publication_source_revision) > 0);
ALTER TABLE memory_entries ADD COLUMN folded_search TEXT;
ALTER TABLE memory_entries ADD COLUMN fold_version INTEGER CHECK (fold_version IS NULL OR (typeof(fold_version) = 'integer' AND fold_version >= 1));
CREATE TABLE memory_read_grants (
  memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token TEXT NOT NULL CHECK (length(token) > 0),
  PRIMARY KEY (memory_id, agent_id)
) WITHOUT ROWID;
CREATE INDEX ix_memory_read_grants_agent ON memory_read_grants(agent_id, memory_id);
