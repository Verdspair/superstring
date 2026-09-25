-- Named chat schemes: identity only (ADR0018 P2i).
--
-- The plan deliberately labels the scheme's field groups "design labels, not frozen API
-- fields", and almost every value in them is still pending (trigger windows, idle times,
-- merge windows, cooldowns, media counts). Freezing those into columns now would decide
-- product parameters the user has not decided, so this migration stores ONLY the scheme's
-- identity and ownership; the parameter columns arrive with the decisions that define
-- them.
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
-- The second one matters because the plan says changing a scheme must not silently
-- re-point existing bindings; deleting an in-use scheme is the destructive version of
-- exactly that, so it is refused rather than cascaded.
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
