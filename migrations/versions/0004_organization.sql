-- Shared organization default. Existing explicit overrides and snapshots stay unchanged.
CREATE TABLE organization_settings (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  model_name TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
INSERT INTO organization_settings (id, model_name, revision) VALUES (1, NULL, 1);
