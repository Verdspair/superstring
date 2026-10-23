import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { FilePermissionStore } from "../../src/server/permissions/service";
import { createRuntime } from "../../src/server/runtime";
import type { SourceRef } from "../../src/shared/contracts/evidence";

afterEach(() => mock.restore());

it("routes ordinary provenance without permission file reads and rechecks execution-module revocation", async () => {
  let revision = "current";
  const reads = spyOn(FilePermissionStore.prototype, "read").mockImplementation(() => ({
    revision,
    policy: { version: 1, grants: [] },
  }));
  const runtime = createRuntime({
    businessDbPath: ":memory:",
    browserStateSecret: "synthetic-source-routing",
    permissionConfigPath: "synthetic-policy-not-read.json",
  });
  const { db, orm } = runtime.business;
  ensureDefaults(orm, "fixture");
  db.query(
    "INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','fixture',?,?)",
  ).run(new Date().toISOString(), new Date().toISOString());
  db.query(`INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at)
    VALUES('binding','10001','private','20002',?,'scheme',?,?)`).run(
    DEFAULT_AGENT_ID,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  new ConversationEventRepository(db).ensureOneBot("binding");
  const repository = new AgentRunRepository(db);
  const at = new Date().toISOString();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const body = "synthetic speech";
  db.query(`INSERT INTO qq_speech_log(id,account_id,conversation_kind,peer_id,agent_id,kind,spoke_at_seconds,expires_at,recorded_at)
    VALUES('speech','10001','private','20002',?,'direct_reply',1,?,?)`).run(
    DEFAULT_AGENT_ID,
    expires,
    at,
  );
  db.query("INSERT INTO qq_speech_text VALUES('speech',?,1,?,?)").run(body, expires, at);
  const snapshot = (sources: SourceRef[]) => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    repository.createRun({
      runId,
      specId: "fixture",
      specVersion: "1",
      owner: {
        kind: "qq_binding",
        id: "binding",
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
      at,
    });
    repository.startStep({
      runId,
      stepId,
      stepNo: 1,
      model: "fixture",
      phase: "leaf",
      at,
      messages: [{ role: "user", content: [{ kind: "text", text: "synthetic" }] }],
      sources,
    });
    return `/v2/runs/${runId}/context/${stepId}`;
  };
  try {
    const speech = snapshot(
      Array.from({ length: 3000 }, () => ({
        kind: "qq_speech",
        id: "speech",
        revision: createHash("sha256").update(body).digest("hex"),
        expiresAt: expires,
      })),
    );
    reads.mockClear();
    expect((await (await runtime.app.request(speech)).json()).status).toBe("exact");
    expect(reads).toHaveBeenCalledTimes(0);
    // A real execution-module source is resolved at the read boundary, never cached.
    const module = snapshot([{ kind: "execution_module", id: "qqMembers", revision }]);
    reads.mockClear();
    expect((await (await runtime.app.request(module)).json()).status).toBe("exact");
    expect(reads).toHaveBeenCalledTimes(1);
    revision = "revoked";
    reads.mockClear();
    expect((await (await runtime.app.request(module)).json()).status).toBe("revoked");
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.stop();
  }
});

it("does not let an unavailable module policy block ordinary context and HTTP reads", async () => {
  let unavailable = false;
  const reads = spyOn(FilePermissionStore.prototype, "read").mockImplementation(() => {
    if (unavailable) throw new Error("synthetic policy unavailable");
    return { revision: "current", policy: { version: 1, grants: [] } };
  });
  const runtime = createRuntime({
    businessDbPath: ":memory:",
    browserStateSecret: "synthetic-unavailable-source-routing",
    permissionConfigPath: "synthetic-policy-not-read.json",
    resolveSource: (source) => (source.kind === "fixture_source" ? "available" : undefined),
  });
  ensureDefaults(runtime.business.orm, "fixture");
  const repository = new AgentRunRepository(runtime.business.db);
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const at = new Date().toISOString();
  repository.createRun({
    runId,
    specId: "fixture",
    specVersion: "1",
    at,
    owner: { kind: "fixture", id: "fixture", userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID },
  });
  repository.startStep({
    runId,
    stepId,
    stepNo: 1,
    model: "fixture",
    phase: "leaf",
    at,
    messages: [{ role: "user", content: [{ kind: "text", text: "synthetic context" }] }],
    sources: [{ kind: "fixture_source", id: "ordinary", revision: "1" }],
  });
  try {
    unavailable = true;
    reads.mockClear();
    const [context, ordinary] = await Promise.all([
      runtime.app.request(`/v2/runs/${runId}/context/${stepId}`),
      runtime.app.request("/nonexistent-source-routing-fixture"),
    ]);
    expect((await context.json()).status).toBe("exact");
    expect(ordinary.status).toBe(404);
    expect(reads).toHaveBeenCalledTimes(0);
  } finally {
    unavailable = false;
    await runtime.stop();
  }
});
