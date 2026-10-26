import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { assertContextSources, inspectContext } from "../../src/server/agent/context-access";
import { ContextBuilder } from "../../src/server/agent/conversation-context";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { createApp } from "../../src/server/app";
import { assertBotContextSources } from "../../src/server/channels/onebot11/context-source";
import { WebContextSource } from "../../src/server/channels/web-context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  getTurnByRequest,
  prepareTurn,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type { ModuleSourceResolver } from "../../src/server/modules/composition";
import {
  FilePermissionStore,
  PermissionService,
  type PermissionStore,
} from "../../src/server/permissions/service";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { PermissionPolicy } from "../../src/shared/contracts/permissions";

const handles: ReturnType<typeof openBusinessDb>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const NOW = "2030-06-01T00:00:00.000Z";
const owner: RunOwner = {
  kind: "fixture",
  id: "fixture",
  userId: DEFAULT_USER_ID,
  agentId: "agent-a",
};
class CountingStore implements PermissionStore {
  reads = 0;
  constructor(readonly inner: PermissionStore) {}
  read() {
    this.reads++;
    return this.inner.read();
  }
  replace(expected: string, policy: PermissionPolicy) {
    return this.inner.replace(expected, policy);
  }
}
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "permission-source-pass-"));
  dirs.push(dir);
  const file = path.join(dir, "policy.json");
  const store = new CountingStore(new FilePermissionStore(file));
  const service = new PermissionService(store);
  const policy: PermissionPolicy = {
    version: 1,
    grants: Array.from({ length: 64 }, (_, i) => ({
      resource: `mcp.resource-${i}.read`,
      approved: false,
      directories: [],
      agentIds: ["agent-a", DEFAULT_AGENT_ID],
    })),
  };
  service.replace("", policy);
  const refs = policy.grants.map((grant) =>
    service.source({ resource: grant.resource, revision: "1", approvalRequired: false }, owner),
  );
  const business = openBusinessDb();
  handles.push(business);
  const repository = new AgentRunRepository(business.db);
  const resolver: ModuleSourceResolver = Object.assign(
    (source: SourceRef, identity: RunOwner) => service.sourceAccess(source, identity),
    {
      resolveMany: (sources: readonly SourceRef[], identity: RunOwner) =>
        service.sourceAccessMany(sources, identity),
    },
  );
  const assert = (sources = refs, resolveSource = resolver, identity = owner) =>
    assertContextSources({
      db: business.db,
      sources,
      owner: identity,
      now: NOW,
      resolveSource,
      memoryRevisions: () => new Map(),
      messages: { memory: "memory invalid", other: "source invalid" },
    });
  const snapshot = (sources = refs) => {
    const runId = crypto.randomUUID(),
      stepId = crypto.randomUUID();
    repository.createRun({ runId, specId: "permission-pass", specVersion: "1", owner, at: NOW });
    repository.startStep({
      runId,
      stepId,
      stepNo: 1,
      model: "synthetic",
      phase: "leaf",
      at: NOW,
      messages: [{ role: "user", content: [{ kind: "text", text: "protected body" }] }],
      sources,
    });
    return { runId, stepId };
  };
  store.reads = 0;
  return { file, store, service, policy, refs, business, repository, resolver, assert, snapshot };
}
it("asserts 64 retained permission refs with one private policy read, while ordinary refs read none", () => {
  const f = fixture();
  f.assert();
  expect(f.store.reads).toBe(1);
  f.store.reads = 0;
  f.assert(
    Array.from({ length: 64 }, (_, i) => ({ kind: "external", id: `plain-${i}`, revision: "1" })),
    (source, identity, at) => f.resolver(source, identity, at) ?? "available",
  );
  expect(f.store.reads).toBe(0);
});
it("inspects retained permission refs through the public context entry with one read", () => {
  const f = fixture(),
    handle = f.snapshot();
  expect(
    inspectContext(
      f.business.db,
      f.repository,
      handle,
      { userId: DEFAULT_USER_ID },
      NOW,
      f.resolver,
    )?.status,
  ).toBe("exact");
  expect(f.store.reads).toBe(1);
});
it("uses the production app resolver's batch path for GET context rather than only a test adapter", async () => {
  const f = fixture(),
    handle = f.snapshot();
  const app = createApp({ business: f.business, permissions: f.service });
  f.store.reads = 0;
  const response = await app.request(`/v2/runs/${handle.runId}/context/${handle.stepId}`);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { status: string }).status).toBe("exact");
  expect(f.store.reads).toBe(1);
});
it("rereads same-mtime external policy edits on every new pass and keeps scalar checks live", () => {
  const f = fixture();
  f.assert();
  expect(f.store.reads).toBe(1);
  const stat = statSync(f.file);
  writeFileSync(f.file, JSON.stringify({ version: 1, grants: [] }));
  utimesSync(f.file, stat.atime, stat.mtime);
  expect(() => f.assert()).toThrow("source invalid");
  expect(f.store.reads).toBe(2);
  expect(f.service.sourceAccess(f.refs[0], owner)).toBe("revoked");
  expect(f.store.reads).toBe(3);
  writeFileSync(f.file, "invalid policy");
  expect(() => f.assert()).toThrow("source invalid");
  expect(f.store.reads).toBe(4);
});
it("does not carry a snapshot across an interleaved resolver mutation, and preserves agent/revision/expiry refusal", () => {
  const f = fixture();
  const resolver: ModuleSourceResolver = Object.assign(
    (source: SourceRef, identity: RunOwner) => {
      if (source.kind === "external") {
        writeFileSync(f.file, JSON.stringify({ version: 1, grants: [] }));
        return "available" as const;
      }
      return f.service.sourceAccess(source, identity);
    },
    {
      resolveMany: (sources: readonly SourceRef[], identity: RunOwner) =>
        f.service.sourceAccessMany(sources, identity),
    },
  );
  expect(() =>
    f.assert(
      [f.refs[0], { kind: "external", id: "edit-policy", revision: "1" }, f.refs[1]],
      resolver,
    ),
  ).toThrow("source invalid");
  expect(f.store.reads).toBe(2);
  writeFileSync(f.file, JSON.stringify(f.policy));
  expect(() => f.assert(f.refs, f.resolver, { ...owner, agentId: "agent-b" })).toThrow(
    "source invalid",
  );
  expect(() => f.assert([{ ...f.refs[0], revision: "stale" }])).toThrow("source invalid");
  expect(() => f.assert([{ ...f.refs[0], expiresAt: "2000-01-01T00:00:00.000Z" }])).toThrow(
    "source invalid",
  );
});

