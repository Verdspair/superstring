// QQ group display names (schema 0053): the user's custom remark wins, then the
// group's own name as reported by OneBot, then the bare "群聊 群号" fallback the
// summary projection already had. One row per (account, group); a reconnect may
// refresh the original name but never touches the custom remark.
//
// Raw SQL on purpose: the table lives behind the schema gate (0053) and this
// repository only reads and upserts the columns the migration defines — no
// second schema copy.

import type { Database } from "bun:sqlite";
import { nowIso } from "./repositories";

export interface QqGroupName {
  qqName: string | null;
  customName: string | null;
}

export function readQqGroupName(
  db: Database,
  accountId: string,
  groupId: string,
): QqGroupName | null {
  const row = db
    .query("SELECT qq_name, custom_name FROM qq_group_names WHERE account_id=? AND group_id=?")
    .get(accountId, groupId) as { qq_name: string | null; custom_name: string | null } | null;
  return row ? { qqName: row.qq_name, customName: row.custom_name } : null;
}

/** Refresh the group's own name. An upsert updates `qq_name` and `updated_at`
 * and leaves `custom_name` exactly as it was. */
export function saveQqOriginalName(
  db: Database,
  accountId: string,
  groupId: string,
  qqName: string,
): void {
  db.query(
    `INSERT INTO qq_group_names (account_id, group_id, qq_name, custom_name, updated_at)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(account_id, group_id) DO UPDATE
         SET qq_name=excluded.qq_name, updated_at=excluded.updated_at`,
  ).run(accountId, groupId, qqName, nowIso());
}

/** Store or clear the user's remark. Clearing a name that was never set is a no-op. */
export function saveQqCustomName(
  db: Database,
  accountId: string,
  groupId: string,
  customName: string | null,
): void {
  if (customName === null) {
    db.query(
      "UPDATE qq_group_names SET custom_name=NULL, updated_at=? WHERE account_id=? AND group_id=?",
    ).run(nowIso(), accountId, groupId);
    return;
  }
  db.query(
    `INSERT INTO qq_group_names (account_id, group_id, qq_name, custom_name, updated_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(account_id, group_id) DO UPDATE
         SET custom_name=excluded.custom_name, updated_at=excluded.updated_at`,
  ).run(accountId, groupId, customName, nowIso());
}
