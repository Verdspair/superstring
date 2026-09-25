import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { handleError } from "../../src/server/api/error-handler";
import { runRoutes } from "../../src/server/api/runs";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { createSession, DEFAULT_USER_ID, prepareTurn } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function setup() {
  const business = openBusinessDb();
  handles.push(business);
  const session = createSession(business.orm, "recover request", { modelName: "test" });
  prepareTurn(business.orm, session.id, "hello", "client-request");
  const turn = business.db.query("SELECT id FROM turns WHERE session_id=?").get(session.id) as {
    id: string;
  };
  const repository = new AgentRunRepository(business.db);
  const app = new Hono().onError(handleError).route("/v2/runs", runRoutes(business.db, repository));
  const url = `/v2/runs/by-request?sessionId=${session.id}&clientRequestId=client-request`;
  return { business, repository, app, turn, session, url };
}

describe("request recovery lookup", () => {
  it("returns no run before inference starts and the latest owned attempt afterward", async () => {
    const { app, repository, turn, url } = setup();
    expect((await app.request(url)).status).toBe(404);
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    for (const [index, runId] of [first, second].entries()) {
      repository.createRun({
        runId,
        specId: "conversation",
        specVersion: "1",
        owner: { kind: "web_turn", id: turn.id, userId: DEFAULT_USER_ID },
        at: `2026-09-26T00:00:0${index}.000Z`,
      });
    }
    const response = await app.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).runId).toBe(second);
  });

  it("does not expose foreign owners or synthesize a successful terminal from a missing run", async () => {
    const { app, repository, turn, url, session } = setup();
    repository.createRun({
      runId: crypto.randomUUID(),
      specId: "conversation",
      specVersion: "1",
      owner: { kind: "web_turn", id: turn.id, userId: "foreign" },
      at: new Date().toISOString(),
    });
    expect((await app.request(url)).status).toBe(404);
    expect(
      (await app.request(`/v2/runs/by-request?sessionId=${session.id}&clientRequestId=missing`))
        .status,
    ).toBe(404);
    expect(
      (await app.request("/v2/runs/by-request?sessionId=invalid&clientRequestId=x")).status,
    ).toBe(422);
    expect((await app.request(`/v2/runs/by-request?sessionId=${session.id}`)).status).toBe(422);
  });
});
