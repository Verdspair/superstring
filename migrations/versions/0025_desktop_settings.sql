-- P5l: the desktop close preference (single row).
--
-- This row stores the legacy desktop close preference: keep the app online in
-- the background or exit when the interface closes. The preference is persisted
-- rather than attached to a single window. The server can read the same value
-- as the desktop host; the background value represents leaving the server online
-- after the last page closes.
--
-- The legacy value set contains only `background` and `exit`. A host dialog
-- is separate from the stored close action; this migration does not store
-- an `ask` value or define the host dialog lifecycle.
--
-- The default is 'exit' because that is what the product did before this row existed (last page
-- closed -> the grace expires -> the server stops): a migration must not change behaviour for a
-- user who never opened the setting.
CREATE TABLE desktop_settings (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  close_action TEXT NOT NULL CHECK (close_action IN ('background', 'exit')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

INSERT INTO desktop_settings (id, close_action, revision) VALUES (1, 'exit', 1);
