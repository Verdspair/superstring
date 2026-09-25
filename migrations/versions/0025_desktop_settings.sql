-- P5l: the desktop close preference (single row).
--
-- §12's decision is that closing the interface asks whether to keep the app online in the
-- background or quit for good; the desktop host (a C# launcher) shows that dialog, and the user
-- decided on 2026-09-24 that the answer is REMEMBERED and changeable in settings. This row is
-- that memory, and the server itself reads it: "stay online" has to mean the server does not stop
-- when the last page closes.
--
-- The value set is only what the product can actually honour today. There is deliberately no
-- 'ask' member: the dialog belongs to the host, and storing a value that no code path implements
-- would be a setting that lies. 'ask' arrives with the host, as an additional allowed value.
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
