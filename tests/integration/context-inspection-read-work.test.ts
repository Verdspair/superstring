import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import {
  assertContextSources,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import type { ContextReadTimings } from "../../src/server/agent/context-engine";
import { readConcurrentReplyJobs } from "../../src/server/channels/onebot11/concurrent-reply-context";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { readQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { captureQqTask } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const NOW = "2030-06-01T00:00:00.000Z";
const EXPIRY = "2099-01-01T00:00:00.000Z";

const hash = (body: string) => createHash("sha256").update(body).digest("hex");

function setup() {
  const business = openBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, "test-model");
  const repository = new AgentRunRepository(business.db);
  const owner: RunOwner = {
    kind: "fixture",
    id: "fixture",
    userId: DEFAULT_USER_ID,
    agentId: DEFAULT_AGENT_ID,
  };
  const principal = { userId: DEFAULT_USER_ID };
  const snapshot = (sources: SourceRef[], snapshotOwner: RunOwner = owner) => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    repository.createRun({
      runId,
      specId: "test",
      specVersion: "1",
      owner: snapshotOwner,
      at: NOW,
    });
    repository.startStep({
      runId,
      stepId,
      stepNo: 1,
      model: "test-model",
      phase: "leaf",
      at: NOW,
      messages: [{ role: "user", content: [{ kind: "text", text: "private original" }] }],
      sources,
    });
    return { runId, stepId, handle: { runId, stepId } };
  };
  const seedObservation = (eventKey: string, body: string, expiresAt = EXPIRY) => {
    business.db
      .query(
        `INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,
        occurred_at_seconds,speaker_kind,speaker_id,recorded_at,addressed)
        VALUES(?,'100','private','200',?,?,'1','member','200',?,'1')`,
      )
      .run(eventKey, DEFAULT_AGENT_ID, eventKey, NOW);
    business.db
      .query("INSERT INTO qq_observation_text VALUES(?,?,?,?,?)")
      .run(eventKey, body, 1, expiresAt, NOW);
  };
  const seedSpeech = (id: string, body: string) => {
    business.orm
      .insert(schema.qqSpeechLog)
      .values({
        id,
        accountId: "100",
        conversationKind: "private",
        peerId: "200",
        agentId: DEFAULT_AGENT_ID,
        kind: "direct_reply",
        spokeAtSeconds: 1,
        expiresAt: EXPIRY,
        recordedAt: NOW,
      })
      .run();
    business.orm
      .insert(schema.qqSpeechText)
      .values({ speechId: id, body, spokeAtSeconds: 1, expiresAt: EXPIRY, recordedAt: NOW })
      .run();
  };
  /**
   * Counts actual .get/.all executions of the qq_events x qq_observation_text body reads
   * and returns the wrapped call's value (no definite-assignment dance at call sites).
   */
  const countObservationExecutions = <T>(run: () => T): { value: T; executions: number } => {
    let executions = 0;
    const db = business.db as unknown as { query: (sql: string) => unknown };
    const original = db.query;
    const query = original.bind(business.db);
    // 包装 db.query 返回值，不修改缓存语句本身，避免同一语句被重复包装后放大计数。
    db.query = ((sql: string) => {
      const statement = Reflect.apply(query, business.db, [sql]) as object;
      const isBodyRead =
        typeof sql === "string" &&
        sql.includes("FROM qq_events e") &&
        sql.includes("qq_observation_text");
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (isBodyRead && (property === "get" || property === "all")) {
            return (...bindings: unknown[]) => {
              executions += 1;
              return Reflect.apply(value as (...args: unknown[]) => unknown, target, bindings);
            };
          }
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }) as typeof db.query;
    let value: T;
    try {
      value = run();
    } finally {
      db.query = original;
    }
    return { value, executions };
  };
  return {
    business,
    repository,
    owner,
    principal,
    snapshot,
    seedObservation,
    seedSpeech,
    countObservationExecutions,
  };
}

const obsRef = (eventKey: string, body: string, overrides: Partial<SourceRef> = {}): SourceRef => ({
  kind: "qq_observation",
  id: eventKey,
  revision: hash(body),
  expiresAt: EXPIRY,
  ...overrides,
});

