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
import { isAppError } from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import { validationFailed } from "./validation";

/** Query contract for `/models/capacity`. */
const CapacityQuerySchema = z.strictObject({
  // declares `Query(min_length=1, max_length=200)` with no
  // validator — the value is used verbatim, so it must not be trimmed here.
  model: rawString(1, 200),
});

export function modelRoutes(gateway: ModelGateway): Hono {
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

  return router;
}
