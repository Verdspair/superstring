import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { inspectContext, sourceAccess } from "../../src/server/agent/context-access";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
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
    // 每个 db.query 返回一个 Proxy 包装（不改动缓存语句本身的方法），命中 body 查询形状
    // 时对 get/all 计数；恢复用原 db.query 引用（Root 实证：改写缓存语句方法会重复包装，
    // 计数被放大 8256）。
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
    // 批量后整段一次正文读取（旧实现逐条 128 次，RED 已由 Root 实证 exit 1）。
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