describe("context inspection read work (contiguous qq_observation batching)", () => {
  it("resolves 128 contiguous qq_observation refs with at most one body read and identical inspect output", () => {
    const {
      business,
      repository,
      owner,
      principal,
      snapshot,
      seedObservation,
      seedSpeech,
      countObservationExecutions,
    } = setup();
    const bodies = Array.from({ length: 128 }, (_, i) => `body-${i}`);
    bodies.forEach((body, i) => {
      seedObservation(`obs-${i}`, body);
    });
    for (let i = 0; i < 64; i += 1) seedSpeech(`speech-${i}`, `speech-${i}`);
    const obsRefs = bodies.map((body, i) => obsRef(`obs-${i}`, body));
    const speechRefs: SourceRef[] = Array.from({ length: 64 }, (_, i) => ({
      kind: "qq_speech",
      id: `speech-${i}`,
      revision: hash(`speech-${i}`),
      expiresAt: EXPIRY,
    }));
    const refs = [...obsRefs, ...speechRefs];
    const { handle } = snapshot(refs);

    const scalarStates = refs.map((ref) => sourceAccess(business.db, ref, owner, principal, NOW));
    expect(scalarStates).toEqual(Array(refs.length).fill("available"));

    const resolvedIds: string[] = [];
    const stored = repository.getContext(handle);
    if (!stored || !stored.messages) throw new Error("missing snapshot fixture");
    const { value: inspected, executions } = countObservationExecutions(() =>
      inspectContext(business.db, repository, handle, principal, NOW, (source) => {
        resolvedIds.push(source.id);
        return undefined;
      }),
    );
    expect(inspected).toEqual({
      layout: stored.layout,
      sourceVersions: refs.map(({ id, revision }) => ({ id, revision })),
      status: "exact",
      exactMessages: stored.messages,
      result: { status: "unavailable", reason: "pending" },
    });
    // 连续引用共享一次正文读取。
    expect(executions).toBeLessThanOrEqual(1);
    // qq_speech 不批量：每个 speech ref 仍逐条走原 resolveSource ?? sourceAccess 路径。
    expect(resolvedIds).toEqual(speechRefs.map((ref) => ref.id));
  });

  it("does not prefetch past an interleaved resolver that changes the second segment's bodies", () => {
    const {
      business,
      repository,
      owner,
      principal,
      snapshot,
      seedObservation,
      countObservationExecutions,
    } = setup();
    const before = Array.from({ length: 64 }, (_, i) => `before-${i}`);
    before.forEach((body, i) => {
      seedObservation(`pre-${i}`, body);
    });
    before.forEach((_, i) => {
      seedObservation(`post-${i}`, `after-${i}`);
    });
    const beforeRefs = before.map((body, i) => obsRef(`pre-${i}`, body));
    const afterRefs = before.map((_, i) => obsRef(`post-${i}`, `after-${i}`));
    const refs = [
      ...beforeRefs,
      { kind: "external", id: "boundary", revision: "1" } as SourceRef,
      ...afterRefs,
    ];
    const { handle } = snapshot(refs);

    expect(beforeRefs.map((ref) => sourceAccess(business.db, ref, owner, principal, NOW))).toEqual(
      Array(beforeRefs.length).fill("available"),
    );
    expect(afterRefs.map((ref) => sourceAccess(business.db, ref, owner, principal, NOW))).toEqual(
      Array(afterRefs.length).fill("available"),
    );

    let resolverCalls = 0;
    const { value: inspected, executions } = countObservationExecutions(() =>
      inspectContext(business.db, repository, handle, principal, NOW, (source) => {
        if (source.kind !== "external") return undefined;
        resolverCalls += 1;
        // resolver 在两段之间改写第二段正文：批处理不得提前读第二段。
        business.db
          .query("UPDATE qq_observation_text SET body='changed' WHERE event_key LIKE 'post-%'")
          .run();
        return "available";
      }),
    );
    expect(resolverCalls).toBe(1);
    expect(inspected?.status).toBe("revoked");
    expect(inspected?.exactMessages).toBeUndefined();
    // 第一段一次 + 第二段一次，不存在跨 resolver 的第三次提前读取。
    expect(executions).toBeLessThanOrEqual(2);
  });

  it("keeps duplicate ids, malformed ref caps and per-ref expiry precedence identical to scalar sourceAccess", () => {
    const {
      business,
      repository,
      owner,
      principal,
      snapshot,
      seedObservation,
      countObservationExecutions,
    } = setup();
    seedObservation("dup", "shared-body");
    seedObservation("plain", "plain-body");
    const refs: SourceRef[] = [
      obsRef("dup", "shared-body"),
      obsRef("dup", "shared-body"),
      obsRef("dup", "shared-body", { expiresAt: "not-a-timestamp" }),
      obsRef("dup", "shared-body", { expiresAt: "2029-01-01T00:00:00.000Z" }),
      obsRef("plain", "plain-body"),
    ];
    const { handle } = snapshot(refs);
    const scalarStates = refs.map((ref) => sourceAccess(business.db, ref, owner, principal, NOW));
    expect(scalarStates).toEqual(["available", "available", "available", "expired", "available"]);

    const stored = repository.getContext(handle);
    if (!stored) throw new Error("missing snapshot fixture");
    const { value: inspected, executions } = countObservationExecutions(() =>
      inspectContext(business.db, repository, handle, principal, NOW),
    );
    expect(inspected).toEqual({
      layout: stored.layout,
      sourceVersions: refs.map(({ id, revision }) => ({ id, revision })),
      status: "expired",
      result: { status: "expired" },
    });
    expect(executions).toBeLessThanOrEqual(1);
  });

  it("issues no body SQL for an all-cap-expired segment and still batches the valid remainder", () => {
    const {
      business,
      repository,
      owner,
      principal,
      snapshot,
      seedObservation,
      countObservationExecutions,
    } = setup();
    seedObservation("live", "live-body");
    const refs: SourceRef[] = [
      obsRef("missing", "never-seeded", { expiresAt: "2029-01-01T00:00:00.000Z" }),
      obsRef("missing-too", "never-seeded", {
        expiresAt: "not-a-timestamp".replace("not-a-timestamp", "2028-01-01T00:00:00.000Z"),
      }),
    ];
    const { handle } = snapshot([...refs, obsRef("live", "live-body")]);
    expect(refs.map((ref) => sourceAccess(business.db, ref, owner, principal, NOW))).toEqual([
      "expired",
      "expired",
    ]);
    const { value: inspected, executions } = countObservationExecutions(() =>
      inspectContext(business.db, repository, handle, principal, NOW),
    );
    // 头两个 ref 的冻结帽都已过：标量旧路径不读行，批量路径同样不得为它们发起 SQL；
    // 只有 valid 段（同段内未过期 id）允许一次正文读取。
    expect(executions).toBeLessThanOrEqual(1);
    expect(inspected?.status).toBe("expired");
    expect(inspected?.exactMessages).toBeUndefined();
  });

  it("agrees with scalar sourceAccess for a foreign agent owner without widening the read", () => {
    const {
      business,
      repository,
      principal,
      snapshot,
      seedObservation,
      countObservationExecutions,
    } = setup();
    const bodies = Array.from({ length: 128 }, (_, i) => `foreign-${i}`);
    bodies.forEach((body, i) => {
      seedObservation(`foreign-${i}`, body);
    });
    const refs = bodies.map((body, i) => obsRef(`foreign-${i}`, body));
    const foreignOwner: RunOwner = {
      kind: "fixture",
      id: "fixture",
      userId: DEFAULT_USER_ID,
      agentId: "00000000-0000-0000-0000-00000000ffff",
    };
    const { handle } = snapshot(refs, foreignOwner);
    expect(refs.map((ref) => sourceAccess(business.db, ref, foreignOwner, principal, NOW))).toEqual(
      Array(refs.length).fill("revoked"),
    );
    const { value: inspected, executions } = countObservationExecutions(() =>
      inspectContext(business.db, repository, handle, principal, NOW),
    );
    expect(inspected?.status).toBe("revoked");
    expect(inspected?.exactMessages).toBeUndefined();
    expect(executions).toBeLessThanOrEqual(1);
  });
});

