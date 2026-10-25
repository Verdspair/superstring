-- Named chat schemes: identity only (ADR0018 P2i).
--
-- This migration stores only the scheme identity and ownership. Trigger windows,
-- idle times, merge windows, cooldowns and media counts are separate scheme
-- parameters, added by later migrations. The row records the name, description,
-- revision and creation/update timestamps. Bindings refer to the scheme by ID,
-- and the scheme can be reused across assistants without assistant ownership.
-- Parameter columns are not part of this migration.
--
-- A scheme is a QQ-global named resource that can be reused across assistants, so it is
-- not owned by an assistant here. `name` is unique because two identically named schemes
-- would make a binding impossible to read at a glance, and the whole point of a named
-- resource is that its name identifies it.
--
-- Binding integrity needs a cross-table invariant, which SQLite CHECK cannot express, so
-- it is enforced with triggers:
--   * a binding may only reference a scheme that exists, and
--   * a scheme that a binding refers to cannot be deleted (rebind first).
-- An in-use scheme cannot be deleted: doing so would remove the target of an
-- existing binding. Refusing the delete, rather than cascading it, keeps bindings
-- attached to their selected scheme until explicitly rebound.
--
-- Triggers rather than a table rebuild: `qq_bindings.scheme_id` was already stored as an
-- opaque reference before schemes existed, and adding a real foreign key would require
-- either inventing a scheme row for every existing id or dropping the NOT NULL that
-- expresses "a binding always has a scheme". A trigger enforces the same rule for every
-- new write without rewriting existing rows.

CREATE TABLE qq_schemes (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_qq_scheme_name ON qq_schemes (name);

CREATE TRIGGER qq_binding_scheme_exists_insert
BEFORE INSERT ON qq_bindings
WHEN NOT EXISTS (SELECT 1 FROM qq_schemes WHERE id = NEW.scheme_id)
BEGIN
  SELECT RAISE(ABORT, 'QQ_BINDING_SCHEME_MISSING');
END;

CREATE TRIGGER qq_binding_scheme_exists_update
BEFORE UPDATE OF scheme_id ON qq_bindings
WHEN NOT EXISTS (SELECT 1 FROM qq_schemes WHERE id = NEW.scheme_id)
BEGIN
  SELECT RAISE(ABORT, 'QQ_BINDING_SCHEME_MISSING');
END;

CREATE TRIGGER qq_scheme_in_use_delete
BEFORE DELETE ON qq_schemes
WHEN EXISTS (SELECT 1 FROM qq_bindings WHERE scheme_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'QQ_SCHEME_IN_USE');
END;
