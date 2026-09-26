// 外部模型 API 的持久化与解析（0032，）。
//
// What this module owes the rest of the side:
//   * the page's view of a provider, which never contains the key — only `has_api_key` (the QQ
//     transport token's rule, applied to a second credential);
//   * the write path, where the key is sealed with a machine-local key file before it touches the
//     row and the models list travels whole (the project's group-replace discipline);
//   * the ONE resolver the model gateway asks: "is this model name served by a declared external
//     provider, and if so where and with which key and window?" A name nobody declared answers
//     `null`, which is how the local model service keeps working exactly as before.

import { asc, eq } from "drizzle-orm";
import {
  MODEL_PROVIDER_MODEL_LIMIT,
  type ModelProviderModel,
  type ModelProviderResponse,
  ModelProviderResponseSchema,
} from "../../shared/contracts/models";
import { fail } from "../errors";
import { openSecret, sealSecret, transportSecret } from "../secret-box";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type ModelProviderRow = typeof schema.modelProviders.$inferSelect;

export interface ModelProviderRoute {
  readonly providerId: string;
  readonly providerName: string;
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly contextWindow: number;
}

/** The row -> wire mapping. The key's ciphertext never leaves this module. */
export function toModelProviderResponse(row: ModelProviderRow): ModelProviderResponse {
  const models = JSON.parse(row.models) as unknown;
  const parsed = ModelProviderResponseSchema.safeParse({
    id: row.id,
    name: row.name,
    base_url: row.baseUrl,
    has_api_key: row.apiKey !== null,
    models,
    revision: row.revision,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
  // A row that cannot describe itself is refused rather than handed to the page as if it were sound.
  if (!parsed.success) fail("MEMORY_SOURCE_INVALID", "模型 provider 数据不完整，拒绝读取");
  return parsed.data;
}

export function readModelProviders(orm: Orm): ModelProviderResponse[] {
  return orm
    .select()
    .from(schema.modelProviders)
    .orderBy(asc(schema.modelProviders.name), asc(schema.modelProviders.id))
    .all()
    .map(toModelProviderResponse);
}

function readRow(orm: Orm, id: string): ModelProviderRow | null {
  return (
    orm.select().from(schema.modelProviders).where(eq(schema.modelProviders.id, id)).get() ?? null
  );
}

/** Two providers claiming one model name would make resolution a guess; the write path refuses it. */
function requireUndeclaredModels(
  orm: Orm,
  models: readonly ModelProviderModel[],
  exceptProviderId: string | null,
): void {
  const mine = new Set(models.map((model) => model.name));
  if (mine.size !== models.length) fail("MEMORY_SOURCE_INVALID", "同一个 provider 里模型名重复");
  for (const other of readModelProviders(orm)) {
    if (other.id === exceptProviderId) continue;
    const clash = other.models.find((model) => mine.has(model.name));
    if (clash) {
      fail(
        "MEMORY_STATE_CONFLICT",
        `模型名「${clash.name}」已由「${other.name}」声明，请改名或删掉那一条`,
      );
    }
  }
}

export function createModelProvider(
  orm: Orm,
  input: {
    id: string;
    name: string;
    baseUrl: string;
    apiKey?: string | null;
    models?: readonly ModelProviderModel[];
    keyPath: string;
  },
): ModelProviderResponse {
  const models = [...(input.models ?? [])];
  requireUndeclaredModels(orm, models, null);
  if (readModelProviders(orm).some((provider) => provider.name === input.name)) {
    fail("MEMORY_STATE_CONFLICT", "已经有同名 provider");
  }
  const apiKey =
    input.apiKey === undefined || input.apiKey === null || input.apiKey.trim() === ""
      ? null
      : sealSecret(input.apiKey, transportSecret(input.keyPath));
  const row = orm
    .insert(schema.modelProviders)
    .values({
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey,
      models: JSON.stringify(models),
      revision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return toModelProviderResponse(row);
}

export function updateModelProvider(
  orm: Orm,
  id: string,
  patch: {
    name?: string;
    baseUrl?: string;
    /** Absent keeps the stored key; `null` clears it; a string replaces it. */
    apiKey?: string | null;
    models?: readonly ModelProviderModel[];
  },
  expectedRevision: number,
  keyPath: string,
): ModelProviderResponse {
  const current = readRow(orm, id);
  if (!current) fail("MEMORY_NOT_FOUND", "模型 provider 不存在", 404);
  if (current.revision !== expectedRevision) {
    fail("MEMORY_STATE_CONFLICT", "provider 已变化，请重新加载后保存");
  }
  const name = patch.name ?? current.name;
  if (name !== current.name && readModelProviders(orm).some((provider) => provider.name === name)) {
    fail("MEMORY_STATE_CONFLICT", "已经有同名 provider");
  }
  const models = patch.models === undefined ? undefined : [...patch.models];
  if (models !== undefined) requireUndeclaredModels(orm, models, id);
  const apiKey =
    patch.apiKey === undefined
      ? current.apiKey
      : patch.apiKey === null || patch.apiKey.trim() === ""
        ? null
        : sealSecret(patch.apiKey, transportSecret(keyPath));
  const row = orm
    .update(schema.modelProviders)
    .set({
      name,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      apiKey,
      ...(models === undefined ? {} : { models: JSON.stringify(models) }),
      revision: current.revision + 1,
      updatedAt: nowIso(),
    })
    .where(eq(schema.modelProviders.id, id))
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return toModelProviderResponse(row);
}

export function deleteModelProvider(orm: Orm, id: string): void {
  const row = readRow(orm, id);
  if (!row) fail("MEMORY_NOT_FOUND", "模型 provider 不存在", 404);
  orm.delete(schema.modelProviders).where(eq(schema.modelProviders.id, id)).run();
}

/** The decrypted key for one provider, for the connection test. Never returned over HTTP. */
export function readModelProviderKey(orm: Orm, id: string, keyPath: string): string | null {
  const row = readRow(orm, id);
  if (!row) fail("MEMORY_NOT_FOUND", "模型 provider 不存在", 404);
  if (row.apiKey === null) return null;
  return openSecret(row.apiKey, transportSecret(keyPath));
}

/**
 * Where a model name lives, or `null` for "not an external model".
 *
 * `null` is the important answer: it is what keeps every existing model name on the local service
 * path without a second configuration. When more than one provider somehow declares the same name
 * (only reachable by writing SQL directly, since the write path refuses it), the first by provider
 * name wins — deterministically, so a call never depends on row order.
 */
export function resolveModelProviderRoute(
  orm: Orm,
  model: string,
  keyPath: string,
): ModelProviderRoute | null {
  const wanted = model.trim();
  if (wanted === "") return null;
  for (const row of orm
    .select()
    .from(schema.modelProviders)
    .orderBy(asc(schema.modelProviders.name), asc(schema.modelProviders.id))
    .all()) {
    let models: ModelProviderModel[];
    try {
      models = JSON.parse(row.models) as ModelProviderModel[];
    } catch {
      continue;
    }
    if (!Array.isArray(models)) continue;
    const declared = models.find((entry) => entry?.name === wanted);
    if (!declared) continue;
    return Object.freeze({
      providerId: row.id,
      providerName: row.name,
      baseUrl: row.baseUrl,
      apiKey: row.apiKey === null ? null : openSecret(row.apiKey, transportSecret(keyPath)),
      contextWindow: declared.context_window,
    });
  }
  return null;
}

export { MODEL_PROVIDER_MODEL_LIMIT };
