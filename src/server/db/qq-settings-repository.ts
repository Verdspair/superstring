// The single-row third-party chat settings (`qq_settings`, ADR0017/ADR0018).
//
// One row, `id = 1`, enforced by a table CHECK. The global switch lives here and the
// current account id is stored alongside it, because the user's arrangement is a
// single account whose identity is kept per account rather than per session.

import { eq } from "drizzle-orm";
import { fail } from "../errors";
import { DEFAULT_TRANSPORT_KEY_PATH, openSecret, sealSecret, transportSecret } from "../secret-box";
import type { Orm } from "./repositories";
import * as schema from "./schema";

export type QqSettingsRow = typeof schema.qqSettings.$inferSelect;

/** The row always exists (the migration seeds it); a missing one is a real fault. */
export function readQqSettings(orm: Orm): QqSettingsRow {
  const row = orm.select().from(schema.qqSettings).where(eq(schema.qqSettings.id, 1)).get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

export interface QqSettingsUpdate {
  enabled?: boolean;
  /** `null` clears the saved account. */
  accountId?: string | null;
  /** `null` returns judgement to the bound assistant's conversation model (0038). */
  judgementModelName?: string | null;
  expectedRevision: number;
} /**
 * Optimistic update of the single row. Returns the updated row, or throws
 * `MEMORY_STATE_CONFLICT` when the caller's revision is stale — the same
 * compare-and-swap discipline every other settings surface in this project uses.
 */
export function updateQqSettings(orm: Orm, input: QqSettingsUpdate): QqSettingsRow {
  const current = readQqSettings(orm);
  if (current.revision !== input.expectedRevision) {
    fail("MEMORY_STATE_CONFLICT", "设置已变化，请重新加载后保存");
  }
  const enabled = input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0;
  const accountId = input.accountId === undefined ? current.accountId : input.accountId;
  const judgementModelName =
    input.judgementModelName === undefined ? current.judgementModelName : input.judgementModelName;
  const changed =
    enabled !== current.enabled ||
    accountId !== current.accountId ||
    judgementModelName !== current.judgementModelName;
  if (!changed) return current;
  const row = orm
    .update(schema.qqSettings)
    .set({ enabled, accountId, judgementModelName, revision: current.revision + 1 })
    .where(eq(schema.qqSettings.id, 1))
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

/** What a settings surface is allowed to see: the token itself is never returned. */
export interface QqTransportConfigView {
  endpoint: string | null;
  /** True when a token is stored AND still decrypts with the current key. */
  hasToken: boolean;
}

export function readQqTransportConfigView(
  orm: Orm,
  keyPath: string = DEFAULT_TRANSPORT_KEY_PATH,
): QqTransportConfigView {
  const row = readQqSettings(orm);
  return { endpoint: row.endpoint, hasToken: readTransportToken(orm, keyPath) !== null };
}

/**
 * The decrypted token, or `null` when there is none that can be used.
 *
 * A stored value that fails to authenticate (rotated key file, tampered row) is
 * reported as `null` — "not configured" — rather than as an empty token, so a broken
 * credential can never be dialled with.
 */
export function readTransportToken(
  orm: Orm,
  keyPath: string = DEFAULT_TRANSPORT_KEY_PATH,
): string | null {
  const row = readQqSettings(orm);
  if (!row.tokenCiphertext) return null;
  return openSecret(row.tokenCiphertext, transportSecret(keyPath));
}

export interface QqTransportConfigUpdate {
  /** Must be a `ws:`/`wss:` URL without credentials, query or fragment. `null` clears it. */
  endpoint?: string | null;
  /**
   * The token to store, encrypted. `null` clears it, `undefined` leaves it unchanged —
   * so "leave the token alone" and "remove the token" are different requests.
   */
  token?: string | null;
  expectedRevision: number;
  /** Key file for the token ciphertext; injected so tests never touch a real key. */
  keyPath?: string;
}

/**
 * Validate an endpoint the same way the transport will. Rejecting it here means a saved
 * configuration cannot fail later for a reason the user cannot see, and it keeps
 * credentials out of the URL (they belong in the token field).
 */
export function normalizeTransportEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    fail("MEMORY_SOURCE_INVALID", "连接地址不是合法URL");
  }
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail("MEMORY_SOURCE_INVALID", "连接地址必须是ws/wss且不含凭据、查询或片段");
  }
  return url.href;
}

export function updateQqTransportConfig(orm: Orm, input: QqTransportConfigUpdate): QqSettingsRow {
  const keyPath = input.keyPath ?? DEFAULT_TRANSPORT_KEY_PATH;
  const current = readQqSettings(orm);
  if (current.revision !== input.expectedRevision) {
    fail("MEMORY_STATE_CONFLICT", "设置已变化，请重新加载后保存");
  }
  const endpoint =
    input.endpoint === undefined
      ? current.endpoint
      : input.endpoint === null
        ? null
        : normalizeTransportEndpoint(input.endpoint);
  // Sealing is randomised, so saving the SAME token twice would otherwise produce
  // different ciphertext and bump the revision for no reason. Compare plaintext first:
  // a save that changes nothing must not look like a change, which is the same
  // no-op discipline every other settings surface here follows.
  const tokenCiphertext =
    input.token === undefined
      ? current.tokenCiphertext
      : input.token === null
        ? null
        : input.token === readTransportToken(orm, keyPath)
          ? current.tokenCiphertext
          : sealSecret(input.token, transportSecret(keyPath));
  if (endpoint === current.endpoint && tokenCiphertext === current.tokenCiphertext) {
    return current;
  }
  const row = orm
    .update(schema.qqSettings)
    .set({ endpoint, tokenCiphertext, revision: current.revision + 1 })
    .where(eq(schema.qqSettings.id, 1))
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

/**
 * The configuration the intake runtime needs, or `null` while any piece is missing.
 * Returning `null` instead of a partially-filled object means a caller cannot start a
 * connection with a missing or unusable token by accident.
 */
export function readQqConnectionConfig(
  orm: Orm,
  keyPath: string = DEFAULT_TRANSPORT_KEY_PATH,
): { endpoint: string; token: string; accountId: string } | null {
  const row = readQqSettings(orm);
  const token = readTransportToken(orm, keyPath);
  if (!row.endpoint || !row.accountId || token === null) return null;
  return { endpoint: row.endpoint, token, accountId: row.accountId };
}
