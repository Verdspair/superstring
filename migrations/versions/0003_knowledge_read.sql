-- ADR0015: per-assistant reading rules, independent of grants and organization.
CREATE TABLE agent_knowledge_read_settings (
    agent_id TEXT NOT NULL PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    context_budget INTEGER,
    scope TEXT NOT NULL DEFAULT 'all',
    document_ids TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT agent_knowledge_read_enabled CHECK (enabled IN (0, 1)),
    CONSTRAINT agent_knowledge_read_budget CHECK (context_budget IS NULL OR context_budget >= 1),
    CONSTRAINT agent_knowledge_read_scope CHECK (scope IN ('all', 'selected')),
    CONSTRAINT agent_knowledge_read_ids CHECK (json_valid(document_ids) AND json_type(document_ids) = 'array'),
    CONSTRAINT agent_knowledge_read_all CHECK (scope <> 'all' OR document_ids = '[]'),
    CONSTRAINT agent_knowledge_read_revision CHECK (revision >= 1)
);
INSERT INTO agent_knowledge_read_settings (agent_id) SELECT id FROM agents;