let timingPeer = 30000;
function timingSource(
  h: ReturnType<typeof setup>,
  assertCurrent: () => void = () => {},
  capacity = 65536,
) {
  const id = crypto.randomUUID();
  h.business.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES(?,?,?,?)")
    .run(id, id, NOW, NOW);
  h.business.db
    .query(`INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at)
    VALUES(?,'100','private',?,?,?,?,?)`)
    .run(id, String(++timingPeer), DEFAULT_AGENT_ID, id, NOW, NOW);
  const binding = readQqBinding(h.business.orm, id)!;
  const scheme = readQqScheme(h.business.orm, id)!;
  const captured = captureQqTask(binding, "reply");
  if (captured.kind !== "captured") throw new Error("timing binding fixture refused");
  const journal = new ConversationEventRepository(h.business.db);
  const conversation = journal.ensureOneBot(id)!;
  const runtime = runtimeFromAgent(getAgentRow(h.business.orm, DEFAULT_AGENT_ID)!);
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.compression_enabled = false;
  return new BotContextSource({
    ...h.business,
    binding,
    scheme,
    snapshot: captured.snapshot,
    runtime,
    journal,
    outbox: new OutboundIntentRepository(h.business.db),
    conversationId: conversation.id,
    gateway: { loadedContextCapacity: async () => capacity },
    agentRuntime: createAgentRuntime({ repository: h.repository }),
    spec: {
      id: "timing-fixture",
      context: "conversation",
      model: "fixture",
      availableActions: [],
      limits: { steps: 1 },
    },
    path: "direct_reply",
    decisionTier: "reply",
    targets: () => [],
    assertCurrent,
    now: () => NOW,
  });
}

