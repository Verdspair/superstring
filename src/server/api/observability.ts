import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { RuntimeSpanFiltersSchema } from "../../shared/contracts/runtime-observability";
import { RuntimeSpanRepository } from "../observability/span-repository";
import { validationFailed } from "./validation";

export function observabilityRoutes(db: Database): Hono {
  const router = new Hono();
  const repository = new RuntimeSpanRepository(db);
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  router.get("/spans", (c) => {
    const query = RuntimeSpanFiltersSchema.safeParse(c.req.query());
    if (!query.success) throw validationFailed();
    return c.json(repository.page(query.data));
  });
  router.get("/traces/:traceId", (c) => {
    const query = RuntimeSpanFiltersSchema.safeParse({
      ...c.req.query(),
      traceId: c.req.param("traceId"),
    });
    if (!query.success) throw validationFailed();
    return c.json(repository.page(query.data));
  });
  return router;
}