it("forwards the permission batch through the Web and Bot public context wrappers and rereads on revocation", () => {
  const f = fixture();
  const session = createSession(f.business.orm, "web-source", { modelName: "synthetic" });
  const prepared = prepareTurn(f.business.orm, session.id, "Question", "source-request");
  const turn = getTurnByRequest(f.business.orm, session.id, "source-request");
  if (!turn) throw Error("missing turn");
  const gateway = {
    loadedContextCapacity: async () => 32768,
    complete: async () => "unused",
  } as unknown as ModelGateway;
  const agentRuntime = createAgentRuntime({ gateway, repository: f.repository });
  const web = new WebContextSource({
    db: f.business.db,
    orm: f.business.orm,
    gateway,
    agentRuntime,
    builder: new ContextBuilder({ orm: f.business.orm, db: f.business.db, gateway, agentRuntime }),
    runtime: prepared.runtime,
    sessionId: session.id,
    turnId: turn.id,
    generationToken: prepared.generationToken!,
    maxSteps: 16,
    resolveSource: f.resolver,
  });
  f.store.reads = 0;
  web.assertSources(f.refs);
  expect(f.store.reads).toBe(1);
  // No memory refs means the wrapper needs neither binding nor snapshot; its real guard and source routing still execute.
  const botOptions = {
    db: f.business.db,
    orm: f.business.orm,
    resolveSource: f.resolver,
  } as Parameters<typeof assertBotContextSources>[0];
  f.store.reads = 0;
  assertBotContextSources(botOptions, owner, f.refs);
  expect(f.store.reads).toBe(1);
  writeFileSync(f.file, JSON.stringify({ version: 1, grants: [] }));
  f.store.reads = 0;
  expect(() => web.assertSources(f.refs)).toThrow();
  expect(f.store.reads).toBe(1);
  f.store.reads = 0;
  expect(() => assertBotContextSources(botOptions, owner, f.refs)).toThrow();
  expect(f.store.reads).toBe(1);
});
it("checks durable task source refs with one policy read on inspect and redacts after the next-pass revocation", () => {
  const f = fixture();
  const session = createSession(f.business.orm, "task-source", { modelName: "synthetic" });
  const conversation = new ConversationEventRepository(f.business.db).ensureWeb(
    session.id,
    DEFAULT_USER_ID,
  );
  if (!conversation) throw Error("missing synthetic conversation");
  const repository = new AgentTaskRepository(f.business.db);
  const service = new AgentTaskService({
    repository,
    orm: f.business.orm,
    executor: new ActionExecutor(f.service),
    actions: () => [],
    now: () => NOW,
  });
  const task = repository.enqueue({
    conversationId: conversation.id,
    agentId: conversation.agentId,
    dedupeKey: "source-pass-task",
    calls: [],
    sources: f.refs,
    at: NOW,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  f.store.reads = 0;
  expect(service.inspect(task.id)?.errorCode).toBeNull();
  expect(f.store.reads).toBe(1);
  writeFileSync(f.file, JSON.stringify({ version: 1, grants: [] }));
  f.store.reads = 0;
  expect(service.inspect(task.id)?.errorCode).toBe("TASK_SOURCE_INVALID");
  expect(f.store.reads).toBe(1);
});