describe("per-read Bot context assertion timings", () => {
  it("counts occurrences and stops collection before the callback and outside read", async () => {
    const h = setup();
    h.seedObservation("timed", "body");
    const source = timingSource(h);
    source.setPendingPlan({ kind: "fixture" }, [obsRef("timed", "body")]);
    let timings: ContextReadTimings | undefined;
    await source.read({
      signal: new AbortController().signal,
      observations: [],
      onReadTimings(value) {
        timings = value;
        source.assertCurrent();
        source.assertSources([]);
      },
    });
    if (!timings) throw new Error("timings missing");
    expect(timings.readAssertCurrentCalls).toBeGreaterThan(0);
    expect(timings.readAssertCommonOccurrences).toBe(timings.readAssertCurrentCalls);
    for (const key of [
      "readAssertCurrentMs",
      "readAssertHostMs",
      "readAssertBudgetMs",
      "readAssertConcurrentMs",
      "readAssertCommonBuildMs",
      "readAssertCommonVerifyMs",
    ] as const)
      expect(timings[key]).toBeGreaterThanOrEqual(0);
    const finished = { ...timings };
    source.assertCurrent();
    source.assertSources([]);
    await source.read({ signal: new AbortController().signal, observations: [] });
    expect(timings).toEqual(finished);
  });

  it("reports failed guards in finally and isolates overlapping source reads", async () => {
    const h = setup();
    const failed = timingSource(h, () => {
      throw new Error("fixture guard failure");
    });
    let failure: ContextReadTimings | undefined;
    await expect(
      failed.read({
        signal: new AbortController().signal,
        observations: [],
        onReadTimings: (value) => {
          failure = value;
        },
      }),
    ).rejects.toThrow("fixture guard failure");
    expect(failure?.readAssertCurrentCalls).toBe(1);
    expect(failure?.readAssertHostMs).toBeGreaterThanOrEqual(0);
    expect(failure?.readAssertCurrentMs).toBeGreaterThanOrEqual(0);
    expect(failure?.readAssertCommonOccurrences).toBeUndefined();
    const left = timingSource(h);
    const right = timingSource(h);
    const results: ContextReadTimings[] = [];
    await Promise.all(
      [left, right].map((source) =>
        source.read({
          signal: new AbortController().signal,
          observations: [],
          onReadTimings: (value) => {
            results.push(value);
          },
        }),
      ),
    );
    expect(results).toHaveLength(2);
    expect(results[0]).not.toBe(results[1]);
    expect(results[0]?.readAssertCurrentCalls).toBe(results[1]?.readAssertCurrentCalls);
    expect(results[0]?.readAssertCommonOccurrences).toBe(0);
    expect(results[1]?.readAssertCommonOccurrences).toBe(0);
  });
});

