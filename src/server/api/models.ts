// `/models` routes
// `/models/capacity` is deliberately never a hard failure: any model-layer error
// is folded into `status: "unavailable"` plus the `error_code`, because the UI
// calls it while the user is still editing settings.
// `/models/local` de-duplicates model ids while preserving first-seen order
// (first-seen order) and reports `status: "empty"` rather than
// failing when LM Studio has nothing loaded.
// Note: neither route touches the database — the live config is read
// only — so this router intentionally takes no ORM handle.

import { Hono } from "hono";
import { z } from "zod";
import { rawString } from "../../shared/contracts/common";
import {
  CreateModelProviderRequestSchema,
  ModelProviderResponseSchema,
  ModelProviderTestResponseSchema,
  UpdateModelProviderRequestSchema,
} from "../../shared/contracts/models";
import {
  createModelProvider,
  deleteModelProvider,
  readModelProviderKey,
  readModelProviders,
  updateModelProvider,
} from "../db/model-provider-repository";
import type { Orm } from "../db/repositories";
import { newId } from "../db/repositories";
import { isAppError } from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import { DEFAULT_MODEL_PROVIDER_KEY_PATH } from "../secret-box";
import { parseBody, parseUuidParam, readJsonBody, validationFailed } from "./validation";

/** Query contract for `/models/capacity`. */
const CapacityQuerySchema = z.strictObject({
  // declares `Query(min_length=1, max_length=200)` with no
  // validator — the value is used verbatim, so it must not be trimmed here.
  model: rawString(1, 200),
});

export function modelRoutes(
  orm: Orm,
  gateway: ModelGateway,
  keyPath: string = DEFAULT_MODEL_PROVIDER_KEY_PATH,
): Hono {
  const router = new Hono();

  router.get("/capacity", async (c) => {
    const parsed = CapacityQuerySchema.safeParse({ model: c.req.query("model") ?? "" });
    if (!parsed.success) throw validationFailed();
    const model = parsed.data.model;

    try {
      const capacity = await gateway.loadedContextCapacity(model);
      return c.json({
        model,
        status: capacity !== null ? "loaded" : "unknown",
        context_length: capacity,
      });
    } catch (error) {
      if (isAppError(error)) {
        return c.json({
          model,
          status: "unavailable",
          context_length: null,
          error_code: error.code,
        });
      }
      throw error;
    }
  });

  router.get("/local", async (c) => {
    const models = [...new Set(await gateway.listModels())];
    return c.json({
      provider: "lm_studio",
      status: models.length > 0 ? "available" : "empty",
      models,
      default_model: gateway.config.model,
    });
  });

  // ---- 外部模型 API（0032，用户 2026-09-25）------------------------------------------
  //
  // A provider is a base URL plus a key; its models each carry a context window the user typed,
  // because external services have no catalogue to read and an unknown window makes the QQ chain
  // refuse to call. The key is write-only: responses carry `has_api_key`, never the value.

  router.get("/providers", (c) => c.json(readModelProviders(orm).map(toWire)));

  router.post("/providers", async (c) => {
    const body = parseBody(CreateModelProviderRequestSchema, await readJsonBody(c.req.raw));
    const created = createModelProvider(orm, {
      id: newId(),
      name: body.name,
      baseUrl: body.base_url,
      apiKey: body.api_key ?? null,
      models: body.models ?? [],
      keyPath,
    });
    return c.json(toWire(created), 201);
  });

  router.patch("/providers/:providerId", async (c) => {
    const providerId = parseUuidParam(c.req.param("providerId"));
    const body = parseBody(UpdateModelProviderRequestSchema, await readJsonBody(c.req.raw));
    const updated = updateModelProvider(
      orm,
      providerId,
      {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.base_url === undefined ? {} : { baseUrl: body.base_url }),
        ...(body.api_key === undefined ? {} : { apiKey: body.api_key }),
        ...(body.models === undefined ? {} : { models: body.models }),
      },
      body.expected_revision,
      keyPath,
    );
    return c.json(toWire(updated));
  });

  router.delete("/providers/:providerId", (c) => {
    deleteModelProvider(orm, parseUuidParam(c.req.param("providerId")));
    return c.body(null, 204);
  });

  /**
   * "Test connection": ask the provider itself for its model list. The stored key is used here and
   * nowhere else in this file, and the answer carries model ids only — never the key, never headers.
   */
  router.post("/providers/:providerId/test", async (c) => {
    const providerId = parseUuidParam(c.req.param("providerId"));
    const provider = readModelProviders(orm).find((row) => row.id === providerId);
    if (!provider) {
      return c.json(
        ModelProviderTestResponseSchema.parse({ ok: false, models: [], error: "provider 不存在" }),
      );
    }
    const apiKey = readModelProviderKey(orm, providerId, keyPath);
    const url = `${provider.base_url.replace(/\/+$/, "")}/models`;
    const lifetime = AbortSignal.timeout(10_000);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: apiKey === null ? {} : { authorization: `Bearer ${apiKey}` },
        signal: lifetime,
      });
      if (!response.ok) {
        return c.json(
          ModelProviderTestResponseSchema.parse({
            ok: false,
            models: [],
            error: `HTTP ${response.status}`,
          }),
        );
      }
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const models = (body.data ?? [])
        .map((entry) => String(entry?.id ?? ""))
        .filter((id) => id !== "");
      return c.json(ModelProviderTestResponseSchema.parse({ ok: true, models, error: null }));
    } catch (error) {
      return c.json(
        ModelProviderTestResponseSchema.parse({
          ok: false,
          models: [],
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  });

  return router;
}

/** The wire shape (already key-free); a round-trip through the contract keeps the two in step. */
function toWire(provider: ReturnType<typeof readModelProviders>[number]) {
  return ModelProviderResponseSchema.parse(provider);
}
