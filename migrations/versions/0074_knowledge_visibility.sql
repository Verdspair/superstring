-- Knowledge classification is independent of per-Agent grants.
-- Existing documents remain unclassified until explicitly managed.
ALTER TABLE knowledge_documents ADD COLUMN visibility TEXT
  CHECK (visibility IS NULL OR visibility IN ('private', 'public'));
