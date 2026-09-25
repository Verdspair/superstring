import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { canReadRun, inspectContext, visibleRun } from "../agent/context-access";
import { AgentRunRepository } from "../db/agent-run-repository";
import { ConversationEventRepository } from "../db/conversation-event-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import type { ModuleSourceResolver } from "../modules/composition";
import { parseUuidParam, validationFailed } from "./validation";

/** Local app principal, consistent with the existing session and memory APIs. */
const principal = { userId: DEFAULT_USER_ID };
const notFound = { error: { code: "RUN_NOT_FOUND", message: "运行不存在或不可访问" } };

export function runRoutes(
  db: Database,
  repository = new AgentRunRepository(db),
  options: { resolveSource?: ModuleSourceResolver } = {},
): Hono {
  const router = new Hono();
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  router.get("/", (c) => {
    const ownerKind = c.req.query("ownerKind");
    const ownerId = c.req.query("ownerId");
    if (!ownerKind || !ownerId) throw validationFailed();
    const ownerIds =
      ownerKind === "conversation"
        ? new ConversationEventRepository(db).historyRows(ownerId).map((row) => row.id)
        : [ownerId];
    const runs = ownerIds
      .flatMap((id) => repository.listRuns({ ownerKind, ownerId: id }))
      .filter((run) => canReadRun(db, run.owner, principal))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
    return c.json({ runs });
  });
  router.get("/by-request", (c) => {
    const sessionId = parseUuidParam(c.req.query("sessionId") ?? "");
    const requestId = c.req.query("clientRequestId");
    if (!requestId?.trim() || requestId.length > 64) throw validationFailed();
    const turn = db
      .query(`SELECT t.id FROM turns t JOIN sessions s ON s.id=t.session_id
        WHERE t.session_id=? AND t.client_request_id=? AND s.user_id=?`)
      .get(sessionId, requestId, principal.userId) as { id: string } | null;
    const run = turn
      ? repository
          .listRuns({ ownerKind: "web_turn", ownerId: turn.id })
          .find((candidate) => canReadRun(db, candidate.owner, principal))
      : undefined;
    return run ? c.json(run) : c.json(notFound, 404);
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
      new Date().toISOString(),
      options.resolveSource,
    );
    return context ? c.json(context) : c.json(notFound, 404);
  });
  return router;
}