describe("Bot provenance identity sets", () => {
  it("checks one source identity once after overlapping observation, plan and intent provenance merge", async () => {
    const h = setup();
    const refs = Array.from({ length: 3132 }, (_, index) => {
      const id = `overlap-${index}`;
      const body = `body-${index}`;
      h.seedObservation(id, body);
      return obsRef(id, body);
    });
    const source = timingSource(h, () => {}, 4_000_000);
    source.setPendingPlan({ kind: "prior plan" }, refs);
    source.setBatchIntents({ kind: "accepted intents" }, refs);
    const observations = Array.from({ length: 5 }, (_, index) => ({
      id: `observation-${index}`,
      name: "history.read",
      arguments: {},
      value: { status: "ok", items: [] },
      sources: refs.map((ref) => ({ ...ref })),
    }));
    let timings: ContextReadTimings | undefined;
    await source.read({
      signal: new AbortController().signal,
      observations,
      onReadTimings: (value) => {
        timings = value;
      },
    });
    expect(source.commonSources).toHaveLength(3132);
    expect(timings?.readAssertCommonOccurrences).toBe(
      3132 * (timings?.readAssertCurrentCalls ?? 0),
    );
    const first = h.countObservationExecutions(() => source.assertCurrent());
    expect(first.executions).toBe(1);
    expect(source.commonSources).toHaveLength(3132);
    const next = h.countObservationExecutions(() => source.assertCurrent());
    expect(next.executions).toBe(1);
    // recorded_at is unchanged: every boundary reads current body facts, not a cached proof.
    const recorded = h.business.db
      .query("SELECT recorded_at FROM qq_observation_text WHERE event_key='overlap-0'")
      .get();
    h.business.db
      .query("UPDATE qq_observation_text SET body='changed' WHERE event_key='overlap-0'")
      .run();
    expect(
      h.business.db
        .query("SELECT recorded_at FROM qq_observation_text WHERE event_key='overlap-0'")
        .get(),
    ).toEqual(recorded);
    const changed = h.countObservationExecutions(() => {
      expect(() => source.assertCurrent()).toThrow();
    });
    expect(changed.executions).toBe(1);
  });

  it("keeps interleaved resolver order and rereads observation facts at each boundary", () => {
    const h = setup();
    h.seedObservation("ordered-left", "left");
    h.seedObservation("ordered-right", "right");
    const refs = [
      obsRef("ordered-left", "left"),
      { kind: "remote_document", id: "middle", revision: "1" },
      obsRef("ordered-right", "right"),
    ];
    let valid = true;
    const seen: string[] = [];
    const verify = () =>
      assertContextSources({
        db: h.business.db,
        sources: refs,
        owner: h.owner,
        now: NOW,
        memoryRevisions: () => new Map(),
        resolveSource: (ref) => {
          seen.push(ref.id);
          return valid ? "available" : "revoked";
        },
        messages: { memory: "memory changed", other: "source changed" },
      });
    expect(h.countObservationExecutions(verify).executions).toBe(2);
    expect(seen).toEqual(["middle"]);
    valid = false;
    const revoked = h.countObservationExecutions(() => expect(verify).toThrow("source changed"));
    expect(revoked.executions).toBe(2);
    expect(seen).toEqual(["middle", "middle"]);
    valid = true;
    h.business.db
      .query("UPDATE qq_observation_text SET body='changed' WHERE event_key='ordered-right'")
      .run();
    const changed = h.countObservationExecutions(() => expect(verify).toThrow("source changed"));
    expect(changed.executions).toBe(2);
    expect(seen).toEqual(["middle", "middle", "middle"]);
  });

  it("keeps the earliest expiry cap and treats different revisions as independent identities", () => {
    const h = setup();
    h.seedObservation("cap", "body");
    const source = timingSource(h);
    const later = obsRef("cap", "body");
    const earlier = { ...later, expiresAt: "2031-01-01T00:00:00.000Z" };
    source.setPendingPlan({}, [later]);
    source.setBatchIntents({}, [earlier]);
    expect(source.commonSources).toEqual([earlier]);
    const different = { ...later, revision: hash("different") };
    expect(() => source.setBatchIntents({}, [different])).toThrow();
    const expired = { ...later, expiresAt: "2029-01-01T00:00:00.000Z" };
    expect(() => source.setBatchIntents({}, [expired])).toThrow();
    expect(source.commonSources).toEqual([earlier]);
  });

  it("unions protected provenance from separate concurrent judgement snapshots without losing stricter caps", () => {
    const h = setup();
    h.seedObservation("concurrent-shared", "body");
    const source = timingSource(h);
    const row = h.business.db
      .query("SELECT id,source_id FROM conversations ORDER BY rowid DESC LIMIT 1")
      .get() as {
      id: string;
      source_id: string;
    };
    const late = obsRef("concurrent-shared", "body");
    const early = { ...late, expiresAt: "2031-01-01T00:00:00.000Z" };
    for (const [index, ref] of [late, early].entries()) {
      const wake = `set-wake-${index}`;
      const task = `set-task-${index}`;
      const runId = `set-run-${index}`;
      const stepId = `set-step-${index}`;
      h.business.db
        .query(`INSERT INTO wake_signals(id,conversation_id,cause,through_seq,dedupe_key,ready_at,priority,status,created_at)
        VALUES(?,?,'chiming_in',2,?,?,50,'completed',?)`)
        .run(wake, row.id, wake, NOW, NOW);
      h.business.db
        .query(`INSERT INTO qq_conversation_tasks(id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,
        source_from_seq,source_through_seq,status,judgement_done,origin_wake_id,created_at,updated_at)
        VALUES(?,?,?,1,?,'ordinary','chiming_in',1,2,'pending',1,?,?,?)`)
        .run(task, task, row.id, DEFAULT_AGENT_ID, wake, NOW, NOW);
      h.repository.createRun({
        runId,
        specId: "onebot.initiative.evaluate_batch",
        specVersion: "1",
        owner: {
          kind: "qq_binding",
          id: row.source_id,
          agentId: DEFAULT_AGENT_ID,
          userId: DEFAULT_USER_ID,
        },
        at: NOW,
      });
      h.business.db
        .query("UPDATE agent_runs SET conversation_id=?,wake_id=?,observed_seq=2 WHERE run_id=?")
        .run(row.id, wake, runId);
      h.repository.startStep({
        runId,
        stepId,
        stepNo: 1,
        model: "fixture",
        phase: "leaf",
        at: NOW,
        messages: [
          {
            role: "user",
            content: [
              {
                kind: "text",
                text: JSON.stringify({
                  kind: "qq_batch_targets",
                  trust: "data_only",
                  sourceSeqs: [1, 2],
                  targets: [{ targetId: "member", speakerId: "member", sourceSeqs: [2] }],
                }),
              },
            ],
          },
        ],
        sources: [ref],
      });
      h.repository.finishStep(stepId, "completed", NOW, {
        output: {
          format: "text",
          complete: true,
          text: JSON.stringify({
            evaluations: [{ targetId: "member", score: 8, intent: "synthetic", sourceSeqs: [1] }],
          }),
        },
      });
      h.repository.setStatus(runId, "completed", NOW);
    }
    let checks = 0;
    const projection = readConcurrentReplyJobs(h.business.db, {
      conversationId: row.id,
      bindingEpoch: 1,
      agentId: DEFAULT_AGENT_ID,
      now: NOW,
      visibleEventKeys: new Set(),
      assertSources(refs) {
        checks++;
        source.assertSources(refs);
      },
    });
    expect(checks).toBe(2);
    expect(projection.contexts).toHaveLength(2);
    expect(projection.sources).toEqual([early]);
  });
});
