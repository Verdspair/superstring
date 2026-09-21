// `/health` — 1:1 with `api/app.py:195-219`.
//
// The shape is a flat object with a `status` of "ok" | "degraded". `degraded`
// is produced by ANY of the four sub-checks failing, so the UI can show which
// dependency is down without parsing prose.
//
// Fidelity notes:
//   - `_check_database` returns ("ok", schema_status) or ("unavailable",
//     "unavailable") and NEVER throws (app.py:166-183). The schema probe is the
//     SQLite equivalent of the source's MySQL `check_schema`.
//   - `_check_model` has a 5-second budget and returns ("unavailable", False) on
//     any failure (app.py:186-192).
//   - `instance_id` is generated once per process (app.py:47), not per request.

import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { BUSINESS_SCHEMA_VERSION } from "../db/schema-gate";
import type { ModelGateway } from "../llm/model-gateway";

/** Product SemVer; keep identical to package.json and the installer version. */
export const APP_VERSION = "0.2.1";

/** Generated once per process (app.py:47). */
export const PROCESS_INSTANCE_ID = crypto.randomUUID();

const DATABASE_CHECK_TIMEOUT_MS = 5_000;
const MODEL_CHECK_TIMEOUT_MS = 5_000;

/**
 * Equivalent of the source's `check_schema`: confirm the business schema is the
 * version this build understands. In SQLite the marker is `PRAGMA user_version`,
 * written by the schema gate.
 */
function checkSchema(db: Database): string {
  const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
  return row?.user_version === BUSINESS_SCHEMA_VERSION ? "ok" : "unavailable";
}

async function withTimeout<T>(ms: number, run: () => Promise<T>): Promise<T | null> {
  try {
    return await Promise.race([
      run(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  } catch {
    return null;
  }
}

export function healthRoutes(db: Database, gateway: ModelGateway): Hono {
  const router = new Hono();

  router.get("/health", async (c) => {
    const [databaseResult, modelResult] = await Promise.all([
      (async (): Promise<[string, string]> => {
        const result = await withTimeout(DATABASE_CHECK_TIMEOUT_MS, async () => {
          db.query("SELECT 1").get();
          return checkSchema(db);
        });
        return result === null ? ["unavailable", "unavailable"] : ["ok", result];
      })(),
      (async (): Promise<[string, boolean]> => {
        const models = await withTimeout(MODEL_CHECK_TIMEOUT_MS, () => gateway.listModels());
        if (models === null) return ["unavailable", false];
        return ["ok", models.includes(gateway.config.model)];
      })(),
    ]);

    const [database, schema] = databaseResult;
    const [modelService, modelLoaded] = modelResult;
    const status =
      database === "ok" && schema === "ok" && modelService === "ok" && modelLoaded
        ? "ok"
        : "degraded";

    return c.json({
      status,
      app: "ok",
      database,
      schema,
      model_service: modelService,
      model_loaded: modelLoaded,
      version: APP_VERSION,
      instance_id: PROCESS_INSTANCE_ID,
    });
  });

  return router;
}
