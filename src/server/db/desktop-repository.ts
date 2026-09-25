// The desktop close preference (0025_desktop_settings.sql, §12).
//
// One single row, like every other settings row in this tree, with a revision used as a
// compare-and-swap: the settings page and the desktop host can both write it, and a stale writer
// must not silently undo the other's answer.

import { eq } from "drizzle-orm";
import type {
  DesktopCloseAction,
  DesktopSettings,
  DesktopSettingsUpdate,
} from "../../shared/contracts/desktop";
import { fail } from "../errors";
import type { Orm } from "./repositories";
import { desktopSettings } from "./schema";

function view(row: { closeAction: string; revision: number }): DesktopSettings {
  return { close_action: row.closeAction as DesktopCloseAction, revision: row.revision };
}

export function readDesktopSettings(orm: Orm): DesktopSettings {
  const row = orm.select().from(desktopSettings).where(eq(desktopSettings.id, 1)).get();
  if (!row) throw new Error("Missing desktop settings");
  return view(row);
}

export function updateDesktopSettings(orm: Orm, input: DesktopSettingsUpdate): DesktopSettings {
  return orm.transaction(
    (tx) => {
      const old = readDesktopSettings(tx);
      if (old.revision !== input.expected_revision)
        fail("CONFIG_VERSION_CONFLICT", "关闭行为已被修改，请刷新后重试");
      // Re-saving the same value is not a change: bumping the revision would invalidate a dialog
      // the host may be holding open over a no-op.
      if (old.close_action === input.close_action) return old;
      tx.update(desktopSettings)
        .set({ closeAction: input.close_action, revision: old.revision + 1 })
        .where(eq(desktopSettings.id, 1))
        .run();
      return readDesktopSettings(tx);
    },
    { behavior: "immediate" },
  );
}
