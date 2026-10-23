import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { policy, turns } from "../../src/server/db/memory-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  pendingObservationCount,
  type QqConversationScope,
} from "../../src/server/db/qq-observation-repository";
import { readQqSettings, updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createSession,
  ensureDefaults,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { createSqliteModules } from "../../src/server/modules/composition";
import { turnSources } from "../../src/server/modules/provenance";
import { MemoryService } from "../../src/server/services/memory-service";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import { scheduleQqMemory } from "../../src/server/services/qq-memory-scheduler";

// Observation-triggered scheduling stays local; periodic scheduling still covers all scopes.

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW_SECONDS = Math.floor(Date.now() / 1000);

const GROUP_A = { accountId: "10001", kind: "group" as const, peerId: "20001" };
const GROUP_B = { accountId: "10001", kind: "group" as const, peerId: "20002" };

function scopeOf(identity: typeof GROUP_A): QqConversationScope {
  return {
    kind: "qq",
    accountId: identity.accountId,
    conversationKind: identity.kind,
    peerId: identity.peerId,
    agentId: AGENT_ID,
  };
}

function gateway(): ModelGateway {
  return {
    config: { baseUrl: "http://unused.invalid", model: MODEL, timeoutSeconds: 1 },
    listModels: async () => [MODEL],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 32768,
    complete: async () => JSON.stringify({ memory: null }),
    async *streamChat() {
      yield "unused";
    },
  };
}

function setup(options: { qq?: boolean } = {}) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  if (options.qq) {
    const current = readQqSettings(business.orm);
    updateQqSettings(business.orm, {
      enabled: true,
      accountId: "10001",
      expectedRevision: current.revision,
    });
    business.orm
      .insert(schema.qqSchemes)
      .values({
        id: SCHEME_ID,
        name: "方案",
        revision: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
  }
  const scripted = gateway();
  const service = new MemoryService({
    orm: business.orm,
    db: business.db,
    gateway: scripted,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
    jobTimeoutMs: 2_000,
  });
  const modules = createSqliteModules({
    ...business,
    gateway: scripted,
    agentRuntime: createAgentRuntime({
      gateway: scripted,
      repository: new AgentRunRepository(business.db),
    }),
    memoryWorker: service,
  });
  return { business, orm: business.orm, db: business.db, service, modules, gateway: scripted };
}

function insertBinding(
  orm: ReturnType<typeof setup>["orm"],
  id: string,
  identity: typeof GROUP_A,
  memoryBatchSize: number,
  createdAt: string,
) {
  orm
    .insert(schema.qqBindings)
    .values({
      id,
      accountId: identity.accountId,
      conversationKind: identity.kind,
      peerId: identity.peerId,
      agentId: AGENT_ID,
      schemeId: SCHEME_ID,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt,
      updatedAt: createdAt,
    })
    .run();
}

function observeQq(
  orm: ReturnType<typeof setup>["orm"],
  eventKey: string,
  index: number,
  identity: typeof GROUP_A = GROUP_A,
) {
  const observation: QqObservation = {
    accountId: identity.accountId,
    conversation: {
      kind: identity.kind,
      peerId: identity.peerId,
      key: JSON.stringify(["qq", identity.accountId, identity.kind, identity.peerId]),
    },
    eventKey,
    messageId: `-${index}`,
    occurredAtSeconds: NOW_SECONDS + index,
    subType: "normal",
    speaker: { kind: "member", id: "30001", displayName: "群友" },
    segments: [{ kind: "text", text: `消息${index}` }],
    text: `消息${index}`,
    mentionsSelf: false,
  };
  recordObservation(orm, observation, AGENT_ID);
}

function sourceEventIds(orm: ReturnType<typeof setup>["orm"]): string[] {
  const job = orm.select().from(schema.memoryJobs).get();
  return (
    (JSON.parse(job?.configSnapshot ?? "{}") as { source_event_ids?: string[] }).source_event_ids ??
    []
  );
}

function completedTurn(
  orm: ReturnType<typeof setup>["orm"],
  sessionId: string,
  requestKey: string,
): string {
  const prepared = prepareTurn(orm, sessionId, "嗨", requestKey);
  if (prepared.generationToken === null) throw new Error("expected a generation token");
  saveCompletedAssistantMessage(orm, sessionId, "你好", requestKey, prepared.generationToken);
  const turn = getTurnByRequest(orm, sessionId, requestKey);
  if (!turn) throw new Error("expected the turn");
  return turn.id;
}

function configureAuto(orm: ReturnType<typeof setup>["orm"], everyTurns: number): void {
  policy(orm, AGENT_ID);
  orm
    .update(schema.memoryPolicies)
    .set({ autoEnabled: 1, everyTurns })
    .where(eq(schema.memoryPolicies.agentId, AGENT_ID))
    .run();
}

const handles: ReturnType<typeof setup>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.business.close();
});
function track<T extends ReturnType<typeof setup>>(h: T): T {
  handles.push(h);
  return h;
}

