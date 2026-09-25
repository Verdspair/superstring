// The user's own QQ identity, per assistant account (ADR0018 P5c).
//
// One row (`id = 1`), like the settings row. It answers a single question — which private
// chat on this account is the user's own — because that is the only thing "share my web
// memory with you" can mean. The contract refuses to infer it: a guess would silently grant
// memory sharing to whichever private chat happens to be busiest.
//
// The row may legitimately be absent: a fresh install has no owner until the user says who
// they are. `readQqOwnerIdentity` therefore returns `null` rather than inventing an identity,
// and every caller has to decide what "not configured" means for it.

import { eq } from "drizzle-orm";
import { fail } from "../errors";
import type { QqOwnerIdentity } from "../services/qq-binding-contract";
import type { Orm } from "./repositories";
import * as schema from "./schema";

export type QqOwnerIdentityRow = typeof schema.qqOwnerIdentities.$inferSelect;

/**
 * The stored owner identity, or `null` when the user has not configured one.
 *
 * A row whose account or peer is not a usable QQ number is treated as *not configured* rather
 * than repaired: sharing memory is an authorization decision, and a malformed identity must
 * fail closed.
 */
export function readQqOwnerIdentity(orm: Orm): QqOwnerIdentity | null {
  const row = orm
    .select()
    .from(schema.qqOwnerIdentities)
    .where(eq(schema.qqOwnerIdentities.id, 1))
    .get();
  if (!row || row.peerId === null) return null;
  return Object.freeze({
    accountId: row.accountId,
    peerId: row.peerId,
    revision: row.revision,
  });
}

/** Persist the single owner row. Written whole, because there is only ever one identity. */
export function saveQqOwnerIdentity(orm: Orm, identity: QqOwnerIdentity): QqOwnerIdentity {
  const row = orm
    .insert(schema.qqOwnerIdentities)
    .values({
      id: 1,
      accountId: identity.accountId,
      peerId: identity.peerId,
      revision: identity.revision,
    })
    .onConflictDoUpdate({
      target: schema.qqOwnerIdentities.id,
      set: {
        accountId: identity.accountId,
        peerId: identity.peerId,
        revision: identity.revision,
      },
    })
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return Object.freeze({
    accountId: row.accountId,
    peerId: row.peerId,
    revision: row.revision,
  });
}
