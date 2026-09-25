import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { canReadRun, inspectContext, visibleRun } from "../agent/context-access";
import { AgentRunRepository } from "../db/agent-run-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { parseUuidParam, validationFailed } from "./validation";

/** Local app principal, consistent with the existing session and memory APIs. */
const principal = { userId: DEFAULT_USER_ID };
const notFound = { error: { code: "RUN_NOT_FOUND", message: "运行不存在或不可访问" } };

export function runRoutes(db: Database, repository = new AgentRunRepository(db)): Hono {
  const router = new Hono();
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  router.get("/", (c) => {
    const ownerKind = c.req.query("ownerKind");
    const ownerId = c.req.query("ownerId");
    if (!ownerKind || !ownerId) throw validationFailed();
    const runs = repository
      .listRuns({ ownerKind, ownerId })
      .filter((run) => canReadRun(db, run.owner, principal));
    return c.json({ runs });
  });
  router.get("/:id", (c) => {
    const run = visibleRun(db, repository, parseUuidParam(c.req.param("id")), principal);
    return run ? c.json(run) : c.json(notFound, 404);
  });
  router.get("/:id/events", (c) => {
    const id = parseUuidParam(c.req.param("id"));
    if (!visibleRun(db, repository, id, principal)) return c.json(notFound, 404);
    const raw = c.req.query("afterSeq") ?? "0";
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw validationFailed();
    return c.json({ events: repository.listEvents(id, Number(raw)) });
  });
  router.get("/:id/context/:stepId", (c) => {
    const context = inspectContext(
      db,
      repository,
      {
        runId: parseUuidParam(c.req.param("id")),
        stepId: parseUuidParam(c.req.param("stepId")),
      },
      principal,
    );
    return context ? c.json(context) : c.json(notFound, 404);
  });
  return router;
}