describe("observe schedules only its own direction", () => {
  it("a QQ event of A schedules A even when B sorts first in the periodic order", () => {
    const h = track(setup({ qq: true }));
    // B is older, so today's full pass would pick B when A's event is observed.
    insertBinding(h.orm, BINDING_B, GROUP_B, 2, "2026-01-01T00:00:00.000Z");
    insertBinding(h.orm, BINDING_A, GROUP_A, 2, "2026-01-02T00:00:00.000Z");
    observeQq(h.orm, "evt_a0", 0, GROUP_A);
    observeQq(h.orm, "evt_a1", 1, GROUP_A);
    observeQq(h.orm, "evt_b0", 2, GROUP_B);
    observeQq(h.orm, "evt_b1", 3, GROUP_B);
    const recorded = h.orm
      .select({ recordedAt: schema.qqEvents.recordedAt })
      .from(schema.qqEvents)
      .where(eq(schema.qqEvents.eventKey, "evt_a0"))
      .get();
    if (!recorded) throw new Error("expected the event");

    h.modules.memory.observe({
      source: { kind: "qq_event", id: "evt_a0", revision: recorded.recordedAt },
      payload: { kind: "qq_event", eventKey: "evt_a0", agentId: AGENT_ID },
    });

    expect(sourceEventIds(h.orm)).toEqual(["evt_a0", "evt_a1"]);
    expect(pendingObservationCount(h.orm, scopeOf(GROUP_A), nowIso())).toBe(0);
    expect(pendingObservationCount(h.orm, scopeOf(GROUP_B), nowIso())).toBe(2);
  });

  it("the periodic pass still restores every conversation", () => {
    const h = track(setup({ qq: true }));
    insertBinding(h.orm, BINDING_B, GROUP_B, 2, "2026-01-01T00:00:00.000Z");
    insertBinding(h.orm, BINDING_A, GROUP_A, 2, "2026-01-02T00:00:00.000Z");
    observeQq(h.orm, "evt_a0", 0, GROUP_A);
    observeQq(h.orm, "evt_a1", 1, GROUP_A);
    observeQq(h.orm, "evt_b0", 2, GROUP_B);
    observeQq(h.orm, "evt_b1", 3, GROUP_B);
    expect(scheduleQqMemory(h.orm).enqueued).toBe(1);
    expect(sourceEventIds(h.orm)).toEqual(["evt_b0", "evt_b1"]);
    h.orm.update(schema.memoryJobs).set({ status: "failed" }).run();
    expect(scheduleQqMemory(h.orm).enqueued).toBe(1);
    const all = h.orm.select().from(schema.memoryJobs).all();
    const scopes = all.map(
      (job) => (JSON.parse(job.configSnapshot) as { scope_key?: string }).scope_key ?? "",
    );
    expect(scopes.some((scope) => scope.includes("20001"))).toBe(true);
  });

  it("a completed web turn of S schedules S even when another session is older", () => {
    const h = track(setup());
    configureAuto(h.orm, 2);
    const other = createSession(h.orm, "older", { modelName: MODEL }).id;
    const target = createSession(h.orm, "target", { modelName: MODEL }).id;
    // The periodic order is (createdAt, id); pin it so "older" really sorts first.
    h.orm
      .update(schema.sessions)
      .set({ createdAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(schema.sessions.id, other))
      .run();
    h.orm
      .update(schema.sessions)
      .set({ createdAt: "2026-01-02T00:00:00.000Z" })
      .where(eq(schema.sessions.id, target))
      .run();
    completedTurn(h.orm, other, "o1");
    completedTurn(h.orm, other, "o2");
    const first = completedTurn(h.orm, target, "t1");
    completedTurn(h.orm, target, "t2");
    const source = turnSources(h.orm, [first])[0];
    if (!source) throw new Error("expected the turn source");

    h.modules.memory.observe({
      source,
      payload: { kind: "web_turn", turnId: first, agentId: AGENT_ID },
    });

    const job = h.orm.select().from(schema.memoryJobs).get();
    expect(job?.sessionId).toBe(target);
    expect(job?.agentId).toBe(AGENT_ID);
  });

  it("scheduleAuto() still restores every session, and its session argument narrows it", () => {
    const h = track(setup());
    configureAuto(h.orm, 2);
    const older = createSession(h.orm, "older", { modelName: MODEL }).id;
    const newer = createSession(h.orm, "newer", { modelName: MODEL }).id;
    h.orm
      .update(schema.sessions)
      .set({ createdAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(schema.sessions.id, older))
      .run();
    h.orm
      .update(schema.sessions)
      .set({ createdAt: "2026-01-02T00:00:00.000Z" })
      .where(eq(schema.sessions.id, newer))
      .run();
    completedTurn(h.orm, older, "o1");
    completedTurn(h.orm, older, "o2");
    completedTurn(h.orm, newer, "n1");
    completedTurn(h.orm, newer, "n2");

    h.service.scheduleAuto();
    const queuedSessions = () =>
      h.orm
        .select()
        .from(schema.memoryJobs)
        .all()
        .filter((job) => job.status === "queued")
        .map((job) => job.sessionId);
    expect(queuedSessions()).toEqual([older]);
    h.orm.update(schema.memoryJobs).set({ status: "failed" }).run();
    h.service.scheduleAuto(newer);
    expect(queuedSessions()).toEqual([newer]);
  });
});

describe("bounded threshold reads", () => {
  it("keeps the exact pending count and only queues at the configured threshold", () => {
    const h = track(setup({ qq: true }));
    insertBinding(h.orm, BINDING_A, GROUP_A, 3, "2026-01-02T00:00:00.000Z");
    observeQq(h.orm, "evt_a0", 0);
    observeQq(h.orm, "evt_a1", 1);
    expect(pendingObservationCount(h.orm, scopeOf(GROUP_A), nowIso())).toBe(2);
    expect(scheduleQqMemory(h.orm, undefined, scopeOf(GROUP_A))).toEqual({
      due: 0,
      enqueued: 0,
    });
    observeQq(h.orm, "evt_a2", 2);
    expect(scheduleQqMemory(h.orm, undefined, scopeOf(GROUP_A))).toEqual({
      due: 1,
      enqueued: 1,
    });
    expect(sourceEventIds(h.orm)).toEqual(["evt_a0", "evt_a1", "evt_a2"]);
  });

  it("unprocessed turns read is capped at everyTurns while ids/recent stay exact", () => {
    const h = track(setup());
    configureAuto(h.orm, 2);
    const sessionId = createSession(h.orm, "session", { modelName: MODEL }).id;
    const ids = ["r1", "r2", "r3", "r4", "r5"].map((request) =>
      completedTurn(h.orm, sessionId, request),
    );

    const oldest = turns(h.orm, AGENT_ID, sessionId, { unprocessed: true, limit: 2 });
    expect(oldest.map((row) => row.turn.id)).toEqual(ids.slice(0, 2));
    const byIds = turns(h.orm, AGENT_ID, sessionId, { ids, limit: 2 });
    expect(byIds).toHaveLength(5);
    const recent = turns(h.orm, AGENT_ID, sessionId, { recent: 2 });
    expect(recent.map((row) => row.turn.id)).toEqual(ids.slice(3).reverse());

    h.service.scheduleAuto(sessionId);
    const job = h.orm.select().from(schema.memoryJobs).get();
    expect((JSON.parse(job?.turnIds ?? "[]") as string[]).length).toBe(2);
  });
});
